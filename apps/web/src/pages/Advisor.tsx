import { useState } from 'react';
import { advisorApi, type FindingSeverity, type FindingView, type User } from '../api';
import { ErrorMessage } from '../components';
import { linkHandler } from '../router';
import {
  EmptyState,
  Explain,
  Icon,
  Loading,
  PageHeader,
  Pill,
  Stat,
  Technical,
  type Tone,
} from '../ui';
import { useLoad } from '../useLoad';

const SEVERITY: Record<FindingSeverity, { label: string; tone: Tone; stripe: string }> = {
  critical: { label: 'Important', tone: 'crit', stripe: 'sev-critical' },
  warning: { label: 'Recommended', tone: 'warn', stripe: 'sev-warning' },
  info: { label: 'Suggestion', tone: 'info', stripe: 'sev-pending' },
};

function Diff({ text }: { text: string }) {
  return (
    <pre className="diff" style={{ margin: 0 }}>
      <code>
        {text.split('\n').map((line, i) => (
          <span
            key={i}
            style={
              line.startsWith('+') && !line.startsWith('+++')
                ? { color: '#8be9a8' }
                : line.startsWith('-') && !line.startsWith('---')
                  ? { color: '#ff9b93' }
                  : line.startsWith('@@')
                    ? { color: '#8fb8ff' }
                    : undefined
            }
          >
            {line}
            {'\n'}
          </span>
        ))}
      </code>
    </pre>
  );
}

function FindingCard({
  finding,
  canEdit,
  onApplied,
}: {
  finding: FindingView;
  canEdit: boolean;
  onApplied: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const severity = SEVERITY[finding.severity];
  const apply = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await advisorApi.apply(finding.id);
      onApplied(`${result.summary}: updated ${result.files.join(', ')}.`);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  const headingId = `finding-${finding.id.replace(/[^a-z0-9-]/gi, '-')}`;
  return (
    <li className={`alert-card ${severity.stripe}`} aria-labelledby={headingId}>
      <div className="alert-head">
        <h3 id={headingId}>{finding.title}</h3>
        <Pill tone={severity.tone}>{severity.label}</Pill>
      </div>
      <dl className="facts">
        <dt>Why it matters</dt>
        <dd>{finding.why}</dd>
        <dt>What to do</dt>
        <dd>{finding.fix}</dd>
        {finding.evidence && (
          <>
            <dt>What Raion saw</dt>
            <dd>{finding.evidence}</dd>
          </>
        )}
        {finding.ignored && (
          <>
            <dt>Marked as not relevant</dt>
            <dd>{finding.ignored.reason}</dd>
          </>
        )}
      </dl>
      {finding.autofix && !finding.ignored && (
        <div className="notice notice-accent" style={{ margin: '14px 0 0' }}>
          <div className="spread">
            <span>
              <Icon name="spark" size={16} /> <strong>Raion can do this for you:</strong>{' '}
              {finding.autofix.summary}.
            </span>
            {canEdit ? (
              <button type="button" disabled={pending} onClick={() => void apply()}>
                {pending ? 'Applying…' : 'Fix it for me'}
              </button>
            ) : (
              <span className="small muted">An editor or admin can apply this fix.</span>
            )}
          </div>
          <Technical summary="See the exact change">
            <p className="small muted" style={{ marginTop: 0 }}>
              Only your workspace files change. Deploy afterwards to put it into effect.
            </p>
            {finding.autofix.changes.map((c) => (
              <div key={c.path} style={{ marginBottom: 10 }}>
                <p className="small" style={{ margin: '0 0 4px' }}>
                  <code>{c.path}</code> {c.created ? '(new file)' : '(changed)'}
                </p>
                <Diff text={c.diff} />
              </div>
            ))}
          </Technical>
          <ErrorMessage error={error} />
        </div>
      )}
      <Technical>
        <p className="small" style={{ margin: 0 }}>
          Rule <code>{finding.rule}</code>, subject <code>{finding.subject}</code> (
          {finding.category}). Ignore it in <code>raion.yaml</code> under{' '}
          <code>advisor.ignore</code>.
        </p>
        {finding.query && (
          <>
            <p className="small muted" style={{ margin: '8px 0 4px' }}>
              Query to explore in Grafana:
            </p>
            <pre style={{ margin: 0 }}>
              <code>{finding.query}</code>
            </pre>
          </>
        )}
      </Technical>
    </li>
  );
}

export function AdvisorPage({ user }: { user: User }) {
  const report = useLoad(() => advisorApi.report(), 'advisor', { keepPrevious: true });
  const [applied, setApplied] = useState<string | null>(null);
  const canEdit = user.role !== 'viewer';
  const header = (
    <PageHeader
      title="Advisor"
      description="Raion reviews your monitoring like an experienced SRE would, and tells you what is missing, why it matters and how to fix it."
      actions={
        report.state === 'ready' ? (
          <button type="button" className="secondary" onClick={report.reload}>
            Check again
          </button>
        ) : undefined
      }
    />
  );

  return (
    <>
      {header}
      {applied && (
        <div className="notice notice-ok callout" role="status">
          <Icon name="ok" />
          <div>
            <p style={{ margin: 0 }}>{applied}</p>
            <p style={{ margin: '4px 0 0' }}>
              <a href="/runtime" onClick={linkHandler('/runtime')}>
                Deploy the change
              </a>{' '}
              to put it into effect.
            </p>
          </div>
        </div>
      )}
      {report.state === 'loading' && <Loading label="Reviewing your monitoring…" />}
      {report.state === 'error' && <ErrorMessage error={report.error} />}
      {report.state === 'ready' && (
        <>
          <div className="stats" style={{ marginBottom: 16 }}>
            <Stat label="Important" value={report.data.summary.critical} />
            <Stat label="Recommended" value={report.data.summary.warning} />
            <Stat label="Suggestions" value={report.data.summary.info} />
            <Stat label="Raion can fix" value={report.data.summary.fixable} sub="with one click" />
          </div>
          <p className="small muted">
            {report.data.facts
              ? `Based on your settings and what Raion measured in the last ${report.data.facts.window}.`
              : 'Based on your settings only. Once monitoring runs, Raion also checks traffic, logs, dropped data and dependencies.'}
          </p>
          {report.data.facts && report.data.facts.problems.length > 0 && (
            <p className="small muted">
              Some live data could not be read: {report.data.facts.problems.join('; ')}
            </p>
          )}
          {report.data.findings.filter((f) => !f.ignored).length === 0 ? (
            <EmptyState icon="ok" title="Nothing to improve right now">
              Your monitoring follows good practice. Raion checks again whenever you open this page.
            </EmptyState>
          ) : (
            <ul className="alert-list">
              {report.data.findings
                .filter((f) => !f.ignored)
                .map((f) => (
                  <FindingCard
                    key={f.id}
                    finding={f}
                    canEdit={canEdit}
                    onApplied={(message) => {
                      setApplied(message);
                      report.reload();
                    }}
                  />
                ))}
            </ul>
          )}
          {report.data.summary.ignored > 0 && (
            <Explain summary={`${report.data.summary.ignored} marked as not relevant`}>
              <ul className="alert-list">
                {report.data.findings
                  .filter((f) => f.ignored)
                  .map((f) => (
                    <FindingCard
                      key={f.id}
                      finding={f}
                      canEdit={false}
                      onApplied={() => undefined}
                    />
                  ))}
              </ul>
            </Explain>
          )}
        </>
      )}
    </>
  );
}
