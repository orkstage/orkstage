// SPDX-License-Identifier: AGPL-3.0-only

/** Swagger UI pages and their assets (`SwaggerModule.setup('api/docs', ...)` in server.ts). */
const DOCS_PATH = /^\/api\/docs(?:[/?-]|$)/;

export function isDocsPath(url: string): boolean {
  return DOCS_PATH.test(url);
}

/**
 * The API's Content Security Policy allows no inline script or style (open item 24): it serves
 * JSON. Swagger UI needs inline styles and scripts, so only its pages get them added.
 */
export function relaxForDocs(policy: string): string {
  return policy
    .split(';')
    .map((directive) => {
      const d = directive.trim();
      return /^(script-src|style-src)\s/.test(d) && !d.includes("'unsafe-inline'") ? `${d} 'unsafe-inline'` : d;
    })
    .join(';');
}
