import { randomBytes } from 'node:crypto';
import type { GatewayClient } from './gateway.js';

export interface SignalCheck {
  signal: 'metrics' | 'logs' | 'traces';
  ok: boolean;
  /** What happened, in plain language. */
  message: string;
  /** The query used, so users can repeat it themselves in Grafana. */
  query?: string;
}

const SERVICE = 'raion-selftest';

function attr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

/**
 * End-to-end pipeline check: sends one metric, one log line and one span to the collector
 * (exactly like an instrumented application would), then confirms each arrived in storage.
 */
export async function verifyPipeline(
  gateway: GatewayClient,
  otlpHttpPort: number,
  options: { traces: boolean; timeoutMs?: number; environment: string },
): Promise<SignalCheck[]> {
  const runId = randomBytes(6).toString('hex');
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const nowNs = `${BigInt(Date.now()) * 1_000_000n}`;
  const resource = {
    attributes: [
      attr('service.name', SERVICE),
      attr('deployment.environment.name', options.environment),
    ],
  };
  const otlp = `http://127.0.0.1:${otlpHttpPort}`;
  const post = async (path: string, body: unknown): Promise<string | undefined> => {
    try {
      const res = await fetch(`${otlp}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? undefined : `collector answered HTTP ${res.status}`;
    } catch (error) {
      return `could not reach the collector on 127.0.0.1:${otlpHttpPort} (${(error as Error).message})`;
    }
  };

  const sendErrors = {
    metrics: await post('/v1/metrics', {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              scope: { name: 'raion.verify' },
              metrics: [
                {
                  name: 'raion.selftest',
                  gauge: {
                    dataPoints: [
                      { asInt: '1', timeUnixNano: nowNs, attributes: [attr('run_id', runId)] },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
    logs: await post('/v1/logs', {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope: { name: 'raion.verify' },
              logRecords: [
                {
                  timeUnixNano: nowNs,
                  severityText: 'INFO',
                  severityNumber: 9,
                  body: { stringValue: `raion self-test ${runId}` },
                  traceId,
                  spanId,
                },
              ],
            },
          ],
        },
      ],
    }),
    traces: options.traces
      ? await post('/v1/traces', {
          resourceSpans: [
            {
              resource,
              scopeSpans: [
                {
                  scope: { name: 'raion.verify' },
                  spans: [
                    {
                      traceId,
                      spanId,
                      name: 'raion self-test',
                      kind: 2,
                      startTimeUnixNano: nowNs,
                      endTimeUnixNano: `${BigInt(nowNs) + 1_000_000n}`,
                      attributes: [attr('run_id', runId)],
                    },
                  ],
                },
              ],
            },
          ],
        })
      : undefined,
  };

  const promQuery = `raion_selftest{service_name="${SERVICE}",run_id="${runId}"}`;
  const logQuery = `{service_name="${SERVICE}"} |= "${runId}"`;
  const startNs = `${(BigInt(Date.now()) - 600_000n) * 1_000_000n}`;

  const probes: Record<SignalCheck['signal'], { query: string; found: () => Promise<boolean> }> = {
    metrics: {
      query: promQuery,
      found: async () => {
        const body = await gateway.json<{ data: { result: unknown[] } }>(
          `/prometheus/api/v1/query?query=${encodeURIComponent(promQuery)}`,
        );
        return body.data.result.length > 0;
      },
    },
    logs: {
      query: logQuery,
      found: async () => {
        const body = await gateway.json<{ data: { result: unknown[] } }>(
          `/loki/loki/api/v1/query_range?query=${encodeURIComponent(logQuery)}&start=${startNs}&limit=10`,
        );
        return body.data.result.length > 0;
      },
    },
    traces: {
      query: `trace ${traceId}`,
      found: async () => {
        const res = await gateway.fetch(`/tempo/api/traces/${traceId}`);
        await res.body?.cancel();
        return res.ok;
      },
    },
  };

  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const signals: SignalCheck['signal'][] = options.traces
    ? ['metrics', 'logs', 'traces']
    : ['metrics', 'logs'];
  const results = new Map<SignalCheck['signal'], SignalCheck>();
  for (const signal of signals) {
    const error = sendErrors[signal];
    if (error) results.set(signal, { signal, ok: false, message: `sending failed: ${error}` });
  }

  let lastError = new Map<string, string>();
  while (results.size < signals.length && Date.now() < deadline) {
    for (const signal of signals) {
      if (results.has(signal)) continue;
      try {
        if (await probes[signal].found()) {
          results.set(signal, {
            signal,
            ok: true,
            message: 'received and stored',
            query: probes[signal].query,
          });
        }
      } catch (error) {
        lastError = new Map(lastError).set(signal, (error as Error).message);
      }
    }
    if (results.size < signals.length) await new Promise((r) => setTimeout(r, 2000));
  }
  for (const signal of signals) {
    if (!results.has(signal)) {
      results.set(signal, {
        signal,
        ok: false,
        message: `sent, but not found in storage within the time limit${lastError.has(signal) ? ` (${lastError.get(signal)})` : ''}`,
        query: probes[signal].query,
      });
    }
  }
  return signals.map((s) => results.get(s)!);
}
