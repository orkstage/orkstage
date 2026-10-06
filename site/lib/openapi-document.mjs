// Loads openapi/orkstage.json (exported from the API's /api/docs-json) and fills two gaps the
// Swagger export has today, so the reference reads well:
//  - operations have no `summary`: use "METHOD /path" (without the /api/v1 prefix);
//  - only the session cookie is declared: add the Bearer API key scheme the API also accepts
//    (docs/specs/integration-api.md). Upstream fix: DocumentBuilder().addBearerAuth().
// Used by the page generator (scripts/) and at render time (lib/openapi.ts), so both agree.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const OPENAPI_FILE = 'openapi/orkstage.json';
export const SCHEMA_ID = 'orkstage';
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

export function shortPath(path) {
  return path.replace(/^\/api\/v1/, '') || '/';
}

export function loadOrkstageDocument(file = OPENAPI_FILE) {
  const doc = JSON.parse(readFileSync(resolve(file), 'utf8'));
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (op && !op.summary) op.summary = `${method.toUpperCase()} ${shortPath(path)}`;
    }
  }
  doc.components ??= {};
  doc.components.securitySchemes ??= {};
  doc.components.securitySchemes.apiKey ??= {
    type: 'http',
    scheme: 'bearer',
    description: 'API key `ork_<live|test>_<prefix>_<secret>`. Bearer requests need no CSRF header. Keys only reach routes that declare a scope.',
  };
  doc.servers ??= [{ url: 'http://localhost:4000', description: 'Local platform (Docker Compose)' }];
  return doc;
}
