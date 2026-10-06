import { createOpenAPI } from 'fumadocs-openapi/server';
import { loadOrkstageDocument, SCHEMA_ID } from './openapi-document.mjs';

/**
 * The Control API's OpenAPI document, exported from a running API (`/api/docs-json`) and checked
 * in as openapi/orkstage.json, so the static build never needs the platform. Refresh with
 * `pnpm openapi:refresh`.
 */
export const openapi = createOpenAPI({
  input: { [SCHEMA_ID]: () => loadOrkstageDocument() },
});
