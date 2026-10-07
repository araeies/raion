import { useCallback, useEffect, useState } from 'react';

export type Load<T> =
  { state: 'loading' } | { state: 'error'; error: Error } | { state: 'ready'; data: T };

/** Loads data on mount (and when `key` changes). `reload` re-runs the request. */
export function useLoad<T>(
  load: () => Promise<T>,
  key: string,
  options: { keepPrevious?: boolean } = {},
): Load<T> & { reload: () => void } {
  const [nonce, setNonce] = useState(0);
  const id = `${key}#${nonce}`;
  // The result is tagged with the request it belongs to, so a stale result is never shown.
  const [entry, setEntry] = useState<{ id: string; result: Load<T> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => {
        if (!cancelled) setEntry({ id, result: { state: 'ready', data } });
      },
      (error: unknown) => {
        if (!cancelled) {
          setEntry({
            id,
            result: {
              state: 'error',
              error: error instanceof Error ? error : new Error(String(error)),
            },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `id` identifies the request
  }, [id]);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);
  // With keepPrevious, a refresh keeps showing the last result instead of "loading".
  const result: Load<T> =
    entry && (entry.id === id || options.keepPrevious) ? entry.result : { state: 'loading' };
  return { ...result, reload };
}
