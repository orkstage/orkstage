import { describe, expect, it } from 'vitest';
import { assertSafeWebhookUrl, EnvSecretResolver, findSecretLikeKeys, loadConfig, SecretBox, signWebhook, verifyWebhook } from './index.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'x'.repeat(40),
};

describe('config', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.TOFU_IMAGE).toBe('ghcr.io/opentofu/opentofu:1.12.7');
    expect(c.AUTH_DEV_LOGIN_ENABLED).toBe(false);
  });

  it('fails fast on missing settings', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('refuses dev login in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AUTH_DEV_LOGIN_ENABLED: 'true' })).toThrow(/Dev login/);
  });
});

describe('secrets', () => {
  it('resolves env references and rejects unknown schemes', async () => {
    const r = new EnvSecretResolver({ EXT_ID: 'abc' });
    await expect(r.resolve('env://EXT_ID')).resolves.toBe('abc');
    await expect(r.resolve('vault://x')).rejects.toThrow(/Unsupported/);
  });

  it('flags secret-looking keys in non-secret config', () => {
    expect(findSecretLikeKeys({ accountId: '1', nested: { secretAccessKey: 'x' }, roleArn: 'r' })).toEqual(['nested.secretAccessKey']);
  });

  it('seals and opens secrets, and detects tampering', () => {
    const box = new SecretBox(undefined, 'x'.repeat(40));
    const sealed = box.seal('whsec_abc');
    expect(sealed).not.toContain('whsec_abc');
    expect(box.open(sealed)).toBe('whsec_abc');
    const parts = sealed.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join(':'))).toThrow();
    expect(() => new SecretBox(undefined, 'y'.repeat(40)).open(sealed)).toThrow();
  });

  it('requires production encryption keys', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'z'.repeat(40) })).toThrow(/ENCRYPTION_KEY/);
  });
});

describe('webhooks', () => {
  it('signs payloads that receivers can verify, with replay protection', () => {
    const body = JSON.stringify({ type: 'ping' });
    const now = 1_800_000_000;
    const header = signWebhook('whsec_x', now, body);
    expect(verifyWebhook('whsec_x', header, body, 300, now + 10)).toBe(true);
    expect(verifyWebhook('whsec_other', header, body, 300, now)).toBe(false);
    expect(verifyWebhook('whsec_x', header, `${body} `, 300, now)).toBe(false);
    expect(verifyWebhook('whsec_x', header, body, 300, now + 301)).toBe(false);
  });

  it('rejects unsafe URLs (SSRF)', async () => {
    await expect(assertSafeWebhookUrl('http://example.com/hook', false)).rejects.toThrow(/https/);
    await expect(assertSafeWebhookUrl('https://127.0.0.1/hook', false)).rejects.toThrow(/public/);
    await expect(assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data', false)).rejects.toThrow(/public/);
    await expect(assertSafeWebhookUrl('https://[::1]/hook', false)).rejects.toThrow(/public/);
    await expect(assertSafeWebhookUrl('https://user:pw@example.com/', false)).rejects.toThrow(/credentials/);
    await expect(assertSafeWebhookUrl('https://93.184.215.14/hook', false)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeWebhookUrl('http://localhost:9999/hook', true)).resolves.toBeInstanceOf(URL);
  });
});
