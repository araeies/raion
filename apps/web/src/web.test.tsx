// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Diagnostics } from './components';
import type { User } from './api';
import { AdvisorPage } from './pages/Advisor';
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
    const fetchMock = vi.fn().mockResolvedValue(
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
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-raion-csrf']).toBe('1');
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
    expect(screen.queryByRole('button', { name: 'Apply this fix' })).toBeNull();
    expect(screen.getByText('An editor or admin can apply this fix.')).toBeDefined();
    expect(screen.getByText('1 ignored (advisor.ignore in raion.yaml)')).toBeDefined();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Apply this fix' }));
    expect(
      (await screen.findByText('Created the SLO: updated slos/pay-availability.yaml.')).textContent,
    ).toBeDefined();
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/v1/advisor/apply');
    expect(init.body).toBe(JSON.stringify({ id: 'critical-service-without-slo/pay' }));
    expect((init.headers as Record<string, string>)['x-raion-csrf']).toBe('1');
  });
});
