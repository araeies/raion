import { useState } from 'react';
import { advisorApi, type FindingSeverity, type FindingView, type User } from '../api';
import { Disclosure, ErrorMessage } from '../components';
import { linkHandler } from '../router';
import { useLoad } from '../useLoad';

const SEVERITY: Record<FindingSeverity, { label: string; cls: string }> = {
  critical: { label: 'critical', cls: 'badge-error' },
  warning: { label: 'warning', cls: 'badge-warning' },
  info: { label: 'info', cls: '' },
};

function Diff({ text }: { text: string }) {
  return (
    <pre className="diff">
      <code>
        {text.split('\n').map((line, i) => (
          <span
            key={i}
            className={
              line.startsWith('+') && !line.startsWith('+++')
                ? 'diff-add'
                : line.startsWith('-') && !line.startsWith('---')
                  ? 'diff-del'
                  : line.startsWith('@@')
                    ? 'diff-hunk'
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
    <li className="card finding" aria-labelledby={headingId}>
      <h3 id={headingId}>
        <span>{finding.title}</span>
        <span className={`badge ${severity.cls}`}>{severity.label}</span>
      </h3>
      <p className="muted">
        {finding.category} · <code>{finding.id}</code>
      </p>
      <p>
        <strong>Why it matters.</strong> {finding.why}
      </p>
      <p>
        <strong>What to do.</strong> {finding.fix}
      </p>
      {finding.evidence && (
        <p>
          <strong>Details.</strong> {finding.evidence}
        </p>
      )}
      {finding.ignored && (
        <p>
          <strong>Ignored.</strong> {finding.ignored.reason}
        </p>
      )}
      {finding.query && (
        <Disclosure summary="Query to explore in Grafana">
          <pre>
            <code>{finding.query}</code>
          </pre>
        </Disclosure>
      )}
      {finding.autofix && !finding.ignored && (
        <div className="autofix">
          <Disclosure summary={`Raion can do this: ${finding.autofix.summary}`}>
            <p className="muted">
              Only workspace files change. The stack is updated when you plan and apply.
            </p>
            {finding.autofix.changes.map((c) => (
              <div key={c.path}>
                <p>
                  <code>{c.path}</code> {c.created ? '(new file)' : '(changed)'}
                </p>
                <Diff text={c.diff} />
              </div>
            ))}
          </Disclosure>
          {canEdit ? (
            <button type="button" disabled={pending} onClick={() => void apply()}>
              {pending ? 'Applying…' : 'Apply this fix'}
            </button>
          ) : (
            <p className="muted">An editor or admin can apply this fix.</p>
          )}
          <ErrorMessage error={error} />
        </div>
      )}
    </li>
  );
}

export function AdvisorPage({ user }: { user: User }) {
  const report = useLoad(() => advisorApi.report(), 'advisor', { keepPrevious: true });
  const [applied, setApplied] = useState<string | null>(null);
  const canEdit = user.role !== 'viewer';

  return (
    <section aria-labelledby="advisor-title">
      <h1 id="advisor-title">Advisor</h1>
      <p className="lead">
        Gaps in your observability, found from your configuration and, while the stack is running,
        from what it reports. Each finding says why it matters and what to do.
      </p>
      {applied && (
        <div className="notice" role="status">
          <p>{applied}</p>
          <p>
            Review the change, then plan and apply it on the{' '}
            <a href="/runtime" onClick={linkHandler('/runtime')}>
              Observability stack
            </a>{' '}
            page.
          </p>
        </div>
      )}
      {report.state === 'loading' && <p aria-busy="true">Checking…</p>}
      {report.state === 'error' && <ErrorMessage error={report.error} />}
      {report.state === 'ready' && (
        <>
          <p className="muted">
            {report.data.facts
              ? `Based on the configuration and live data from the last ${report.data.facts.window}.`
              : 'Based on the configuration only: the stack is not deployed, so live checks (traffic, log correlation, dropped telemetry, cardinality, observed dependencies) are skipped.'}{' '}
            <button type="button" className="secondary" onClick={report.reload}>
              Check again
            </button>
          </p>
          {report.data.facts && report.data.facts.problems.length > 0 && (
            <p className="muted">
              Some live data could not be read: {report.data.facts.problems.join('; ')}
            </p>
          )}
          <p>
            <strong>{report.data.summary.critical}</strong> critical ·{' '}
            <strong>{report.data.summary.warning}</strong> warnings ·{' '}
            <strong>{report.data.summary.info}</strong> suggestions
            {report.data.summary.fixable > 0 &&
              ` · ${report.data.summary.fixable} Raion can fix for you`}
          </p>
          {report.data.findings.filter((f) => !f.ignored).length === 0 ? (
            <p className="notice">No gaps found.</p>
          ) : (
            <ul className="findings">
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
            <Disclosure
              summary={`${report.data.summary.ignored} ignored (advisor.ignore in raion.yaml)`}
            >
              <ul className="findings">
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
            </Disclosure>
          )}
        </>
      )}
    </section>
  );
}
