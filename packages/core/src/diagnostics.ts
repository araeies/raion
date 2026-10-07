export type Severity = 'error' | 'warning';

/**
 * A validation finding with enough context to fix it: a stable code, a plain-language
 * message, an optional hint, and the location in the user's file.
 */
export interface Diagnostic {
  severity: Severity;
  /** Stable identifier, e.g. RAI-E012. Documented in docs/guides/validation-codes.md. */
  code: string;
  message: string;
  hint?: string;
  /** Workspace-relative path with forward slashes. */
  file?: string;
  line?: number;
  column?: number;
  /** Path inside the YAML document, e.g. ["spec", "slos", 0, "target"]. */
  path?: (string | number)[];
}

export const CODES = {
  YAML_SYNTAX: 'RAI-E001',
  MISSING_WORKSPACE_FILE: 'RAI-E002',
  INVALID_HEADER: 'RAI-E003',
  SCHEMA: 'RAI-E004',
  WORKSPACE_PLACEMENT: 'RAI-E005',
  FILE_LIMIT: 'RAI-E006',
  DUPLICATE_SERVICE: 'RAI-E010',
  UNKNOWN_TEAM: 'RAI-E011',
  UNKNOWN_DEPENDENCY: 'RAI-E012',
  SLO_UNKNOWN_SERVICE: 'RAI-E013',
  DUPLICATE_SLO: 'RAI-E014',
  UNKNOWN_RECEIVER: 'RAI-E015',
  DUPLICATE_NAME: 'RAI-E016',
  ENVIRONMENT_MISMATCH: 'RAI-E017',
  SLO_WITHOUT_METRICS: 'RAI-E018',
  RUNBOOK_UNKNOWN_SLO: 'RAI-E019',
  SELF_DEPENDENCY: 'RAI-E020',
  SLO_FEATURE_DISABLED: 'RAI-W101',
  CRITICAL_WITHOUT_OWNER: 'RAI-W102',
  NO_SERVICES: 'RAI-W103',
  UNKNOWN_INTEGRATION: 'RAI-E021',
  LATENCY_THRESHOLD_NOT_BUCKET: 'RAI-E022',
  INVALID_INTEGRATION_PARAMS: 'RAI-E023',
  SLO_WITHOUT_HTTP_METRICS: 'RAI-W104',
  INTEGRATION_LANGUAGE_MISMATCH: 'RAI-W105',
  RUNBOOK_UNKNOWN_ALERT: 'RAI-W106',
  TEAM_ROUTE_IGNORED: 'RAI-W107',
  CONTAINER_LOGS_NOT_COMPOSE: 'RAI-E024',
  CONTAINER_LOGS_DUPLICATE: 'RAI-W108',
  INTEGRATION_PACKAGE: 'RAI-E025',
  INTEGRATION_NOT_LOCKED: 'RAI-E026',
} as const;

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

export function formatDiagnostic(d: Diagnostic): string {
  const location = d.file
    ? `${d.file}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ''}` : ''}`
    : '';
  const head = `${d.severity === 'error' ? 'error' : 'warning'} ${d.code}${location ? ` ${location}` : ''}`;
  return `${head}\n  ${d.message}${d.hint ? `\n  hint: ${d.hint}` : ''}`;
}
