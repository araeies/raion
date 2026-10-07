import { useState, type ReactNode, type SyntheticEvent } from 'react';
import type { Diagnostic } from './api';

export function Diagnostics({ diagnostics }: { diagnostics: Diagnostic[] }) {
  if (diagnostics.length === 0) return null;
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  return (
    <section
      className={`notice ${errors ? 'notice-error' : 'notice-warning'}`}
      aria-labelledby="diagnostics-title"
      role={errors ? 'alert' : undefined}
    >
      <h2 id="diagnostics-title">
        {errors
          ? `The configuration has ${errors} error${errors > 1 ? 's' : ''}`
          : `The configuration has ${warnings} warning${warnings > 1 ? 's' : ''}`}
      </h2>
      {errors > 0 && (
        <p>
          Nothing can be deployed until the errors are fixed. Run <code>raion validate</code> for
          the same report.
        </p>
      )}
      <ul className="diagnostics">
        {diagnostics.map((d, i) => (
          <li key={i}>
            <span className={`badge badge-${d.severity}`}>{d.severity}</span> <code>{d.code}</code>{' '}
            {d.file && (
              <code className="location">
                {d.file}
                {d.line ? `:${d.line}` : ''}
              </code>
            )}
            <div>{d.message}</div>
            {d.hint && <div className="hint">Hint: {d.hint}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Progressive disclosure for technical details ("Show configuration"). */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="disclosure">
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="form-error" role="alert">
      {error instanceof Error ? error.message : 'Something went wrong. Please try again.'}
    </p>
  );
}

export function Field(props: {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  required?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        autoComplete={props.autoComplete}
        value={props.value}
        required={props.required ?? true}
        aria-describedby={props.hint ? `${props.id}-hint` : undefined}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && (
        <small id={`${props.id}-hint`} className="hint">
          {props.hint}
        </small>
      )}
    </div>
  );
}

/** Shared submit handling: disables the button while pending and shows errors. */
export function useSubmit(action: () => Promise<void>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    void run();
  };
  return { pending, error, onSubmit };
}
