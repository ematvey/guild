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
  if (compat.missing !== undefined) {
    // Without a baseline nothing holds the schemas to what installed clients
    // read. Locally that is a warning; in CI it is a failure.
    const line = '!'.repeat(72);
    console.warn(`${line}\nprotocol: WARNING: ${compat.missing}; the compatibility check did NOT run\n${line}`);
    if (process.env.CI) fail('CI is set and the compatibility baseline is missing');
    compat.note = `compatibility check skipped: ${compat.missing}`;
  }
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

  // A method table (rpc.schema.json `methods`): every entry names its
  // webview exposure and a params and result definition that compiles.
  const methodProblems = [];
  let methods = 0;
  for (const [schemaName, schema] of schemas) {
    for (const [method, entry] of Object.entries(schema.methods ?? {})) {
      if (method === '$comment') continue;
      methods += 1;
      if (typeof entry.webview !== 'boolean') methodProblems.push(`${schemaName}.methods.${method}: webview is not a boolean`);
      for (const part of ['params', 'result']) {
        const ref = entry[part]?.$ref;
        if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) {
          methodProblems.push(`${schemaName}.methods.${method}.${part}: not a #/$defs reference`);
          continue;
        }
        try {
          ajv.compile({ $ref: `${schema.$id}${ref}` });
        } catch (err) {
          methodProblems.push(`${schemaName}.methods.${method}.${part}: ${err.message}`);
        }
      }
    }
  }
  if (methodProblems.length > 0) {
    for (const item of methodProblems) console.error(item);
    fail(`${methodProblems.length} method table problem(s)`);
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
  // own (a frame's nested row or payload struct). A definition without a
  // declaration of the same name fails unless UNDECLARED_DEFS_ALLOW names it;
  // a scalar alias (`Uuid`, `DateTime`) is compared with its TypeScript alias.
  // A named variant of a tagged union that TypeScript declares is compared
  // as that union's member, so it needs no declaration of its own.
  const unionVariants = new Set();
  for (const [schemaName, schema] of schemas) {
    for (const [root, def] of Object.entries(schema.$defs ?? {})) {
      if (def.oneOf === undefined || declarations.get(root)?.kind !== 'union') continue;
      for (const variant of def.oneOf) {
        if (variant.$ref === undefined || variantTag(resolveVariant(schema, variant)) === null) continue;
        const { owner, name } = resolveRef(schema, variant.$ref);
        const ownerName = [...schemas].find(([, s]) => s === owner)?.[0];
        unionVariants.add(`${ownerName}.${name}`);
      }
    }
  }
  for (const [schemaName, schema] of schemas) {
    for (const [root, def] of Object.entries(schema.$defs ?? {})) {
      const name = `${schemaName}.${root}`;
      if (compared.has(name)) continue;
      const declaration = declarations.get(root);
      if (declaration === undefined) {
        if (!UNDECLARED_DEFS_ALLOW.has(name) && !unionVariants.has(name)) {
          typeProblems.push(`missing TypeScript declaration: ${name}`);
        }
        continue;
      }
      const shaped = def.oneOf !== undefined || def.enum !== undefined || def.properties !== undefined;
      if (shaped) compareRoot(name, schema, def, declaration, typeProblems);
      else compareShapes(name, schemaShape(schema, def, name, typeProblems), tsShape(aliasNodes.get(root), name, typeProblems), typeProblems);
    }
  }
  for (const name of UNDECLARED_DEFS_ALLOW.keys()) {
    const [schemaName, root] = name.split('.');
    if (declarations.has(root) || schemas.get(schemaName)?.$defs?.[root] === undefined) {
      typeProblems.push(`UNDECLARED_DEFS_ALLOW lists ${name}, which no longer needs an exception`);
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
      `${typedProperties} property type(s) match TypeScript, ${methods} rpc method(s) resolve`,
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
// Type conformance. Each side reduces a property's type to a shape: a union of
// primitives (string, number, boolean, null), named types (a `$ref` to an
// object, a union or a structured alias on the schema side; a reference to a
// declared interface, union or structured alias on the TypeScript side),
// arrays (with their element shape), inline objects (with their properties,
// compared recursively) and maps (with their value shape). `any` (Json,
// unknown, an empty schema) matches everything. A named enum is a string whose
// name must match when both sides name it.
//
// Named types are compared by name: the schema's `$defs` name against the
// TypeScript type name, through REF_ALIASES where the two names differ.
// ---------------------------------------------------------------------------

// Schema `$defs` name -> TypeScript name, where the TypeScript side calls the
// same type something else.
const REF_ALIASES = new Map([]);

// TypeScript type references that are not declared in packages/wire and are
// read as `any` (name -> reason).
const UNRESOLVED_TS_ALLOW = new Map([]);

// `$defs` entries with no TypeScript declaration of the same name
// (`schema.Def` -> reason).
const UNDECLARED_DEFS_ALLOW = new Map([
  ['rest.DateTime', 'an RFC 3339 timestamp; TypeScript carries it as a plain `string`, and the shape check inlines it as one'],
]);

// Known schema/TypeScript drift the gate tolerates until the two sides are
// reconciled (problem location -> reason). Every entry is a real mismatch.
const KNOWN_DRIFT = new Map([]);

const ANY = Object.freeze({ any: true });

function emptyShape() {
  return { any: false, prims: new Set(), refs: new Set(), enums: new Set(), arrays: [], objects: [], maps: [] };
}

// Fold `shape` into `into`; false when `shape` is `any` (the union is then any).
function merge(into, shape) {
  if (shape.any) return false;
  for (const p of shape.prims) into.prims.add(p);
  for (const r of shape.refs) into.refs.add(r);
  for (const e of shape.enums) into.enums.add(e);
  into.arrays.push(...shape.arrays);
  into.objects.push(...shape.objects);
  into.maps.push(...shape.maps);
  return true;
}

function primOf(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'any';
}

// A named type whose shape is only primitives is inlined where it is
// referenced: `Uuid` is a string on both sides, whatever either side calls it.
function onlyPrims(shape) {
  return (
    !shape.any &&
    shape.refs.size === 0 &&
    shape.arrays.length === 0 &&
    shape.objects.length === 0 &&
    shape.maps.length === 0
  );
}

function resolveRef(schema, ref) {
  const [file, pointer] = ref.split('#');
  const owner = file === '' ? schema : [...schemasById.values()].find((s) => s.$id === file);
  const name = pointer?.replace('/$defs/', '');
  return { owner, name, def: owner?.$defs?.[name] };
}

function schemaShape(schema, prop, where, problems, depth = 0) {
  if (prop === undefined || prop === true || depth > 16) return ANY;
  const out = emptyShape();
  let constrained = false;
  if (prop.$ref !== undefined) {
    constrained = true;
    const { owner, name, def } = resolveRef(schema, prop.$ref);
    if (def === undefined) {
      problems.push(`${where}: unresolved $ref ${prop.$ref}`);
      return ANY;
    }
    if (def.oneOf !== undefined || def.properties !== undefined) out.refs.add(name);
    else if (def.enum !== undefined) {
      out.enums.add(name);
      for (const v of def.enum) out.prims.add(primOf(v));
    } else {
      const inner = schemaShape(owner, def, where, problems, depth + 1);
      if (inner.any) return ANY;
      if (onlyPrims(inner)) merge(out, inner);
      else out.refs.add(name);
    }
  }
  if (prop.const !== undefined) {
    constrained = true;
    out.prims.add(primOf(prop.const));
  }
  if (Array.isArray(prop.enum)) {
    constrained = true;
    for (const v of prop.enum) out.prims.add(primOf(v));
  }
  if (prop.type !== undefined) {
    constrained = true;
    for (const t of [prop.type].flat()) {
      if (t === 'integer' || t === 'number') out.prims.add('number');
      else if (t === 'array') out.arrays.push(schemaShape(schema, prop.items, `${where}[]`, problems, depth + 1));
      else if (t === 'object') {
        if (prop.properties !== undefined) out.objects.push({ schema, def: prop });
        else if (typeof prop.additionalProperties === 'object') {
          out.maps.push(schemaShape(schema, prop.additionalProperties, `${where}{}`, problems, depth + 1));
        } else out.maps.push(ANY);
      } else out.prims.add(t);
    }
  }
  const variants = [...(prop.oneOf ?? []), ...(prop.anyOf ?? [])];
  if (variants.length > 0) {
    constrained = true;
    for (const variant of variants) {
      if (!merge(out, schemaShape(schema, variant, where, problems, depth + 1))) return ANY;
    }
  }
  if (out.prims.has('any')) return ANY;
  return constrained ? out : ANY;
}

function tsShape(node, where, problems, depth = 0) {
  if (node === undefined || depth > 16) return ANY;
  const out = emptyShape();
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword: out.prims.add('string'); return out;
    case ts.SyntaxKind.NumberKeyword: out.prims.add('number'); return out;
    case ts.SyntaxKind.BooleanKeyword: out.prims.add('boolean'); return out;
    case ts.SyntaxKind.NullKeyword: out.prims.add('null'); return out;
    case ts.SyntaxKind.UndefinedKeyword: return out;
    case ts.SyntaxKind.UnknownKeyword:
    case ts.SyntaxKind.AnyKeyword: return ANY;
    case ts.SyntaxKind.ArrayType:
      out.arrays.push(tsShape(node.elementType, `${where}[]`, problems, depth + 1));
      return out;
    case ts.SyntaxKind.TupleType:
      out.arrays.push(ANY);
      return out;
    case ts.SyntaxKind.TypeLiteral: {
      const index = node.members.find((m) => ts.isIndexSignatureDeclaration(m));
      if (index !== undefined && node.members.length === 1) {
        out.maps.push(tsShape(index.type, `${where}{}`, problems, depth + 1));
      } else out.objects.push({ props: propsOf(node.getSourceFile(), node.members) });
      return out;
    }
    case ts.SyntaxKind.ParenthesizedType: return tsShape(node.type, where, problems, depth + 1);
    case ts.SyntaxKind.UnionType:
      for (const m of node.types) if (!merge(out, tsShape(m, where, problems, depth + 1))) return ANY;
      return out;
    case ts.SyntaxKind.LiteralType: {
      const lit = node.literal;
      if (lit.kind === ts.SyntaxKind.NullKeyword) out.prims.add('null');
      else if (ts.isStringLiteral(lit)) out.prims.add('string');
      else if (ts.isNumericLiteral(lit)) out.prims.add('number');
      else if (lit.kind === ts.SyntaxKind.TrueKeyword || lit.kind === ts.SyntaxKind.FalseKeyword) out.prims.add('boolean');
      else return ANY;
      return out;
    }
    case ts.SyntaxKind.TypeReference: {
      const name = node.typeName.getText();
      const args = node.typeArguments ?? [];
      if (name === 'Array' || name === 'ReadonlyArray') {
        out.arrays.push(tsShape(args[0], `${where}[]`, problems, depth + 1));
        return out;
      }
      if (name === 'Record') {
        out.maps.push(tsShape(args[1], `${where}{}`, problems, depth + 1));
        return out;
      }
      const declaration = declarationsByName.get(name);
      if (declaration?.kind === 'strings') {
        out.enums.add(name);
        out.prims.add('string');
        return out;
      }
      if (declaration?.kind === 'object' || declaration?.kind === 'union') {
        out.refs.add(name);
        return out;
      }
      if (aliasNodes.has(name)) {
        const inner = tsShape(aliasNodes.get(name), where, problems, depth + 1);
        if (inner.any || onlyPrims(inner)) return inner;
        out.refs.add(name);
        return out;
      }
      if (!UNRESOLVED_TS_ALLOW.has(name)) {
        problems.push(`${where}: TypeScript type ${name} is not declared in packages/wire`);
      }
      return ANY;
    }
    default:
      problems.push(`${where}: unsupported TypeScript type node ${ts.SyntaxKind[node.kind]}`);
      return ANY;
  }
}

function describe(shape) {
  if (shape.any) return 'any';
  const parts = [...shape.prims].sort();
  for (const e of [...shape.enums].sort()) parts.push(`enum ${e}`);
  for (const r of [...shape.refs].sort()) parts.push(r);
  for (const a of shape.arrays) parts.push(`${describe(a)}[]`);
  for (const _ of shape.objects) parts.push('{…}');
  for (const m of shape.maps) parts.push(`map<${describe(m)}>`);
  return parts.join(' | ') || 'never';
}

let typedProperties = 0;

// Compare a schema shape with a TypeScript shape; one problem per mismatch.
function compareShapes(where, want, have, problems) {
  if (want.any || have.any) return;
  typedProperties += 1;
  const report = (message) => {
    if (!KNOWN_DRIFT.has(where)) problems.push(`${where}: ${message}`);
  };
  const types = `TypeScript type is ${describe(have)}, the schema is ${describe(want)}`;
  const prims = (s) => [...s.prims].sort().join('|');
  if (prims(want) !== prims(have)) return report(types);
  if (want.enums.size > 0 && have.enums.size > 0) {
    const named = [...want.enums].map((n) => REF_ALIASES.get(n) ?? n).sort().join('|');
    const tsNamed = [...have.enums].sort().join('|');
    if (named !== tsNamed) report(`TypeScript enum is ${tsNamed}, the schema is ${named}`);
  }
  const refs = [...want.refs].map((n) => REF_ALIASES.get(n) ?? n).sort().join('|');
  const tsRefs = [...have.refs].sort().join('|');
  if (refs !== tsRefs) return report(types);
  if (want.arrays.length !== have.arrays.length) return report(types);
  if (want.maps.length !== have.maps.length) return report(types);
  if (want.objects.length !== have.objects.length) return report(types);
  if (want.arrays.length === 1) compareShapes(`${where}[]`, want.arrays[0], have.arrays[0], problems);
  if (want.maps.length === 1) compareShapes(`${where}{}`, want.maps[0], have.maps[0], problems);
  if (want.objects.length === 1) {
    const { schema, def } = want.objects[0];
    compareProps(where, schema, def, have.objects[0].props, problems);
  }
}

function compareTypes(name, schema, prop, typeNode, problems) {
  compareShapes(name, schemaShape(schema, prop, name, problems), tsShape(typeNode, name, problems), problems);
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
    return { problems: [], missing: 'not a git checkout' };
  }
  if (tag === undefined) {
    let shallow = false;
    try {
      shallow = runGit(['rev-parse', '--is-shallow-repository']).trim() === 'true';
    } catch {
      // Not answerable; the plain message stands.
    }
    return {
      problems: [],
      missing: shallow
        ? 'no client-v* tag in this shallow clone (git fetch --unshallow --tags)'
        : 'no client-v* tag (git fetch --tags)',
    };
  }

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
