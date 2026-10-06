// Downloads the OpenAPI document from a running OrkStage API and stores it in openapi/orkstage.json.
// Usage: pnpm openapi:refresh            (default http://localhost:4000)
//        ORKSTAGE_API_URL=https://api.example.com pnpm openapi:refresh
// After the polyrepo split, CI in the orkstage repo publishes this file as a release asset.
import { mkdirSync, writeFileSync } from 'node:fs';

const base = (process.env.ORKSTAGE_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const url = `${base}/api/docs-json`;

let res;
try {
  res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
} catch (err) {
  console.error(`[openapi] ${url} is not reachable (${err.message}). Start the API first, e.g. "pnpm platform:up" in the platform repo.`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`[openapi] ${url} answered HTTP ${res.status}.`);
  process.exit(1);
}
const doc = await res.json();
if (!doc.openapi || !doc.paths) {
  console.error('[openapi] The response is not an OpenAPI document.');
  process.exit(1);
}
mkdirSync('openapi', { recursive: true });
writeFileSync('openapi/orkstage.json', `${JSON.stringify(doc, null, 2)}\n`);
console.log(`[openapi] Saved ${Object.keys(doc.paths).length} paths from ${url} to openapi/orkstage.json.`);
