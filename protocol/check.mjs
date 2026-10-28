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

// The tag key a schema uses. The member socket tags with `type`; the sandbox
// RPC wire tags with `t`.
const TAG_KEYS = ['type', 't'];

function variantTag(resolved) {
  for (const key of TAG_KEYS) {
    const tag = resolved.properties?.[key]?.const;
    if (typeof tag === 'string') return tag;
  }
  return null;
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

    // Compile the root def through the whole schema so its internal $refs
    // resolve. Drop $id: one Ajv instance, many root wrappers.
    const { $id: _id, ...body } = schema;
    const validate = ajv.compile({ ...body, $ref: `#/$defs/${root}` });

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

  console.log(
    `protocol: ${schemas.size} schema(s), ${fixtureNames.length} fixture file(s), ` +
      `${seen.size} frame root(s), ${frames} frame(s), coverage complete`,
  );
}

main().catch((err) => fail(err.stack ?? String(err)));
