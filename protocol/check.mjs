#!/usr/bin/env node
// Validate every protocol fixture against its schema, prove fixture
// coverage of every frame variant, compare the schemas with the TypeScript
// declarations, and hold the schemas compatible with the last shipped client
// (the newest `client-v*` tag).
//
// A fixture file is named <schema>.<Root>.json. It holds a JSON array. The
// checker compiles $defs.<Root> from <schema>.schema.json and validates every
// element. The coverage rule requires one fixture for every oneOf variant.

import { execFileSync } from 'node:child_process';
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

// Every loaded schema, by file stem, for cross-file $ref resolution.
const schemasById = new Map();

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

  const schemas = schemasById;
  for (const name of entries.filter((n) => n.endsWith('.schema.json')).sort()) {
    const schemaName = name.slice(0, -'.schema.json'.length);
    const raw = await readFile(join(DIR, name), 'utf8');
    schemas.set(schemaName, JSON.parse(raw));
  }
  if (schemas.size === 0) fail('no *.schema.json files found');

  // Compatibility first: a break against a shipped client is the finding
  // that matters most, and fixtures edited to match it would hide nothing.
  const compat = compatibility(schemas);
  if (compat.problems.length > 0) {
    for (const item of compat.problems) console.error(item);
    fail(`${compat.problems.length} change(s) break a client shipped as ${compat.tag}`);
  }

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
  // type can reach the wire inside another root and have no fixture of its
  // own (a frame's nested row or payload struct).
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

  console.log(`protocol: ${compat.note}`);
  console.log(
    `protocol: ${schemas.size} schema(s), ${fixtureNames.length} fixture file(s), ` +
      `${seen.size} frame root(s), ${frames} frame(s), coverage complete, ` +
      `${typedProperties} property type(s) match TypeScript`,
  );
}

// ---------------------------------------------------------------------------
// TypeScript declarations, read with the compiler's own parser. Each export is
// an object (interface or type literal), a tagged union (one member per wire
// variant), or a string union (an enum).
// ---------------------------------------------------------------------------

// Every type alias by name, so a property typed `Uuid` resolves to `string`.
const aliasNodes = new Map();
let declarationsByName = new Map();

async function loadDeclarations(dir) {
  const out = new Map();
  declarationsByName = out;
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.ts')).sort()) {
    const file = join(dir, name);
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (ts.isTypeAliasDeclaration(statement)) aliasNodes.set(statement.name.text, statement.type);
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
    out.set(name, { optional: member.questionToken !== undefined, type: member.type });
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
      compareProps(`${name}.${tag}`, schema, resolved, tsProps, problems);
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
  compareProps(name, schema, def, declaration.props, problems);
}

function compareProps(name, schema, def, tsProps, problems) {
  const schemaProps = Object.keys(def.properties ?? {});
  const required = new Set(def.required ?? []);
  for (const key of schemaProps) {
    if (!tsProps.has(key)) {
      problems.push(`${name}.${key}: in the schema, missing in TypeScript`);
      continue;
    }
    const tsOptional = tsProps.get(key).optional;
    compareTypes(`${name}.${key}`, schema, def.properties[key], tsProps.get(key).type, problems);
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

// ---------------------------------------------------------------------------
// Scalar type conformance. Each side reduces a property's type to a set of
// categories: string, number, boolean, null, array, object (an inline map or
// struct) and ref (a named object or tagged union). `any` (Json, unknown)
// matches everything. An enum is a string.
// ---------------------------------------------------------------------------

function resolveRef(schema, ref) {
  const [file, pointer] = ref.split('#');
  const owner = file === '' ? schema : [...schemasById.values()].find((s) => s.$id === file);
  const name = pointer?.replace('/$defs/', '');
  return { owner, name, def: owner?.$defs?.[name] };
}

function schemaCategories(schema, prop, depth = 0) {
  const out = new Set();
  if (prop === undefined || depth > 8) return new Set(['any']);
  if (prop.$ref !== undefined) {
    const { owner, def } = resolveRef(schema, prop.$ref);
    if (def === undefined) return new Set(['any']);
    if (def.oneOf !== undefined || def.properties !== undefined) out.add('ref');
    else for (const c of schemaCategories(owner, def, depth + 1)) out.add(c);
  }
  if (typeof prop.const === 'string') out.add('string');
  if (prop.type !== undefined) {
    for (const t of [prop.type].flat()) {
      if (t === 'integer' || t === 'number') out.add('number');
      else out.add(t);
    }
  }
  for (const variant of [...(prop.oneOf ?? []), ...(prop.anyOf ?? [])]) {
    for (const c of schemaCategories(schema, variant, depth + 1)) out.add(c);
  }
  if (out.size === 0) out.add('any');
  return out;
}

function tsCategories(node, depth = 0) {
  const out = new Set();
  if (node === undefined || depth > 8) return new Set(['any']);
  const add = (set) => { for (const c of set) out.add(c); };
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword: out.add('string'); break;
    case ts.SyntaxKind.NumberKeyword: out.add('number'); break;
    case ts.SyntaxKind.BooleanKeyword: out.add('boolean'); break;
    case ts.SyntaxKind.NullKeyword: out.add('null'); break;
    case ts.SyntaxKind.UndefinedKeyword: break;
    case ts.SyntaxKind.UnknownKeyword:
    case ts.SyntaxKind.AnyKeyword: out.add('any'); break;
    case ts.SyntaxKind.ArrayType:
    case ts.SyntaxKind.TupleType: out.add('array'); break;
    case ts.SyntaxKind.TypeLiteral: out.add('object'); break;
    case ts.SyntaxKind.ParenthesizedType: add(tsCategories(node.type, depth + 1)); break;
    case ts.SyntaxKind.UnionType: for (const m of node.types) add(tsCategories(m, depth + 1)); break;
    case ts.SyntaxKind.LiteralType: {
      const lit = node.literal;
      if (lit.kind === ts.SyntaxKind.NullKeyword) out.add('null');
      else if (ts.isStringLiteral(lit)) out.add('string');
      else if (ts.isNumericLiteral(lit)) out.add('number');
      else if (lit.kind === ts.SyntaxKind.TrueKeyword || lit.kind === ts.SyntaxKind.FalseKeyword) out.add('boolean');
      else out.add('any');
      break;
    }
    case ts.SyntaxKind.TypeReference: {
      const name = node.typeName.getText();
      if (name === 'Array' || name === 'ReadonlyArray') out.add('array');
      else if (name === 'Record') out.add('object');
      else {
        const declaration = declarationsByName.get(name);
        if (declaration?.kind === 'strings') out.add('string');
        else if (declaration?.kind === 'object' || declaration?.kind === 'union') out.add('ref');
        else if (aliasNodes.has(name)) add(tsCategories(aliasNodes.get(name), depth + 1));
        else out.add('any');
      }
      break;
    }
    default: out.add('any');
  }
  return out;
}

let typedProperties = 0;

function compareTypes(name, schema, prop, typeNode, problems) {
  const want = schemaCategories(schema, prop);
  const have = tsCategories(typeNode);
  if (want.has('any') || have.has('any')) return;
  typedProperties += 1;
  const a = [...want].sort().join('|');
  const b = [...have].sort().join('|');
  if (a !== b) problems.push(`${name}: TypeScript type is ${b}, the schema is ${a}`);
}

// ---------------------------------------------------------------------------
// Compatibility with the last shipped client. The baseline is the newest
// `client-v*` tag; its `protocol/*.schema.json` is what an installed client
// was built against. Direction decides the rule:
//
//   server -> client  (socket ServerFrame, REST rows and responses): the old
//     client reads it. No variant, property, enum value or definition may
//     disappear, no type may change, and a required property may not become
//     optional.
//   client -> server  (socket ClientFrame, REST *Request bodies): the old
//     client writes it. No property may become required that the old client
//     could omit, no variant or enum value may disappear, no type may change.
//
// rpc.schema.json is skipped: the UI and the engine ship in one binary.
// ---------------------------------------------------------------------------

const COMPAT_SCHEMAS = ['socket', 'rest'];
const TO_CLIENT = 'server->client';
const TO_SERVER = 'client->server';

function runGit(args) {
  return execFileSync('git', args, { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function compatibility(current) {
  let tag;
  try {
    tag = runGit(['tag', '--list', 'client-v*', '--sort=-v:refname'])
      .split('\n')
      .find((t) => t.trim() !== '');
  } catch {
    return { problems: [], note: 'not a git checkout; compatibility check skipped' };
  }
  if (tag === undefined) return { problems: [], note: 'no client-v* tag; compatibility check skipped' };

  const old = new Map();
  for (const name of COMPAT_SCHEMAS) {
    try {
      old.set(name, JSON.parse(runGit(['show', `${tag}:protocol/${name}.schema.json`])));
    } catch {
      // The schema did not exist at the tag: nothing shipped to break.
    }
  }

  const idsOf = (map) => new Map([...map].map(([name, schema]) => [schema.$id, name]));
  const ids = new Map([[old, idsOf(old)], [current, idsOf(current)]]);
  // `file.Def` for a $ref written inside `file`.
  const refKey = (map, file, ref) => {
    const [target, pointer] = ref.split('#');
    const owner = target === '' ? file : ids.get(map).get(target);
    return `${owner}.${(pointer ?? '').replace('/$defs/', '')}`;
  };
  const defOf = (map, key) => {
    const [file, name] = key.split('.');
    return map.get(file)?.$defs?.[name];
  };

  // Directions, computed on the old schemas: what the shipped client knew.
  const reach = (roots) => {
    const out = new Set();
    const stack = [...roots];
    while (stack.length > 0) {
      const key = stack.pop();
      if (out.has(key)) continue;
      const def = defOf(old, key);
      if (def === undefined) continue;
      out.add(key);
      const file = key.split('.')[0];
      JSON.stringify(def, (k, v) => {
        if (k === '$ref' && typeof v === 'string') stack.push(refKey(old, file, v));
        return v;
      });
    }
    return out;
  };
  const restDefs = Object.keys(old.get('rest')?.$defs ?? {});
  const requests = reach(restDefs.filter((n) => n.endsWith('Request')).map((n) => `rest.${n}`));
  const toServer = reach(['socket.ClientFrame', ...requests]);
  const toClient = reach([
    'socket.ServerFrame',
    ...restDefs.map((n) => `rest.${n}`).filter((k) => !requests.has(k)),
  ]);

  const problems = [];
  const report = (dir, where, message) => problems.push(`compat ${dir} ${where}: ${message}`);
  const typeSet = (node) => [node.type ?? []].flat().sort().join('|');

  const compareNode = (dirs, where, oldFile, o, newFile, n) => {
    if (o === undefined || n === undefined) return;
    if (o.$ref !== undefined || n.$ref !== undefined) {
      const same =
        o.$ref !== undefined && n.$ref !== undefined && refKey(old, oldFile, o.$ref) === refKey(current, newFile, n.$ref);
      if (!same) {
        for (const dir of dirs) report(dir, where, `type changed from ${o.$ref ?? typeSet(o)} to ${n.$ref ?? typeSet(n)}`);
      }
      return;
    }
    if (typeSet(o) !== typeSet(n)) {
      for (const dir of dirs) report(dir, where, `type changed from ${typeSet(o) || 'any'} to ${typeSet(n) || 'any'}`);
    }
    if (o.const !== undefined && o.const !== n.const) {
      for (const dir of dirs) report(dir, where, `const changed from ${JSON.stringify(o.const)} to ${JSON.stringify(n.const)}`);
    }
    if (Array.isArray(o.enum) && Array.isArray(n.enum)) {
      const kept = new Set(n.enum);
      for (const v of o.enum.filter((x) => !kept.has(x))) {
        for (const dir of dirs) report(dir, where, `enum value ${JSON.stringify(v)} removed`);
      }
    }
    if (o.items !== undefined) compareNode(dirs, `${where}[]`, oldFile, o.items, newFile, n.items ?? {});
    if (o.properties !== undefined || n.properties !== undefined) compareObject(dirs, where, oldFile, o, newFile, n);
    if (o.oneOf !== undefined) compareUnion(dirs, where, oldFile, o, newFile, n);
  };

  const compareObject = (dirs, where, oldFile, o, newFile, n) => {
    const oldReq = new Set(o.required ?? []);
    const newReq = new Set(n.required ?? []);
    const newProps = n.properties ?? {};
    for (const [key, prop] of Object.entries(o.properties ?? {})) {
      if (!(key in newProps)) {
        if (dirs.includes(TO_CLIENT)) report(TO_CLIENT, `${where}.${key}`, 'property removed');
        continue;
      }
      if (dirs.includes(TO_CLIENT) && oldReq.has(key) && !newReq.has(key)) {
        report(TO_CLIENT, `${where}.${key}`, 'required property became optional');
      }
      compareNode(dirs, `${where}.${key}`, oldFile, prop, newFile, newProps[key]);
    }
    if (dirs.includes(TO_SERVER)) {
      for (const key of newReq) {
        if (!oldReq.has(key)) report(TO_SERVER, `${where}.${key}`, 'property is newly required');
      }
    }
  };

  // A tagged union's variants by their `type` const, or null when untagged.
  const variantsOf = (map, file, node) => {
    const out = new Map();
    for (const variant of node.oneOf ?? []) {
      let resolved = variant;
      let at = file;
      if (variant.$ref !== undefined) {
        const key = refKey(map, file, variant.$ref);
        resolved = defOf(map, key) ?? variant;
        at = key.split('.')[0];
      }
      const t = resolved.properties?.type?.const;
      if (typeof t !== 'string') return null;
      out.set(t, { file: at, node: resolved, named: variant.$ref !== undefined });
    }
    return out;
  };

  const compareUnion = (dirs, where, oldFile, o, newFile, n) => {
    const before = variantsOf(old, oldFile, o);
    const after = variantsOf(current, newFile, n);
    if (before === null || after === null) {
      if (JSON.stringify(o.oneOf) !== JSON.stringify(n.oneOf ?? null)) {
        for (const dir of dirs) report(dir, where, 'untagged union changed');
      }
      return;
    }
    for (const [t, variant] of before) {
      const next = after.get(t);
      if (next === undefined) {
        for (const dir of dirs) report(dir, `${where}.${t}`, 'variant removed');
        continue;
      }
      // A named variant is compared under its own $defs name.
      if (!variant.named || !next.named) {
        compareObject(dirs, `${where}.${t}`, variant.file, variant.node, next.file, next.node);
      }
    }
  };

  let compared = 0;
  for (const key of [...new Set([...toClient, ...toServer])].sort()) {
    const dirs = [];
    if (toClient.has(key)) dirs.push(TO_CLIENT);
    if (toServer.has(key)) dirs.push(TO_SERVER);
    const file = key.split('.')[0];
    const after = defOf(current, key);
    if (after === undefined) {
      for (const dir of dirs) report(dir, key, 'definition removed');
      continue;
    }
    compared += 1;
    compareNode(dirs, key, file, defOf(old, key), file, after);
  }

  return {
    tag,
    problems,
    note: `compatible with ${tag} (${compared} definition(s) compared)`,
  };
}

main().catch((err) => fail(err.stack ?? String(err)));
