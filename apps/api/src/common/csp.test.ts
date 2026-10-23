// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isDocsPath, relaxForDocs } from './csp.js';

describe('Content Security Policy', () => {
  it('matches the Swagger UI pages and assets only', () => {
    expect(isDocsPath('/api/docs')).toBe(true);
    expect(isDocsPath('/api/docs/')).toBe(true);
    expect(isDocsPath('/api/docs/swagger-ui-init.js')).toBe(true);
    expect(isDocsPath('/api/docs-json')).toBe(true);
    expect(isDocsPath('/api/docs?x=1')).toBe(true);
    expect(isDocsPath('/api/v1/instances')).toBe(false);
    expect(isDocsPath('/api/documents')).toBe(false);
  });

  it('adds unsafe-inline to scripts and styles and leaves every other directive alone', () => {
    const strict = "default-src 'self';script-src 'self';style-src 'self';img-src 'self' data:;object-src 'none';script-src-attr 'none'";
    expect(relaxForDocs(strict)).toBe(
      "default-src 'self';script-src 'self' 'unsafe-inline';style-src 'self' 'unsafe-inline';img-src 'self' data:;object-src 'none';script-src-attr 'none'",
    );
    expect(relaxForDocs(relaxForDocs(strict))).toBe(relaxForDocs(strict));
  });
});
