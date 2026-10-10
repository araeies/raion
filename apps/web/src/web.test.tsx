// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatValue, Sparkline } from './charts';
import { Diagnostics } from './components';
import type { IntegrationView, User } from './api';
import { Markdown } from './markdown';
import { AccountPage } from './pages/Account';
import { AdvisorPage } from './pages/Advisor';
import { AddApplicationPage, slugify } from './pages/AddApplication';
import { AlertsPage } from './pages/Alerts';
import { AuditPage } from './pages/Audit';
import { MyTokens } from './pages/Tokens';
import { example, IntegrationDetailPage, IntegrationsPage } from './pages/Integrations';
import { LoginPage } from './pages/Auth';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Diagnostics', () => {
  it('announces errors with their location and hint', () => {
    render(
      <Diagnostics
        diagnostics={[
          {
            severity: 'error',
            code: 'RAI-E012',
            message: 'unknown service "ledgr-api"',
            hint: 'did you mean "ledger-api"?',
            file: 'services/a.yaml',
            line: 7,
          },
          { severity: 'warning', code: 'RAI-W102', message: 'no owner' },
        ]}
      />,
    );
    expect(screen.getByRole('alert')).toHaveProperty('textContent');
    expect(screen.getByRole('heading').textContent).toBe('The configuration has 1 error');
    expect(screen.getByText('services/a.yaml:7')).toBeDefined();
    expect(screen.getByText('Hint: did you mean "ledger-api"?')).toBeDefined();
  });

  it('renders nothing when there is nothing to report', () => {
    const { container } = render(<Diagnostics diagnostics={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('LoginPage', () => {
  it('sends the CSRF header and shows the server error', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'invalid_credentials', message: 'invalid username or password' },
          }),
          {
            status: 401,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onLogin = vi.fn();
    render(<LoginPage onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('invalid username or password');
    expect(onLogin).not.toHaveBeenCalled();
    const [, init] = (fetchMock.mock.calls as [string, RequestInit][]).find(([url]) =>
      url.endsWith('/auth/login'),
    )!;
    expect((init.headers as Record<string, string>)['x-raion-csrf']).toBe('1');
  });

  const methods = (body: object) =>
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      );

  it('offers single sign-on and keeps where the person was going', async () => {
    vi.stubGlobal('fetch', methods({ password: true, sso: { displayName: 'Contoso' } }));
    window.history.replaceState(null, '', '/login?next=/services/shop');
    render(<LoginPage onLogin={vi.fn()} />);
    const link = await screen.findByRole('link', { name: 'Sign in with Contoso' });
    expect(link.getAttribute('href')).toBe('/api/v1/auth/oidc/start?next=%2Fservices%2Fshop');
    expect(screen.getByLabelText('Password')).toBeDefined();
    window.history.replaceState(null, '', '/');
  });

  it('hides the password form when password sign-in is off, and explains SSO errors', async () => {
    vi.stubGlobal('fetch', methods({ password: false, sso: { displayName: 'Contoso' } }));
    window.history.replaceState(null, '', '/login?sso_error=no_role');
    render(<LoginPage onLogin={vi.fn()} />);
    await screen.findByRole('link', { name: 'Sign in with Contoso' });
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('not in a group that has access');
    window.history.replaceState(null, '', '/');
  });
});

describe('AdvisorPage', () => {
  const report = {
    deployed: true,
    summary: { critical: 0, warning: 1, info: 0, ignored: 1, fixable: 1 },
    facts: { collectedAt: 'now', window: '1h', problems: [] },
    findings: [
      {
        id: 'critical-service-without-slo/pay',
        rule: 'critical-service-without-slo',
        severity: 'warning',
        category: 'slos',
        subject: 'pay',
        title: 'pay is a critical service but has no SLO',
        why: 'why',
        fix: 'fix',
        autofix: {
          summary: 'Create a 99.9% availability SLO',
          changes: [{ path: 'slos/pay-availability.yaml', created: true, diff: '+kind: SLO' }],
        },
      },
      {
        id: 'database-not-monitored/pg',
        rule: 'database-not-monitored',
        severity: 'info',
        category: 'coverage',
        subject: 'pg',
        title: 'PostgreSQL "pg" is not monitored',
        why: 'why',
        fix: 'fix',
        ignored: { reason: 'the DBA team monitors it' },
        autofix: null,
      },
    ],
  };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  it('shows findings, hides fixes from viewers and keeps ignored ones apart', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(report)));
    render(<AdvisorPage user={{ id: 1, username: 'v', role: 'viewer' } as User} />);
    expect(await screen.findByText('pay is a critical service but has no SLO')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Fix it for me' })).toBeNull();
    expect(screen.getByText('An editor or admin can apply this fix.')).toBeDefined();
    expect(screen.getByText('1 marked as not relevant')).toBeDefined();
  });

  it('applies a fix by id only and says what to do next', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(report))
      .mockResolvedValueOnce(
        json({ id: 'x', summary: 'Created the SLO', files: ['slos/pay-availability.yaml'] }),
      )
      .mockResolvedValue(json({ ...report, findings: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AdvisorPage user={{ id: 1, username: 'e', role: 'editor' } as User} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix it for me' }));
    expect(
      (await screen.findByText('Created the SLO: updated slos/pay-availability.yaml.')).textContent,
    ).toBeDefined();
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/v1/advisor/apply');
    expect(init.body).toBe(JSON.stringify({ id: 'critical-service-without-slo/pay' }));
    expect((init.headers as Record<string, string>)['x-raion-csrf']).toBe('1');
  });
});

describe('AccountPage', () => {
  const user = { id: 1, username: 'alice', role: 'editor' } as User;

  it('refuses mismatched passwords before asking the server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<AccountPage user={user} />);
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old-password-123' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password-123' },
    });
    fireEvent.change(screen.getByLabelText('Repeat the new password'), {
      target: { value: 'other' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The new passwords do not match.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('changes the password with the CSRF header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AccountPage user={user} />);
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old-password-123' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password-123' },
    });
    fireEvent.change(screen.getByLabelText('Repeat the new password'), {
      target: { value: 'new-password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect((await screen.findByRole('status')).textContent).toBe('Your password was changed.');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/password');
    expect(init.body).toBe(
      JSON.stringify({ currentPassword: 'old-password-123', newPassword: 'new-password-123' }),
    );
    expect((init.headers as Record<string, string>)['x-raion-csrf']).toBe('1');
  });
});

describe('AuditPage', () => {
  it('lists entries and filters by kind of action', async () => {
    const entries = [
      {
        id: 7,
        ts: '2026-10-07T10:00:00Z',
        actor: 'admin',
        action: 'secret.set',
        target: 'SLACK_WEBHOOK',
        outcome: 'success',
        ip: '127.0.0.1',
        details: null,
      },
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ entries })));
    vi.stubGlobal('fetch', fetchMock);
    render(<AuditPage />);
    expect(await screen.findByText('secret.set')).toBeDefined();
    expect(screen.getByText('SLACK_WEBHOOK')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await screen.findByText('secret.set');
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/v1/audit?limit=100&action=secret');
  });
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

describe('Markdown', () => {
  it('renders documentation as elements, never as HTML', () => {
    const { container } = render(
      <Markdown
        source={
          '## Setup\n\nRun `npm install` **now**.\n\n<script>alert(1)</script>\n\n- [docs](https://example.com)\n- [x](javascript:alert(1))\n\n| A | B |\n| - | - |\n| 1 | 2 |\n'
        }
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.querySelector('h4')!.textContent).toBe('Setup');
    expect(container.querySelector('code')!.textContent).toBe('npm install');
    const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://example.com']);
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });
});

describe('IntegrationsPage', () => {
  const postgresql = {
    name: 'postgresql',
    version: '0.1.0',
    source: 'built-in',
    kind: 'database',
    displayName: 'PostgreSQL',
    description: 'Connections and more.',
    languages: [],
    capabilities: ['database.postgresql'],
    collects: 'pull',
    parameters: [
      {
        name: 'endpoint',
        type: 'string',
        format: 'hostPort',
        required: true,
        description: 'Where',
      },
      { name: 'password', type: 'secret', required: true, description: 'Password' },
      { name: 'tls', type: 'boolean', required: false, default: false, description: 'TLS' },
    ],
    requirements: [{ kind: 'setup', description: 'Create a monitoring user.' }],
    services: ['orders-db'],
    docs: '# PostgreSQL\n\nSee the guide.\n',
  };
  const nodejs = {
    ...postgresql,
    name: 'nodejs',
    displayName: 'Node.js (OpenTelemetry)',
    kind: 'application',
    languages: ['nodejs'],
    capabilities: ['http.server'],
    collects: 'push',
    parameters: [],
    requirements: [],
    services: [],
  };

  it('lists the integrations and how many services use each', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ integrations: [nodejs, postgresql] })));
    render(<IntegrationsPage />);
    expect(await screen.findByText('PostgreSQL')).toBeDefined();
    expect(screen.getByText('Used by 1 service')).toBeDefined();
    expect(screen.getByText('Not used yet')).toBeDefined();
  });

  it('shows how to configure an integration, with its required parameters', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ integrations: [postgresql] })));
    const { container } = render(<IntegrationDetailPage name="postgresql" />);
    await screen.findByText('Connections and more.');
    expect(container.querySelector('pre code')!.textContent).toBe(
      'spec:\n  integrations:\n    - name: postgresql\n      params:\n        endpoint: <host:port>\n        password: ${secret:NAME}',
    );
    expect(screen.getByText('orders-db')).toBeDefined();
    expect(screen.getByText('See the guide.')).toBeDefined();
  });

  it('builds the example from the language for application integrations', () => {
    expect(example(nodejs as IntegrationView)).toBe(
      'spec:\n  language: nodejs   # chooses the nodejs integration',
    );
  });
});

describe('MyTokens', () => {
  it('offers roles up to your own and shows a new token once', async () => {
    const created = {
      token: 'raion_0123456789abcdef_' + 'a'.repeat(43),
      record: { id: '0123456789abcdef', name: 'ci', role: 'viewer' },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ tokens: [] }))
      .mockResolvedValueOnce(json(created))
      .mockResolvedValue(json({ tokens: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MyTokens user={{ id: 1, username: 'erin', role: 'editor' } as User} />);
    await screen.findByText('No tokens.');
    const roles = [...screen.getByLabelText<HTMLSelectElement>('Role').options].map((o) => o.value);
    expect(roles).toEqual(['viewer', 'editor']);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ci' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByText(created.token)).toBeDefined();
    expect(screen.getByText('Copy your new token now.')).toBeDefined();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ name: 'ci', role: 'viewer', expiresInDays: 90 }));
  });
});

describe('AlertsPage', () => {
  const rule = (alert: string, title: string) => ({
    group: 'raion-infrastructure',
    alert,
    severity: 'warning',
    scope: 'infrastructure' as const,
    summary: '',
    description: '',
    expr: 'up == 0',
    title,
    meaning: `${title}: meaning`,
    condition: `${title}: condition`,
    action: [`${title}: first step`],
  });

  it('explains each alert, shows the self-test and what is about to fire', async () => {
    const overview = {
      deployed: true,
      health: { alertmanagerReachable: true, watchdogReceived: true, ok: true, message: 'ok' },
      selfTest: { firing: true, rule: rule('Watchdog', 'Alerting self-test') },
      firing: [
        {
          fingerprint: 'f1',
          alertname: 'HostHighCpu',
          severity: 'critical',
          service: null,
          labels: { alertname: 'HostHighCpu' },
          annotations: { summary: 'CPU has been 95% busy' },
          startsAt: new Date(Date.now() - 3_600_000).toISOString(),
          firstSeen: '',
          lastSeen: '',
          resolvedAt: null,
          state: 'active',
          source: 'alertmanager',
          rule: rule('HostHighCpu', 'The processor is overloaded'),
        },
      ],
      pending: [
        {
          alertname: 'HostMemoryPressure',
          labels: { alertname: 'HostMemoryPressure' },
          activeAt: new Date().toISOString(),
          value: '0.05',
          rule: rule('HostMemoryPressure', 'Memory is running out'),
        },
      ],
      resolved: [],
      rules: [rule('HostHighCpu', 'The processor is overloaded')],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(json(url.includes('silences') ? { silences: [] } : overview)),
      ),
    );
    render(<AlertsPage user={{ id: 1, username: 'v', role: 'viewer' } as User} />);
    expect(await screen.findByText('The processor is overloaded')).toBeDefined();
    expect(screen.getByText('CPU has been 95% busy')).toBeDefined();
    expect(screen.getByText('The processor is overloaded: condition')).toBeDefined();
    expect(screen.getByText('The processor is overloaded: first step')).toBeDefined();
    expect(screen.getByText('Alerting works')).toBeDefined();
    // Viewers cannot silence.
    expect(screen.queryByRole('button', { name: 'Silence…' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /About to fire/ }));
    expect(await screen.findByText('Memory is running out')).toBeDefined();
  });
});

describe('Add an application', () => {
  it('turns a friendly name into a valid name', () => {
    expect(slugify('Payment API')).toBe('payment-api');
    expect(slugify('  42 Shop Front! ')).toBe('shop-front');
    expect(slugify('Ümlaut Café')).toBe('umlaut-cafe');
  });

  it('asks a few questions and sets everything up through the editing API', async () => {
    const saved: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/v1/workspace/edits') {
          saved.push(JSON.parse(init?.body as string));
          return Promise.resolve(json({ summary: 'ok', changes: [], warnings: [] }));
        }
        if (url === '/api/v1/integrations') return Promise.resolve(json({ integrations: [] }));
        if (url === '/api/v1/discovery') return Promise.resolve(json({ containers: [] }));
        if (url === '/api/v1/services')
          return Promise.resolve(json({ services: [], diagnostics: [], valid: true }));
        return Promise.resolve(
          json({
            status: { deployed: { id: '1' } },
            plan: { noChanges: false, securityRelevant: [], dataAffecting: [] },
          }),
        );
      }),
    );
    render(<AddApplicationPage user={{ id: 1, username: 'e', role: 'editor' } as User} />);
    fireEvent.change(await screen.findByLabelText('What is your application called?'), {
      target: { value: 'Payment API' },
    });
    expect(screen.getByText('payment-api')).toBeDefined();
    fireEvent.click(screen.getByRole('radio', { name: /^API/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /^Docker Compose/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /^Python/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText('Raion recommends')).toBeDefined();
    expect(screen.getByText('No change to your application')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Set this up for me/ }));
    expect(await screen.findByText('Payment API is set up')).toBeDefined();
    expect(saved).toEqual([
      {
        action: {
          kind: 'service.add',
          service: {
            name: 'payment-api',
            type: 'api',
            tier: 'standard',
            description: 'Payment API',
            runtime: { type: 'compose' },
            language: 'python',
            integrations: [{ name: 'python', params: { injectAgent: true } }],
            features: { slos: true },
          },
        },
      },
      {
        action: {
          kind: 'slo.add',
          slo: {
            service: 'payment-api',
            name: 'availability',
            sli: { type: 'availability' },
            target: 99.9,
            window: '30d',
          },
        },
      },
    ]);
  });
});

describe('Sparkline', () => {
  const series = {
    key: 'errors' as const,
    label: 'Share failing',
    unit: 'ratio' as const,
    points: [
      [1000, 0.01],
      [1060, 0.02],
      // A gap: nothing arrived for several minutes.
      [1600, 0.005],
    ] as [number, number][],
  };

  it('shows the latest value, breaks the line at gaps and reads moments with the keyboard', () => {
    const { container } = render(
      <Sparkline series={series} from={1000} to={1600} step={60} tone="crit" />,
    );
    expect(screen.getByText('0.50%')).toBeTruthy();
    const line = container.querySelector('.chart-line')!.getAttribute('d')!;
    expect(line.match(/M/g)).toHaveLength(2);
    const chart = screen.getByRole('img');
    expect(chart.getAttribute('aria-label')).toContain('highest 2.0%');
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(screen.getByText(/^0\.50% at /)).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(screen.getByText(/^2\.0% at /)).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(screen.getByText('0.50%')).toBeTruthy();
  });

  it('says so when nothing arrived', () => {
    render(<Sparkline series={{ ...series, points: [] }} from={0} to={60} step={15} />);
    expect(screen.getByText('Nothing arrived in this period.')).toBeTruthy();
    expect(screen.getByText('No data')).toBeTruthy();
  });

  it('formats each unit for people', () => {
    expect(formatValue('seconds', 0.2149)).toBe('215 ms');
    expect(formatValue('seconds', 1.5)).toBe('1.50 s');
    expect(formatValue('perSecond', 4.5)).toBe('4.50/s');
    expect(formatValue('perSecond', 120.4)).toBe('120/s');
    expect(formatValue('ratio', 0.0004)).toBe('0.04%');
  });
});
