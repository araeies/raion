export type Role = 'viewer' | 'editor' | 'admin';

export interface User {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  /** Signs in with single sign-on; the identity provider decides role and password. */
  sso?: boolean;
}

export interface SignInMethods {
  password: boolean;
  sso: { displayName: string } | null;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  hint?: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface ServiceSummary {
  name: string;
  type: string;
  language?: string;
  tier: string;
  team?: string;
  owner?: string;
  level: number;
  sloCount: number;
  dependencyCount: number;
}

export interface Slo {
  name: string;
  description?: string;
  sli:
    | { type: 'availability' }
    | { type: 'latency'; thresholdMs: number }
    | { type: 'custom'; total: string; good?: string; bad?: string };
  target: number;
  window: string;
  errorBudgetRatio: number;
  source: { file: string; line?: number };
}

export interface ServiceDetail {
  service: {
    name: string;
    team?: string;
    owner?: string;
    description?: string;
    environment: string;
    tier: string;
    type: string;
    language?: string;
    repository?: string;
    runtime: { type: string; composeService?: string };
    level: number;
    features: Record<string, boolean>;
    signals: { metrics: boolean; logs: boolean; traces: boolean };
    containerLogs: boolean;
    checks: { url: string; expectStatus?: number[]; interval: string; timeout: string }[];
    alerts: {
      enabled: boolean;
      errorRatePercent: number;
      latencyP95Ms: number;
      for: string;
      missingTelemetry: boolean;
    };
    dependencies: ({ service: string } | { external: { name: string; kind: string } })[];
    slos: Slo[];
    runbooks: { slo?: string; alert?: string; url: string }[];
    source: { file: string; line?: number };
  };
  dependents: string[];
  sources: { path: string; content: string }[];
}

export interface WorkspaceSummary {
  valid: boolean;
  diagnostics: Diagnostic[];
  workspace: {
    name: string;
    description?: string;
    level: number;
    environment: string;
    serviceCount: number;
    infrastructure: { host: boolean; containers: boolean };
    teams: { name: string; route?: string; contacts?: string[] }[];
    receivers: { name: string; type: 'slack' | 'email' | 'webhook' }[];
    defaultReceiver: string | null;
    retention: { metrics: string; logs: string; traces: string };
    publicUrl: string;
    sso: { displayName: string } | null;
  } | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      // Required by the server on every state-changing request (CSRF protection).
      ...(method !== 'GET' ? { 'x-raion-csrf': '1' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as {
    error?: { code: string; message: string };
  };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data.error?.code ?? 'error',
      data.error?.message ?? response.statusText,
    );
  }
  return data as T;
}

export const api = {
  setupStatus: () => call<{ needed: boolean }>('GET', '/api/v1/setup'),
  setup: (token: string, username: string, password: string) =>
    call<{ user: User }>('POST', '/api/v1/setup', { token, username, password }),
  signInMethods: () => call<SignInMethods>('GET', '/api/v1/auth/methods'),
  login: (username: string, password: string) =>
    call<{ user: User }>('POST', '/api/v1/auth/login', { username, password }),
  logout: () => call<undefined>('POST', '/api/v1/auth/logout'),
  me: () => call<{ user: User }>('GET', '/api/v1/auth/me'),
  workspace: () => call<WorkspaceSummary>('GET', '/api/v1/workspace'),
  services: () =>
    call<{ valid: boolean; diagnostics: Diagnostic[]; services: ServiceSummary[] }>(
      'GET',
      '/api/v1/services',
    ),
  service: (name: string) =>
    call<ServiceDetail>('GET', `/api/v1/services/${encodeURIComponent(name)}`),
  users: () => call<{ users: User[] }>('GET', '/api/v1/users'),
  createUser: (username: string, password: string, role: Role) =>
    call<{ user: User }>('POST', '/api/v1/users', { username, password, role }),
  updateUser: (username: string, changes: { role?: Role; disabled?: boolean; password?: string }) =>
    call<{ user: User }>('PATCH', `/api/v1/users/${encodeURIComponent(username)}`, changes),
  changePassword: (currentPassword: string, newPassword: string) =>
    call<undefined>('POST', '/api/v1/auth/password', { currentPassword, newPassword }),
  audit: (query: { before?: number; actor?: string; action?: string }) => {
    const params = new URLSearchParams({ limit: '100' });
    if (query.before) params.set('before', String(query.before));
    if (query.actor) params.set('actor', query.actor);
    if (query.action) params.set('action', query.action);
    return call<{ entries: AuditEntry[] }>('GET', `/api/v1/audit?${params.toString()}`);
  },
};

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string | null;
  action: string;
  target: string | null;
  outcome: 'success' | 'failure';
  ip: string | null;
  details: Record<string, unknown> | null;
}

export interface ComponentStatus {
  component: string;
  state: string;
  ready?: boolean;
  detail?: string;
}

export interface RuntimeOverview {
  status: {
    deployed?: { id: string; createdAt: string; createdBy: string };
    components: ComponentStatus[];
    scrapeTargets?: { job: string; health: string; lastError: string }[];
    healthy: boolean;
  };
  plan: {
    from?: string;
    noChanges: boolean;
    files: {
      path: string;
      change: 'add' | 'modify' | 'remove';
      component: string;
      description: string;
    }[];
    components: { component: string; action: string; reasons: string[] }[];
    securityRelevant: string[];
    hostAccess: string[];
    dataAffecting: string[];
    notes: { severity: 'info' | 'warning'; message: string }[];
  };
  components: { id: string; purpose: string; privileges: string[] }[];
  files: { path: string; component: string; description: string }[];
  releases: { id: string; createdAt: string; createdBy: string }[];
  grafanaUrl: string;
  dashboards: { uid: string; title: string; service?: string; url: string }[];
  otlp: { grpc: string; http: string };
  ingestNetwork: string;
  runningJob: string | null;
  /** What changed in the running stack behind Raion's back. */
  drift: { release?: string; items: { kind: string; subject: string; detail: string }[] };
}

/** A long-running operation on the stack, started from the web UI, the API or the CLI. */
export interface Job {
  id: string;
  kind: 'apply' | 'rollback' | 'repair' | 'destroy' | 'verify' | 'connect';
  via: 'cli' | 'web' | 'api';
  actor: string;
  startedAt: string;
  finishedAt?: string;
  /** "interrupted": its process stopped before it finished. */
  state: 'running' | 'succeeded' | 'failed' | 'interrupted';
  log: string[];
  error?: string;
  result?: unknown;
}

export type JobSummary = Omit<Job, 'log'>;

export const runtimeApi = {
  overview: () => call<RuntimeOverview>('GET', '/api/v1/runtime'),
  file: (path: string) =>
    call<{ path: string; content: string }>(
      'GET',
      `/api/v1/runtime/files/${path.split('/').map(encodeURIComponent).join('/')}`,
    ),
  apply: (approvals: { allowPrivileged: boolean; allowDataChanges: boolean }) =>
    call<{ job: string }>('POST', '/api/v1/runtime/apply', approvals),
  verify: () => call<{ job: string }>('POST', '/api/v1/runtime/verify', {}),
  repair: () => call<{ job: string }>('POST', '/api/v1/runtime/repair', {}),
  rollback: (to?: string) =>
    call<{ job: string }>('POST', '/api/v1/runtime/rollback', to ? { to } : {}),
  stop: (deleteData: boolean, confirm?: string) =>
    call<{ job: string }>('POST', '/api/v1/runtime/stop', {
      deleteData,
      ...(confirm ? { confirm } : {}),
    }),
  job: (id: string) => call<Job>('GET', `/api/v1/runtime/jobs/${encodeURIComponent(id)}`),
  jobs: () => call<{ jobs: JobSummary[] }>('GET', '/api/v1/runtime/jobs'),
};

export interface ServiceTelemetry {
  service: string;
  signals: { signal: 'metrics' | 'logs' | 'traces'; ok: boolean; message: string; query: string }[];
  correlation?: { logsWithTraceId: number; linkedTraceFound: boolean; message: string };
  checks?: {
    url: string;
    up: boolean | null;
    seconds: number | null;
    status: number | null;
    certificateDays: number | null;
  }[];
  red?: {
    requestsPerSecond: number | null;
    errorRatio: number | null;
    p95Seconds: number | null;
    queries: { requestsPerSecond: string; errorRatio: string; p95Seconds: string };
  };
}

export interface ServiceConnection {
  service: string;
  runtime: 'compose' | 'host';
  composeService?: string;
  integration?: { name: string; displayName: string; implicit: boolean };
  supported: boolean;
  env: [string, string][];
  mode?: 'push' | 'pull';
  requirements: {
    kind: 'packages' | 'command' | 'code' | 'setup';
    description: string;
    packages?: string[];
    command?: string;
  }[];
  notes: string[];
}

/** One line of a chart: [unix seconds, value] points. */
export interface HistorySeries {
  key: 'requests' | 'errors' | 'p95' | 'up' | 'answer';
  label: string;
  unit: 'perSecond' | 'ratio' | 'seconds';
  points: [number, number][];
}

export interface ServiceHistory {
  from: number;
  to: number;
  step: number;
  series: HistorySeries[];
}

export const servicesApi = {
  history: (name: string, minutes: 60 | 360 | 1440) =>
    call<{ deployed: boolean; history: ServiceHistory | null }>(
      'GET',
      `/api/v1/services/${encodeURIComponent(name)}/history?minutes=${minutes}`,
    ),
  telemetry: (name: string) =>
    call<{ deployed: boolean; telemetry: ServiceTelemetry | null }>(
      'GET',
      `/api/v1/services/${encodeURIComponent(name)}/telemetry`,
    ),
  connect: (name: string) =>
    call<{ connection: ServiceConnection; override: string | null }>(
      'GET',
      `/api/v1/services/${encodeURIComponent(name)}/connect`,
    ),
};

export interface AlertRecord {
  fingerprint: string;
  alertname: string;
  severity: string | null;
  service: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  firstSeen: string;
  lastSeen: string;
  resolvedAt: string | null;
  state: string;
  /** "prometheus-history": recovered for a time the Raion server was not running. */
  source: 'alertmanager' | 'prometheus-history';
  rule: AlertRule | null;
}

/** An alert rule Raion generated, explained in plain words. */
export interface AlertRule {
  group: string;
  alert: string;
  severity: string;
  scope: 'service' | 'slo' | 'infrastructure' | 'platform';
  service?: string;
  slo?: string;
  for?: string;
  summary: string;
  description: string;
  expr: string;
  title: string;
  meaning: string;
  condition: string;
  action: string[];
}

/** An alert whose condition is true but has not lasted long enough to fire. */
export interface PendingAlert {
  alertname: string;
  labels: Record<string, string>;
  activeAt: string;
  value: string;
  rule: AlertRule | null;
}

export interface AlertsOverview {
  deployed: boolean;
  health: {
    alertmanagerReachable: boolean;
    watchdogReceived: boolean;
    ok: boolean;
    message: string;
  } | null;
  selfTest: { firing: boolean; rule: AlertRule | null };
  firing: AlertRecord[];
  pending: PendingAlert[];
  resolved: AlertRecord[];
  rules: AlertRule[];
}

export interface Silence {
  id: string;
  matchers: { name: string; value: string }[];
  startsAt: string;
  endsAt: string;
  createdBy: string;
  comment: string;
  status: { state: string };
}

export const alertsApi = {
  overview: (service?: string) =>
    call<AlertsOverview>(
      'GET',
      `/api/v1/alerts${service ? `?service=${encodeURIComponent(service)}` : ''}`,
    ),
  silences: () => call<{ silences: Silence[] }>('GET', '/api/v1/alerts/silences'),
  silence: (body: { alertname: string; service?: string; minutes: number; comment: string }) =>
    call<{ id: string }>('POST', '/api/v1/alerts/silences', body),
  unsilence: (id: string) =>
    call<undefined>('DELETE', `/api/v1/alerts/silences/${encodeURIComponent(id)}`),
  secrets: () =>
    call<{
      needed: { key: string; source: 'secret' | 'env'; present: boolean }[];
      stored: string[];
    }>('GET', '/api/v1/secrets'),
  setSecret: (key: string, value: string) =>
    call<undefined>('PUT', `/api/v1/secrets/${encodeURIComponent(key)}`, { value }),
  removeSecret: (key: string) =>
    call<undefined>('DELETE', `/api/v1/secrets/${encodeURIComponent(key)}`),
};

export interface SloStatusView {
  sli: number | null;
  objective: number | null;
  budgetRemaining: number | null;
  burnRate1h: number | null;
  health: 'no-data' | 'healthy' | 'at-risk' | 'exhausted';
  message: string;
}

export interface SloView {
  service: string;
  name: string;
  description: string | null;
  policy: string | null;
  sli: Slo['sli'] | { type: 'throughput'; minRequestsPerSecond: number };
  target: number;
  window: string;
  errorBudgetRatio: number;
  source: { file: string; line?: number };
  evaluated: boolean;
  reason: string | null;
  status: SloStatusView | null;
}

export interface NewSloRequest {
  service: string;
  name: string;
  description?: string;
  policy?: string;
  sli:
    | { type: 'availability' }
    | { type: 'latency'; thresholdMs: number }
    | { type: 'throughput'; minRequestsPerSecond: number };
  target: number;
  window: string;
}

export const sloApi = {
  list: (service?: string) =>
    call<{ deployed: boolean; slos: SloView[] }>(
      'GET',
      `/api/v1/slos${service ? `?service=${encodeURIComponent(service)}` : ''}`,
    ),
  openslo: async () => {
    const res = await fetch('/api/v1/slos/openslo', { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'error', res.statusText);
    return res.text();
  },
  create: (body: NewSloRequest) =>
    call<{ file: string; content: string; warnings: Diagnostic[] }>('POST', '/api/v1/slos', body),
};

export type FindingSeverity = 'critical' | 'warning' | 'info';

export interface FindingView {
  id: string;
  rule: string;
  severity: FindingSeverity;
  category: string;
  subject: string;
  title: string;
  why: string;
  fix: string;
  evidence?: string;
  query?: string;
  docs?: string;
  ignored?: { reason: string };
  autofix: {
    summary: string;
    changes: { path: string; created: boolean; diff: string }[];
  } | null;
}

export interface AdvisorView {
  deployed: boolean;
  summary: Record<FindingSeverity, number> & { ignored: number; fixable: number };
  facts: { collectedAt: string; window: string; problems: string[] } | null;
  findings: FindingView[];
}

export const advisorApi = {
  report: () => call<AdvisorView>('GET', '/api/v1/advisor'),
  apply: (id: string) =>
    call<{ id: string; summary: string; files: string[] }>('POST', '/api/v1/advisor/apply', {
      id,
    }),
};

export interface IntegrationParameterView {
  name: string;
  type: 'boolean' | 'string' | 'secret';
  description: string;
  required: boolean;
  format?: 'hostPort' | 'url' | 'identifier';
  default?: boolean | string;
}

export interface IntegrationView {
  name: string;
  version: string;
  source: 'built-in' | 'workspace';
  kind: string;
  displayName: string;
  description: string;
  languages: string[];
  capabilities: string[];
  collects: 'push' | 'pull';
  parameters: IntegrationParameterView[];
  requirements: { kind: string; description: string; packages?: string[]; manager?: string }[];
  services: string[];
  docs: string;
}

export const integrationsApi = {
  list: () => call<{ integrations: IntegrationView[] }>('GET', '/api/v1/integrations'),
};

export interface ApiTokenView {
  id: string;
  username: string;
  name: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const tokensApi = {
  list: (all = false) =>
    call<{ tokens: ApiTokenView[] }>('GET', `/api/v1/tokens${all ? '?all=true' : ''}`),
  create: (name: string, role: Role, expiresInDays: number) =>
    call<{ token: string; record: ApiTokenView }>('POST', '/api/v1/tokens', {
      name,
      role,
      expiresInDays,
    }),
  revoke: (id: string) => call<undefined>('DELETE', `/api/v1/tokens/${encodeURIComponent(id)}`),
};

/** A change to the workspace files, as the server computed it. */
export interface WorkspaceEditView {
  summary: string;
  changes: { path: string; kind: 'add' | 'modify' | 'remove'; diff: string }[];
  warnings: Diagnostic[];
  written?: string[];
}

/** Edits the workspace files through the same engine as the CLI ("raion services set" etc.). */
export type EditAction =
  | { kind: 'service.add'; service: { name: string; type: string } & Record<string, unknown> }
  | { kind: 'service.update'; name: string; set: Record<string, unknown> }
  | { kind: 'service.remove'; name: string }
  | {
      kind: 'slo.add';
      slo: { service: string; name: string; target: number; window: string } & Record<
        string,
        unknown
      >;
    }
  | { kind: 'slo.update'; service: string; name: string; set: Record<string, unknown> }
  | { kind: 'slo.remove'; service: string; name: string }
  | { kind: 'workspace.update'; set: Record<string, unknown> }
  | { kind: 'receiver.add'; receiver: Record<string, unknown> }
  | { kind: 'receiver.update'; name: string; receiver: Record<string, unknown> }
  | { kind: 'receiver.remove'; name: string }
  | { kind: 'team.add'; team: { name: string } & Record<string, unknown> }
  | { kind: 'team.update'; name: string; set: Record<string, unknown> }
  | { kind: 'team.remove'; name: string };

export const editApi = {
  preview: (action: EditAction) =>
    call<WorkspaceEditView>('POST', '/api/v1/workspace/edits/preview', { action }),
  save: (action: EditAction) =>
    call<WorkspaceEditView>('POST', '/api/v1/workspace/edits', { action }),
};

/** A container running on this machine, as Raion found it. */
export interface DiscoveredContainer {
  container: string;
  image: string;
  state: string;
  compose?: { project: string; service: string; configFiles: string[]; workingDir: string };
  guess: {
    language?: 'nodejs' | 'python' | 'java' | 'go' | 'dotnet' | 'php';
    integration?: 'postgresql' | 'redis' | 'nginx';
  };
  /** The application it already is in Raion, if any. */
  monitoredAs: string | null;
}

/** What "Connect it for me" will do, shown before it does it. */
export interface ConnectRunningPreview {
  service: string;
  project: string;
  workingDir: string;
  configFiles: string[];
  overridePath: string;
  command: string;
  override: string;
  settings: string[];
  agent: string | null;
  logs: boolean;
}

export const discoveryApi = {
  list: () => call<{ containers: DiscoveredContainer[] }>('GET', '/api/v1/discovery'),
  connectPreview: (name: string) =>
    call<ConnectRunningPreview>(
      'GET',
      `/api/v1/services/${encodeURIComponent(name)}/connect-running`,
    ),
  connect: (name: string) =>
    call<{ job: string }>(
      'POST',
      `/api/v1/services/${encodeURIComponent(name)}/connect-running`,
      {},
    ),
};
