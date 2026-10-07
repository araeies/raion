import { z } from 'zod';
import { raionDocument } from './documents.js';

/**
 * JSON Schema (draft 2020-12) for Raion configuration files, describing the *input* format
 * users write. Used by editors (YAML language server) and external CI tooling.
 */
export function toJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(raionDocument, { io: 'input', target: 'draft-2020-12' }),
    title: 'Raion configuration document',
  };
}
