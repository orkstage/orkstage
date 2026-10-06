'use client';
import { createOpenAPIPage } from 'fumadocs-openapi/ui';

/**
 * Renders one operation of the generated API reference. The interactive playground is off:
 * the site is static, the API grants no cross-origin requests, and examples show the exact
 * requests to send instead.
 */
export const OpenAPIPage = createOpenAPIPage({
  playground: { enabled: false },
});
