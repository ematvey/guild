#!/usr/bin/env node
// Validate every protocol fixture against its schema, and prove fixture
// coverage of every frame variant.
//
// A fixture file is named <schema>.<Root>.json. It holds a JSON array. The
// checker compiles $defs.<Root> from <schema>.schema.json and validates every
// element. The coverage rule requires one fixture for every oneOf variant.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import ts from 'typescript';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(DIR, 'fixtures');

function fail(message) {
  console.error(`protocol: ${message}`);
  process.exit(1);
}

// Resolve a variant that is either an inline schema or a $ref into $defs.
function resolveVariant(schema, variant) {
  if (!variant.$ref) return variant;
  const name = variant.$ref.replace('#/$defs/', '');
  return schema.$defs?.[name] ?? variant;
}

// The tag key every frame uses. A frame is an object tagged by `type`, and
// the tag is a `const` in each variant.
function variantTag(resolved) {
  const tag = resolved.properties?.type?.const;
  return typeof tag === 'string' ? tag : null;
}

// The tag values a tagged union declares. A plain struct has no tags, so it
// has no coverage rule: validation alone is the check for those roots.
function variantTypes(schema, root) {
  const rootDef = schema.$defs?.[root];
  if (!rootDef) fail(`schema has no $defs.${root}`);
  const variants = rootDef.oneOf;
  if (variants === undefined) return null;
  const types = [];
  for (const variant of variants) {
    const resolved = resolveVariant(schema, variant);
    const tag = variantTag(resolved);
    if (tag === null) return null;
    types.push(tag);
  }
  return types;
}

async function main() {
  let entries;
  try {
    entries = await readdir(DIR);
  } catch {
    fail(`cannot read ${DIR}`);
  }

  const schemas = new Map();
  for (const name of entries.filter((n) => n.endsWith('.schema.json')).sort()) {
    const schemaName = name.slice(0, -'.schema.json'.length);
    const raw = await readFile(join(DIR, name), 'utf8');
    schemas.set(schemaName, JSON.parse(raw));
  }
  if (schemas.size === 0) fail('no *.schema.json files found');

  let fixtureNames;
  try {
    fixtureNames = (await readdir(FIXTURES)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    fail(`cannot read ${FIXTURES}`);
  }
  if (fixtureNames.length === 0) fail('no fixtures found');

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  // Register every schema under its own `$id`, so a `$ref` can cross files.
  // A socket frame may carry a row type that the REST schema owns; the row is
  // declared once, in REST, and referenced here.
  for (const [schemaName, schema] of schemas) {
    if (typeof schema.$id !== 'string') fail(`${schemaName}.schema.json has no $id`);
    ajv.addSchema(schema);
  }

  let frames = 0;
  const seen = new Map(); // `${schema}.${root}` -> Set of type values
  const roots = new Map(); // schema name -> Set of fixture roots
  const problems = [];

  for (const file of fixtureNames) {
    const match = /^(.+)\.([^.]+)\.json$/.exec(file);
    if (!match) fail(`fixture name is not <schema>.<Root>.json: ${file}`);
    const [, schemaName, root] = match;

    const schema = schemas.get(schemaName);
    if (!schema) fail(`fixture ${file} has no matching ${schemaName}.schema.json`);
    if (!roots.has(schemaName)) roots.set(schemaName, new Set());
    roots.get(schemaName).add(root);

    let framesInFile;
    try {
      framesInFile = JSON.parse(await readFile(join(FIXTURES, file), 'utf8'));
    } catch (err) {
      fail(`${file}: ${err.message}`);
    }
    if (!Array.isArray(framesInFile)) fail(`${file}: top level is not an array`);

    // Compile the root def through the whole schema so its internal and
    // cross-file $refs resolve.
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${root}` });

    framesInFile.forEach((frame, index) => {
      if (!validate(frame)) {
        const details = (validate.errors ?? [])
          .map((e) => {
            const expected =
              e.keyword === 'const' ? ` (expected ${JSON.stringify(e.params?.allowedValue)})` : '';
            return `${e.instancePath || '/'} ${e.message}${expected}`;
          })
          .join('; ');
        problems.push(`${file}[${index}]: ${details}`);
        return;
      }
      frames += 1;
      const key = `${schemaName}.${root}`;
      if (!seen.has(key)) seen.set(key, new Set());
      const tag = typeof frame.type === 'string' ? frame.type : frame.t;
      if (typeof tag === 'string') seen.get(key).add(tag);
    });
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    fail(`${problems.length} fixture frame(s) do not match the schema`);
  }

  // The root is an index for schema viewers: it must list every definition,
  // so a new type cannot be invisible to a reader that opens the file.
  const indexProblems = [];
  for (const [schemaName, schema] of schemas) {
    const listed = Object.keys(schema.properties ?? {}).sort();
    const defined = Object.keys(schema.$defs ?? {}).sort();
    for (const name of defined) {
      if (!listed.includes(name)) indexProblems.push(`${schemaName}: $defs.${name} is not in the root index`);
    }
    for (const name of listed) {
      if (!defined.includes(name)) indexProblems.push(`${schemaName}: root index lists ${name}, which $defs lacks`);
    }
  }
  if (indexProblems.length > 0) {
    for (const item of indexProblems) console.error(item);
    fail(`${indexProblems.length} root index mismatch(es)`);
  }

  // Coverage: every declared variant needs at least one fixture frame.
  const missing = [];
  for (const [schemaName, schemaRoots] of roots) {
    const schema = schemas.get(schemaName);
    for (const root of schemaRoots) {
      const expected = variantTypes(schema, root);
      if (expected === null) continue;
      const actual = seen.get(`${schemaName}.${root}`) ?? new Set();
      for (const type of expected) {
        if (!actual.has(type)) missing.push(`${schemaName}.${root}: ${type}`);
      }
    }
  }

  if (missing.length > 0) {
    for (const item of missing) console.error(`missing fixture: ${item}`);
    fail(`${missing.length} variant(s) have no fixture`);
  }

  // TypeScript conformance: every fixture root must have a declaration in
  // packages/wire, and that declaration must carry the same property names
  // and presence rules as the schema.
  const wireDir = join(DIR, '..', 'packages', 'wire', 'src');
  const declarations = await loadDeclarations(wireDir);
  const typeProblems = [];
  const compared = new Set();
  for (const [schemaName, schemaRoots] of roots) {
    const schema = schemas.get(schemaName);
    for (const root of schemaRoots) {
      compared.add(`${schemaName}.${root}`);
      compareRoot(`${schemaName}.${root}`, schema, schema.$defs?.[root], declarations.get(root), typeProblems);
    }
  }
  // Every named object or union is compared, not only the fixture roots: a
  // union can reach the wire inside another root and have no fixture of its
  // own (StreamEvent rides `live_frame`).
  for (const [schemaName, schema] of schemas) {
    for (const [root, def] of Object.entries(schema.$defs ?? {})) {
      const name = `${schemaName}.${root}`;
      if (compared.has(name)) continue;
      const declaration = declarations.get(root);
      if (declaration === undefined) continue;
      const shaped = def.oneOf !== undefined || def.enum !== undefined || def.properties !== undefined;
      if (!shaped) continue;
      compareRoot(name, schema, def, declaration, typeProblems);
    }
  }
  if (typeProblems.length > 0) {
    for (const item of typeProblems) console.error(item);
    fail(`${typeProblems.length} TypeScript declaration mismatch(es)`);
  }

  console.log(
    `protocol: ${schemas.size} schema(s), ${fixtureNames.length} fixture file(s), ` +
      `${seen.size} frame root(s), ${frames} frame(s), coverage complete`,
  );
}

// ---------------------------------------------------------------------------
// TypeScript declarations, read with the compiler's own parser. Each export is
// an object (interface or type literal), a tagged union (one member per wire
// variant), or a string union (an enum).
// ---------------------------------------------------------------------------

async function loadDeclarations(dir) {
  const out = new Map();
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.ts')).sort()) {
    const file = join(dir, name);
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        out.set(statement.name.text, { kind: 'object', props: propsOf(source, statement.members) });
      } else if (ts.isTypeAliasDeclaration(statement)) {
        const type = statement.type;
        if (ts.isUnionTypeNode(type)) {
          const variants = new Map();
          const strings = [];
          for (const member of type.types) {
            if (ts.isTypeLiteralNode(member)) {
              const tag = tagOf(source, member.members);
              if (tag === null) { variants.clear(); strings.length = 0; break; }
              variants.set(tag, propsOf(source, member.members));
            } else if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
              strings.push(member.literal.text);
            } else {
              variants.clear();
              strings.length = 0;
              break;
            }
          }
          if (variants.size > 0) out.set(statement.name.text, { kind: 'union', variants });
          else if (strings.length > 0) out.set(statement.name.text, { kind: 'strings', values: strings });
          else out.set(statement.name.text, { kind: 'other' });
        } else if (ts.isTypeLiteralNode(type)) {
          out.set(statement.name.text, { kind: 'object', props: propsOf(source, type.members) });
        } else {
          out.set(statement.name.text, { kind: 'other' });
        }
      }
    }
  }
  return out;
}

function propsOf(source, members) {
  const out = new Map();
  for (const member of members) {
    if (!ts.isPropertySignature(member) || member.name === undefined) continue;
    const name = member.name.getText(source).replace(/^['"]|['"]$/g, '');
    out.set(name, member.questionToken !== undefined);
  }
  return out;
}

function tagOf(source, members) {
  for (const member of members) {
    if (!ts.isPropertySignature(member) || member.name?.getText(source) !== 'type') continue;
    if (member.type && ts.isLiteralTypeNode(member.type) && ts.isStringLiteral(member.type.literal)) {
      return member.type.literal.text;
    }
  }
  return null;
}

function compareRoot(name, schema, def, declaration, problems) {
  if (def === undefined) {
    problems.push(`${name}: the schema has no such $defs entry`);
    return;
  }
  if (declaration === undefined) {
    problems.push(`missing TypeScript declaration: ${name}`);
    return;
  }
  if (def.oneOf !== undefined) {
    if (declaration.kind !== 'union') {
      problems.push(`${name}: schema is a union, TypeScript is ${declaration.kind}`);
      return;
    }
    const tags = [];
    for (const variant of def.oneOf) {
      const resolved = resolveVariant(schema, variant);
      const tag = variantTag(resolved);
      if (tag === null) continue;
      tags.push(tag);
      const tsProps = declaration.variants.get(tag);
      if (tsProps === undefined) {
        problems.push(`${name}.${tag}: the schema has this variant, TypeScript does not`);
        continue;
      }
      compareProps(`${name}.${tag}`, resolved, tsProps, problems);
    }
    for (const tag of declaration.variants.keys()) {
      if (!tags.includes(tag)) problems.push(`${name}.${tag}: TypeScript has this variant, the schema does not`);
    }
    return;
  }
  if (def.enum !== undefined) {
    if (declaration.kind !== 'strings') {
      problems.push(`${name}: schema is an enum, TypeScript is ${declaration.kind}`);
      return;
    }
    const tsValues = [...declaration.values].sort().join(',');
    const schemaValues = [...def.enum].sort().join(',');
    if (tsValues !== schemaValues) problems.push(`${name}: TypeScript enum ${tsValues}, schema ${schemaValues}`);
    return;
  }
  if (declaration.kind !== 'object') {
    problems.push(`${name}: schema is an object, TypeScript is ${declaration.kind}`);
    return;
  }
  compareProps(name, def, declaration.props, problems);
}

function compareProps(name, def, tsProps, problems) {
  const schemaProps = Object.keys(def.properties ?? {});
  const required = new Set(def.required ?? []);
  for (const key of schemaProps) {
    if (!tsProps.has(key)) {
      problems.push(`${name}.${key}: in the schema, missing in TypeScript`);
      continue;
    }
    const tsOptional = tsProps.get(key);
    if (required.has(key) === tsOptional) {
      problems.push(
        `${name}.${key}: TypeScript is ${tsOptional ? 'optional' : 'required'}, ` +
          `the schema is ${required.has(key) ? 'required' : 'optional'}`,
      );
    }
  }
  for (const key of tsProps.keys()) {
    if (!schemaProps.includes(key)) problems.push(`${name}.${key}: in TypeScript, missing in the schema`);
  }
}

main().catch((err) => fail(err.stack ?? String(err)));
