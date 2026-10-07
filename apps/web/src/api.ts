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

export interface Job {
  id: string;
  kind: 'apply' | 'verify' | 'repair';
  startedBy: string;
  startedAt: string;
  state: 'running' | 'succeeded' | 'failed';
  log: string[];
  error?: string;
}

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
  job: (id: string) => call<Job>('GET', `/api/v1/runtime/jobs/${encodeURIComponent(id)}`),
};

export interface ServiceTelemetry {
  service: string;
  signals: { signal: 'metrics' | 'logs' | 'traces'; ok: boolean; message: string; query: string }[];
  correlation?: { logsWithTraceId: number; linkedTraceFound: boolean; message: string };
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

export const servicesApi = {
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
}

export interface AlertsOverview {
  deployed: boolean;
  health: {
    alertmanagerReachable: boolean;
    watchdogReceived: boolean;
    ok: boolean;
    message: string;
  } | null;
  firing: AlertRecord[];
  resolved: AlertRecord[];
  rules: {
    group: string;
    alert: string;
    severity: string;
    service?: string;
    for?: string;
    summary: string;
  }[];
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
