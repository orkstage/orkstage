// SPDX-License-Identifier: AGPL-3.0-only
// Telemetry first: OpenTelemetry instruments modules as they load, and the server's static imports
// would all load before any of its code ran (open item 6). Without OTEL_EXPORTER_OTLP_ENDPOINT this
// loads nothing.
import { startTelemetry } from '@orkstage/runtime/telemetry';

await startTelemetry('orkstage-worker');
await import('./server.js');
