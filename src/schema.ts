// Validation against the JSON Schemas in docs/schemas/ (the contract).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type _Ajv from 'ajv/dist/2020.js';
import type _addFormats from 'ajv-formats';

const dir = fileURLToPath(new URL('../docs/schemas/', import.meta.url));

// Loaded lazily: ajv is many small files, which is slow on WSL's /mnt drives, and the
// commands orchestrators call inside cycles (event, feedback) never validate.
let ajv: InstanceType<typeof _Ajv.default> | null = null;
function load() {
  if (ajv) return ajv;
  const require = createRequire(import.meta.url);
  const Ajv = require('ajv/dist/2020.js') as typeof _Ajv.default;
  const addFormats = require('ajv-formats') as typeof _addFormats.default;
  ajv = new Ajv({ strict: false, allErrors: true, useDefaults: true });
  addFormats(ajv);
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.schema.json')) ajv.addSchema(JSON.parse(fs.readFileSync(dir + f, 'utf8')));
  }
  return ajv;
}

export type SchemaId = 'goal' | 'clock' | 'status' | 'control' | 'registry' | 'event' | 'feedback' | 'activity' | 'cycle-result';

/** Validates (and fills schema defaults into) value. Returns a list of readable errors; empty = valid. */
export function validate(id: SchemaId, value: unknown): string[] {
  const v = load().getSchema(`${id}.schema.json`);
  if (!v) throw new Error(`schema ${id} not found in ${dir}`);
  if (v(value)) return [];
  return (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params && 'allowedValues' in e.params ? `: ${(e.params.allowedValues as unknown[]).join(', ')}` : ''}`);
}
