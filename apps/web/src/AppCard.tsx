import type { AlertRecord, ServiceSummary } from './api';
import { linkHandler } from './router';
import { Icon, Pill, type IconName } from './ui';

const TYPE_ICON: Record<string, IconName> = {
  api: 'code',
  web: 'globe',
  worker: 'settings',
  database: 'server',
  microservice: 'box',
  infrastructure: 'layers',
};

const TYPE_LABEL: Record<string, string> = {
  api: 'API',
  web: 'Web application',
  worker: 'Background worker',
  database: 'Database',
  microservice: 'Microservice',
  infrastructure: 'Infrastructure',
};

const LANGUAGE_LABEL: Record<string, string> = {
  nodejs: 'Node.js',
  python: 'Python',
  go: 'Go',
  java: 'Java',
  dotnet: '.NET',
  php: 'PHP',
  other: 'Other',
};

export const typeIcon = (type: string): IconName => TYPE_ICON[type] ?? 'box';
export const typeLabel = (type: string): string => TYPE_LABEL[type] ?? type;
export const languageLabel = (language?: string | null): string | undefined =>
  language ? (LANGUAGE_LABEL[language] ?? language) : undefined;

/** An application at a glance: what it is, and whether it needs attention. */
export function AppCard({
  service,
  firing,
}: {
  service: ServiceSummary;
  /** Alerts firing for this application now. */
  firing: AlertRecord[];
}) {
  const urgent = firing.some((a) => a.severity === 'critical');
  const href = `/services/${service.name}`;
  return (
    <a className="card card-link app-card" href={href} onClick={linkHandler(href)}>
      <div className="app-card-head">
        <span className={`app-icon${firing.length ? ' tone-crit' : ''}`} aria-hidden="true">
          <Icon name={typeIcon(service.type)} size={20} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <strong>{service.name}</strong>
          <span className="small muted">
            {[typeLabel(service.type), languageLabel(service.language), service.team]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      </div>
      <div className="app-card-foot">
        {firing.length > 0 ? (
          <Pill tone={urgent ? 'crit' : 'warn'} live>
            {firing.length} alert{firing.length === 1 ? '' : 's'}
          </Pill>
        ) : (
          <Pill tone="ok">No alerts</Pill>
        )}
        {service.tier === 'critical' && <span className="pill">Critical</span>}
        <span className="pill">
          {service.sloCount} goal{service.sloCount === 1 ? '' : 's'}
        </span>
      </div>
    </a>
  );
}
