import { useState } from 'react';
import { ApiError, editApi, type EditAction, type WorkspaceEditView } from './api';
import { linkHandler } from './router';
import { Icon, Technical } from './ui';

/** Saves a change to the workspace through the shared editing engine. */
export function useEdit(onSaved?: (view: WorkspaceEditView) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<WorkspaceEditView | null>(null);
  const save = async (action: EditAction) => {
    setPending(true);
    setError(null);
    setSaved(null);
    try {
      const view = await editApi.save(action);
      setSaved(view);
      onSaved?.(view);
      return view;
    } catch (err) {
      setError(err);
      return null;
    } finally {
      setPending(false);
    }
  };
  return { save, pending, error, saved, reset: () => setSaved(null) };
}

/** "Saved. Deploy to put it into effect", with the exact file change for those who want it. */
export function EditResult({ view }: { view: WorkspaceEditView | null }) {
  if (!view) return null;
  return (
    <div className="notice notice-ok callout" role="status">
      <Icon name="ok" />
      <div style={{ flex: 1 }}>
        <strong>Saved.</strong> {view.summary}.{' '}
        <a href="/runtime" onClick={linkHandler('/runtime')}>
          Deploy the change
        </a>{' '}
        to put it into effect.
        {view.warnings.map((w) => (
          <p key={w.message} className="small" style={{ margin: '6px 0 0' }}>
            Note: {w.message}
          </p>
        ))}
        <Technical summary="See exactly what changed">
          {view.changes.map((c) => (
            <pre key={c.path} style={{ margin: '0 0 8px' }}>
              <code>{c.diff}</code>
            </pre>
          ))}
        </Technical>
      </div>
    </div>
  );
}

/** A refused change, in plain words, with the details behind it. */
export function EditError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'The change could not be saved.';
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <p className="notice notice-error" role="alert" style={{ marginTop: 12 }}>
      {forbidden
        ? 'You do not have permission to make this change. '
        : 'This change was not saved: '}
      {message}
    </p>
  );
}
