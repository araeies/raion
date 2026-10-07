/**
 * A small typed builder for Grafana dashboards (classic JSON model, provisioned from files).
 * Only what Raion's generators need; every panel records whether it is expected to return
 * data so `raion verify --dashboards` can check generated dashboards against live data.
 */

export type DatasourceKind = 'prometheus' | 'loki' | 'tempo';

export const DATASOURCE_UIDS: Record<DatasourceKind, string> = {
  prometheus: 'raion-prometheus',
  loki: 'raion-loki',
  tempo: 'raion-tempo',
};

/**
 * - data:     must return data whenever the stack (or, for service panels, the service) is healthy
 * - optional: may legitimately be empty (e.g. "error logs" when there are no errors)
 */
export type Expectation = 'data' | 'optional';

export interface Target {
  refId: string;
  /** PromQL or LogQL. */
  expr?: string;
  /** TraceQL (Tempo search). */
  query?: string;
  queryType?: 'traceql' | 'serviceMap' | 'range' | 'instant';
  legendFormat?: string;
  instant?: boolean;
  limit?: number;
  serviceMapQuery?: string;
}

export interface PanelSpec {
  title: string;
  description: string;
  type: 'timeseries' | 'stat' | 'table' | 'logs' | 'nodeGraph' | 'text' | 'bargauge';
  datasource?: DatasourceKind;
  targets?: Target[];
  /** Grid width (of 24) and height. */
  width: number;
  height?: number;
  unit?: string;
  expect?: Expectation;
  /** Markdown, for text panels. */
  content?: string;
  min?: number;
  max?: number;
  thresholds?: { color: string; value: number | null }[];
  stack?: boolean;
}

export interface RowSpec {
  title: string;
  panels: PanelSpec[];
}

export interface DashboardSpec {
  uid: string;
  title: string;
  description: string;
  tags: string[];
  rows: RowSpec[];
  links?: Record<string, unknown>[];
  refresh?: string;
  timeFrom?: string;
}

/** Raion-specific metadata stored on each panel, read back by the dashboard checker. */
export interface RaionPanelMeta {
  expect: Expectation;
}

function panelJson(spec: PanelSpec, id: number, x: number, y: number): Record<string, unknown> {
  const height = spec.height ?? 8;
  const datasource = spec.datasource
    ? { type: spec.datasource, uid: DATASOURCE_UIDS[spec.datasource] }
    : undefined;
  const base: Record<string, unknown> = {
    id,
    type: spec.type,
    title: spec.title,
    description: spec.description,
    gridPos: { x, y, w: spec.width, h: height },
    ...(datasource ? { datasource } : {}),
    raion: {
      expect: spec.expect ?? (spec.type === 'text' ? 'optional' : 'data'),
    } satisfies RaionPanelMeta,
  };
  if (spec.type === 'text') {
    return { ...base, options: { mode: 'markdown', content: spec.content ?? '' } };
  }
  const targets = (spec.targets ?? []).map((t) => ({
    ...t,
    datasource,
    ...(spec.datasource === 'prometheus'
      ? { range: !t.instant, instant: Boolean(t.instant), editorMode: 'code' }
      : {}),
    ...(spec.datasource === 'loki'
      ? { queryType: t.queryType ?? 'range', editorMode: 'code' }
      : {}),
  }));
  const defaults: Record<string, unknown> = {
    ...(spec.unit ? { unit: spec.unit } : {}),
    ...(spec.min !== undefined ? { min: spec.min } : {}),
    ...(spec.max !== undefined ? { max: spec.max } : {}),
    ...(spec.thresholds ? { thresholds: { mode: 'absolute', steps: spec.thresholds } } : {}),
    ...(spec.type === 'timeseries'
      ? {
          custom: {
            drawStyle: 'line',
            lineWidth: 1,
            fillOpacity: spec.stack ? 30 : 10,
            showPoints: 'never',
            spanNulls: true,
            ...(spec.stack ? { stacking: { mode: 'normal', group: 'A' } } : {}),
          },
        }
      : {}),
  };
  const options: Record<string, unknown> =
    spec.type === 'logs'
      ? {
          showTime: true,
          wrapLogMessage: true,
          sortOrder: 'Descending',
          enableLogDetails: true,
          dedupStrategy: 'none',
        }
      : spec.type === 'stat'
        ? {
            reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
            colorMode: 'value',
            graphMode: 'area',
            textMode: 'auto',
          }
        : spec.type === 'timeseries'
          ? {
              legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
              tooltip: { mode: 'multi', sort: 'desc' },
            }
          : spec.type === 'bargauge'
            ? {
                orientation: 'horizontal',
                displayMode: 'gradient',
                reduceOptions: { calcs: ['lastNotNull'], values: false },
              }
            : {};
  return { ...base, targets, fieldConfig: { defaults, overrides: [] }, options };
}

/** Lays rows out top to bottom, panels left to right (wrapping at 24 columns). */
export function buildDashboard(spec: DashboardSpec): Record<string, unknown> {
  const panels: Record<string, unknown>[] = [];
  let id = 1;
  let y = 0;
  for (const row of spec.rows) {
    if (row.panels.length === 0) continue;
    panels.push({
      id: id++,
      type: 'row',
      title: row.title,
      collapsed: false,
      gridPos: { x: 0, y, w: 24, h: 1 },
      panels: [],
    });
    y += 1;
    let x = 0;
    let rowHeight = 0;
    for (const panel of row.panels) {
      if (x + panel.width > 24) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      panels.push(panelJson(panel, id++, x, y));
      x += panel.width;
      rowHeight = Math.max(rowHeight, panel.height ?? 8);
    }
    y += rowHeight;
  }
  return {
    uid: spec.uid,
    title: spec.title,
    description: spec.description,
    tags: spec.tags,
    editable: false,
    graphTooltip: 1,
    refresh: spec.refresh ?? '30s',
    schemaVersion: 39,
    version: 1,
    time: { from: spec.timeFrom ?? 'now-1h', to: 'now' },
    timezone: 'browser',
    templating: { list: [] },
    annotations: { list: [] },
    links: spec.links ?? [],
    panels,
  };
}

/** A PromQL/LogQL double-quoted string literal. */
export function q(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
