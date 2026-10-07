import { z } from 'zod';
import { API_VERSION } from './common.js';
import { serviceDocument } from './service.js';
import { sloDocument } from './slo.js';
import { workspaceDocument } from './workspace.js';

export const KINDS = ['Workspace', 'Service', 'SLO'] as const;
export type Kind = (typeof KINDS)[number];

export const documentSchemas = {
  Workspace: workspaceDocument,
  Service: serviceDocument,
  SLO: sloDocument,
} as const;

/** Any Raion configuration document. Used for the editor-facing JSON Schema. */
export const raionDocument = z.discriminatedUnion('kind', [
  workspaceDocument,
  serviceDocument,
  sloDocument,
]);

/** Minimal header check, used to give precise errors before full validation. */
export const documentHeader = z.object({
  apiVersion: z.literal(API_VERSION, {
    error: `apiVersion must be "${API_VERSION}"`,
  }),
  kind: z.enum(KINDS, { error: `kind must be one of: ${KINDS.join(', ')}` }),
});

export type RaionDocument = z.output<typeof raionDocument>;
