// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Platform metrics (spec §77) and trace context across queues. Built on @opentelemetry/api only:
 * without startTelemetry() the API is a no-op, so calling these costs nothing.
 *
 * Names follow the OpenTelemetry conventions: seconds for durations, `orkstage.` prefix. HTTP
 * request duration and count come from the HTTP instrumentation (`http.server.request.duration`).
 */
import { context, metrics, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

const meter = () => metrics.getMeter('orkstage');
const tracer = () => trace.getTracer('orkstage');

// Instruments are created on first use, after startTelemetry() installed the meter provider.
let instruments: ReturnType<typeof create> | null = null;
function create() {
  const m = meter();
  return {
    jobDuration: m.createHistogram('orkstage.job.duration', { unit: 's', description: 'Time a queue job took, by queue and outcome.' }),
    jobRetries: m.createCounter('orkstage.job.retries', { description: 'Job attempts after the first, by queue.' }),
    deploymentDuration: m.createHistogram('orkstage.deployment.duration', { unit: 's', description: 'Queued to finished, by kind and outcome.' }),
    providerDuration: m.createHistogram('orkstage.provider.request.duration', { unit: 's', description: 'Provider operations (apply, destroy), by provider and outcome.' }),
    providerErrors: m.createCounter('orkstage.provider.errors', { description: 'Failed provider operations, by provider and failure class.' }),
    incidentsOpened: m.createCounter('orkstage.incident.opened', { description: 'Incidents opened, by source.' }),
    incidentResolve: m.createHistogram('orkstage.incident.time_to_resolve', { unit: 's', description: 'Opened to resolved.' }),
    notificationFailures: m.createCounter('orkstage.notification.failures', { description: 'Failed deliveries, by channel.' }),
    healthChecks: m.createCounter('orkstage.health_check.count', { description: 'Resource health checks, by provider and resulting state.' }),
  };
}
const i = () => (instruments ??= create());

const seconds = (ms: number) => ms / 1000;

export const platformMetrics = {
  job(queue: string, ms: number, outcome: 'ok' | 'error', attempt: number) {
    i().jobDuration.record(seconds(ms), { queue, outcome });
    if (attempt > 1) i().jobRetries.add(1, { queue });
  },
  deployment(kind: string, outcome: string, ms: number) {
    i().deploymentDuration.record(seconds(ms), { kind, outcome });
  },
  provider(provider: string, operation: string, ms: number, outcome: 'ok' | 'error', failureClass?: string) {
    i().providerDuration.record(seconds(ms), { provider, operation, outcome });
    if (outcome === 'error') i().providerErrors.add(1, { provider, operation, 'failure.class': failureClass ?? 'unknown' });
  },
  incidentOpened(source: string) {
    i().incidentsOpened.add(1, { source });
  },
  incidentResolved(openedAt: Date | null | undefined) {
    if (openedAt) i().incidentResolve.record(seconds(Date.now() - openedAt.getTime()));
  },
  notificationFailed(channel: string) {
    i().notificationFailures.add(1, { channel });
  },
  /** The failure rate is the share of checks whose state is UNHEALTHY or UNKNOWN. */
  healthCheck(provider: string, state: string) {
    i().healthChecks.add(1, { provider, state });
  },
  /** Queue depth, read when metrics are exported (worker only). */
  observeQueues(read: () => Promise<{ queue: string; state: string; count: number }[]>) {
    const gauge = meter().createObservableGauge('orkstage.queue.depth', { description: 'Jobs per queue and state.' });
    gauge.addCallback(async (result) => {
      for (const r of await read().catch(() => [])) result.observe(r.count, { queue: r.queue, state: r.state });
    });
  },
};

/** Trace context to put in a job's data, so the worker's span continues the API request's trace. */
export function traceCarrier(): Record<string, string> | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length ? carrier : undefined;
}

/**
 * Runs a queue job inside a span that continues the trace of whoever queued it, and records the
 * job metrics. `attributes` carry tenant.id, instance.id, deployment.id where the job has them.
 */
export async function traceJob<T>(queue: string, job: { data: unknown; attemptsMade?: number }, attributes: Attributes, run: () => Promise<T>): Promise<T> {
  const carrier = (job.data as { _trace?: Record<string, string> } | null)?._trace ?? {};
  const parent = propagation.extract(ROOT_CONTEXT, carrier);
  const started = Date.now();
  const attempt = (job.attemptsMade ?? 0) + 1;
  return tracer().startActiveSpan(`job ${queue}`, { kind: SpanKind.CONSUMER, attributes: { 'messaging.destination.name': queue, ...attributes } }, parent, async (span) => {
    try {
      const result = await run();
      platformMetrics.job(queue, Date.now() - started, 'ok', attempt);
      return result;
    } catch (err) {
      platformMetrics.job(queue, Date.now() - started, 'error', attempt);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message.slice(0, 200) : 'failed' });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Adds attributes (tenant.id, instance.id, provider, region...) to the current span, if any. */
export function annotateSpan(attributes: Attributes) {
  trace.getActiveSpan()?.setAttributes(attributes);
}
