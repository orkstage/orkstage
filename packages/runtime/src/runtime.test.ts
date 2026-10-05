import { describe, expect, it } from 'vitest';
import { EnvSecretResolver, findSecretLikeKeys, loadConfig } from './index.js';

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
});
