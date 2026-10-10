import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { linkHandler } from './router';

// ----- Icons (24×24 strokes) -----------------------------------------------------------------

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  apps: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  spark:
    'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 18l10 5 10-5',
  users:
    'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  scroll:
    'M8 3h11a2 2 0 0 1 2 2v2h-4M8 3a2 2 0 0 0-2 2v14a2 2 0 0 1-2 2h11a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2M9 9h5M9 13h5',
  chart: 'M3 3v18h18M7 14l4-4 3 3 5-6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5 10 17 19 7',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 18l-6-6 6-6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  alert: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  ok: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.5 2.5L16 9.5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  rocket:
    'M5 15c-1 1-1.5 3.5-1.5 5.5C5.5 20.5 8 20 9 19M14 4c3 0 6 3 6 6l-7 7-6-6zM15 9h.01M7 11l-3 1 2 2M13 17l-1 3-2-2',
  code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14',
  key: 'M14 10a5 5 0 1 0-4.8 5H11v2h2v2h3v-3.2l-2-2z',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  globe:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  docker:
    'M3 13h17a1 1 0 0 1 1 1c0 3.9-3.6 7-8 7-5.2 0-9-3.2-10-8zM5 10h3v3H5zM9 10h3v3H9zM13 10h3v3h-3zM9 6h3v3H9z',
  cloud: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.6 10 4 4 0 0 1 18 18z',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  wheel:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 3v6M12 15v6M3.5 7.5l5.2 3M15.3 13.5l5.2 3M3.5 16.5l5.2-3M15.3 10.5l5.2-3',
  question:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

// ----- Page structure --------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  eyebrow,
  back,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: string;
  back?: { href: string; label: string };
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {back && (
          <a className="breadcrumb" href={back.href} onClick={linkHandler(back.href)}>
            <Icon name="back" size={16} /> {back.label}
          </a>
        )}
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  icon = 'spark',
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-art">
        <Icon name={icon} size={24} />
      </span>
      <h3>{title}</h3>
      {children && <div className="muted">{children}</div>}
      {action && <div className="actions">{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="loading" aria-busy="true">
      <span className="spinner" aria-hidden="true" /> {label}
    </p>
  );
}

// ----- Help ------------------------------------------------------------------------------------

/**
 * A small "i" button that explains a term in plain words. Opens on hover or focus, and on
 * click for touch screens; Escape closes it.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);
  return (
    <span
      className="infotip"
      ref={ref}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="infotip-button"
        aria-label={`What is ${label}?`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      {open && (
        <span role="tooltip" id={id} className="infotip-bubble">
          {children}
        </span>
      )}
    </span>
  );
}

/** "What does this mean?": a plain-language explanation, closed by default. */
export function Explain({
  summary = 'What does this mean?',
  children,
  open,
}: {
  summary?: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="explain" open={open}>
      <summary>{summary}</summary>
      <div className="explain-body">{children}</div>
    </details>
  );
}

/** The underlying technical detail, for people who want it. */
export function Technical({
  summary = 'Technical details',
  children,
}: {
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className="technical">
      <summary>{summary}</summary>
      <div className="technical-body">{children}</div>
    </details>
  );
}

// ----- Status ----------------------------------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'crit' | 'info' | 'neutral' | 'accent';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'pill pill-ok',
  warn: 'pill pill-warn',
  crit: 'pill pill-crit',
  info: 'pill pill-info',
  neutral: 'pill',
  accent: 'pill badge-accent',
};

export function Pill({
  tone,
  children,
  live,
}: {
  tone: Tone;
  children: ReactNode;
  live?: boolean;
}) {
  return (
    <span className={TONE_CLASS[tone]}>
      <span className={`dot${live ? ' dot-live' : ''}`} aria-hidden="true" />
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  help,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  help?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-label">
        {label}
        {help && <InfoTip label={label.toLowerCase()}>{help}</InfoTip>}
      </span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

/** "5 minutes ago", "for 2 hours". */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function duration(fromIso: string, toIso?: string | null, now = Date.now()): string {
  const ms = Math.max(0, (toIso ? Date.parse(toIso) : now) - Date.parse(fromIso));
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return `${hours} h${rest ? ` ${rest} min` : ''}`;
  return `${Math.round(hours / 24)} days`;
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
