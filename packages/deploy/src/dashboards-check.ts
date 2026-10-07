import type { GatewayClient } from './gateway.js';

/** Grafana user Raion uses for automated, read-only checks (created on first use, Viewer role). */
export const CHECK_USER = 'raion-system';

interface PanelJson {
  id: number;
  type: string;
  title: string;
  datasource?: { type: string; uid: string };
  targets?: Record<string, unknown>[];
  raion?: { expect: 'data' | 'optional' };
}

export interface PanelCheck {
  dashboard: string;
  dashboardUid: string;
  panel: string;
  expect: 'data' | 'optional';
  /** data: returned data; empty: ran fine but returned nothing; error: the query failed. */
  status: 'data' | 'empty' | 'error';
  ok: boolean;
  detail?: string;
}

export interface DashboardCheck {
  dashboards: { uid: string; title: string; loaded: boolean }[];
  panels: PanelCheck[];
  ok: boolean;
}

interface Frame {
  data?: { values?: unknown[][] };
}

function framesHaveData(frames: Frame[] | undefined): boolean {
  return (frames ?? []).some((f) =>
    (f.data?.values ?? []).some(
      (column) => Array.isArray(column) && column.some((v) => v !== null && v !== undefined),
    ),
  );
}

/**
 * Asks Grafana itself to run every panel query of the generated dashboards, through the same
 * datasources the dashboards use. A panel that should show data but returns nothing (or fails)
 * is reported, so "generated" never silently means "broken".
 */
export async function checkDashboards(
  gateway: GatewayClient,
  dashboards: { uid: string; title: string; json: Record<string, unknown> }[],
  options: { from?: string } = {},
): Promise<DashboardCheck> {
  const headers = {
    'x-webauth-user': CHECK_USER,
    'x-webauth-role': 'Viewer',
    'content-type': 'application/json',
  };
  const result: DashboardCheck = { dashboards: [], panels: [], ok: true };

  for (const dashboard of dashboards) {
    const res = await gateway.fetch(
      `/grafana/api/dashboards/uid/${encodeURIComponent(dashboard.uid)}`,
      { headers, timeoutMs: 15_000 },
    );
    await res.body?.cancel();
    result.dashboards.push({ uid: dashboard.uid, title: dashboard.title, loaded: res.ok });
    if (!res.ok) result.ok = false;

    for (const panel of (dashboard.json.panels ?? []) as PanelJson[]) {
      if (!panel.datasource || !panel.targets?.length) continue;
      const expect = panel.raion?.expect ?? 'data';
      const check: PanelCheck = {
        dashboard: dashboard.title,
        dashboardUid: dashboard.uid,
        panel: panel.title,
        expect,
        status: 'empty',
        ok: true,
      };

      // The service map is computed in the browser from the service-graph metrics; check those.
      const queries =
        panel.type === 'nodeGraph'
          ? [
              {
                refId: 'A',
                datasource: { type: 'prometheus', uid: 'raion-prometheus' },
                expr: 'sum(traces_service_graph_request_total)',
                instant: true,
                range: false,
              },
            ]
          : panel.targets;

      try {
        const response = await gateway.fetch('/grafana/api/ds/query', {
          method: 'POST',
          headers,
          timeoutMs: 30_000,
          body: JSON.stringify({
            from: options.from ?? 'now-15m',
            to: 'now',
            queries: queries.map((t) => ({ ...t, intervalMs: 15_000, maxDataPoints: 200 })),
          }),
        });
        const body = (await response.json()) as {
          results?: Record<string, { frames?: Frame[]; error?: string }>;
          message?: string;
        };
        const results = Object.values(body.results ?? {});
        const errors = results.map((r) => r.error).filter(Boolean);
        if (!response.ok || errors.length > 0) {
          check.status = 'error';
          check.detail = errors[0] ?? body.message ?? `HTTP ${response.status}`;
        } else if (results.some((r) => framesHaveData(r.frames))) {
          check.status = 'data';
        }
      } catch (error) {
        check.status = 'error';
        check.detail = (error as Error).message;
      }
      check.ok = check.status === 'data' || (check.status === 'empty' && expect === 'optional');
      if (!check.ok) result.ok = false;
      result.panels.push(check);
    }
  }
  return result;
}
