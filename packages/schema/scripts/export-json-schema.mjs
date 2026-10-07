// Writes the editor-facing JSON Schema to packages/schema/json/raion.schema.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toJsonSchema } from '../dist/index.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'json');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'raion.schema.json'), `${JSON.stringify(toJsonSchema(), null, 2)}\n`);
console.log('wrote packages/schema/json/raion.schema.json');
