// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test of startTelemetry (run by `pnpm test` after the build): a fake OTLP receiver, one instrumented HTTP
// request served and fetched, one platform metric; prints which OTLP paths received data.
import { createServer } from 'node:http';

const received = new Set();
const collector = createServer((req, res) => {
  received.add(req.url);
  req.resume();
  req.on('end', () => res.writeHead(200).end());
});
await new Promise((r) => collector.listen(0, r));
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${collector.address().port}`;

const { startTelemetry, stopTelemetry } = await import('../dist/telemetry.js');
console.log('started', await startTelemetry('orkstage-api'));
const http = await import('node:http');
const app = http.createServer((_req, res) => res.end('ok'));
await new Promise((r) => app.listen(0, r));
await fetch(`http://127.0.0.1:${app.address().port}/api/v1/instances`);
const { platformMetrics, traceCarrier } = await import('../dist/metrics.js');
platformMetrics.deployment('APPLY', 'SUCCEEDED', 1234);
console.log('carrier outside a span', traceCarrier());
await stopTelemetry();
app.close();
collector.close();
console.log('received', [...received].sort().join(' '));
process.exit(received.has('/v1/traces') && received.has('/v1/metrics') ? 0 : 1);
