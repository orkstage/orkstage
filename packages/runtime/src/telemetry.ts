// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OpenTelemetry for the API and the worker (open item 6, spec §77): traces for HTTP, outgoing
 * fetch, Redis and Prisma, and the platform metrics in metrics.ts, exported over OTLP to
 * OTEL_EXPORTER_OTLP_ENDPOINT. Without that variable nothing is loaded and nothing is exported.
 *
 * Instrumentation patches modules when they load, and ES modules are linked before any code runs,
 * so an entry point must start telemetry first and import the application afterwards:
 *
 *   await startTelemetry('orkstage-api');
 *   await import('./server.js');
 */
import { register } from 'node:module';

let stop: (() => Promise<void>) | null = null;

export async function startTelemetry(service: 'orkstage-api' | 'orkstage-worker'): Promise<boolean> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint || stop) return Boolean(stop);

  // ES module hook first: modules imported from now on can be instrumented.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const [{ NodeTracerProvider, BatchSpanProcessor }, metricsSdk, { OTLPTraceExporter }, { OTLPMetricExporter }, { resourceFromAttributes }, instrumentation, http, undici, ioredis, prisma] =
    await Promise.all([
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/sdk-metrics'),
      import('@opentelemetry/exporter-trace-otlp-proto'),
      import('@opentelemetry/exporter-metrics-otlp-proto'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/instrumentation'),
      import('@opentelemetry/instrumentation-http'),
      import('@opentelemetry/instrumentation-undici'),
      import('@opentelemetry/instrumentation-ioredis'),
      import('@prisma/instrumentation'),
    ]);
  const { metrics } = await import('@opentelemetry/api');

  const resource = resourceFromAttributes({
    'service.name': service,
    'service.namespace': 'orkstage',
    'service.version': process.env.ORKSTAGE_VERSION ?? 'dev',
  });
  // The exporters read OTEL_EXPORTER_OTLP_ENDPOINT (and _HEADERS, _PROTOCOL) themselves.
  const tracer = new NodeTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())] });
  tracer.register();
  const meter = new metricsSdk.MeterProvider({
    resource,
    readers: [new metricsSdk.PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 })],
  });
  metrics.setGlobalMeterProvider(meter);

  instrumentation.registerInstrumentations({
    instrumentations: [
      // Health probes would drown the traces.
      new http.HttpInstrumentation({ ignoreIncomingRequestHook: (req) => /\/(healthz|readyz)$/.test(req.url ?? '') }),
      new undici.UndiciInstrumentation(),
      new ioredis.IORedisInstrumentation(),
      new prisma.PrismaInstrumentation(),
    ],
  });

  stop = async () => {
    await Promise.allSettled([tracer.shutdown(), meter.shutdown()]);
  };
  return true;
}

/** Flushes what is buffered; call before the process exits. */
export async function stopTelemetry(): Promise<void> {
  await stop?.();
}
