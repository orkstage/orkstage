import { describe, expect, it } from 'vitest';
import { assertSafeWebhookUrl, AwsSecretsManagerResolver, CompositeSecretResolver, EnvSecretResolver, findSecretLikeKeys, loadConfig, SecretBox, signWebhook, verifyWebhook } from './index.js';

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

  it('never resolves platform configuration through env://', async () => {
    const r = new EnvSecretResolver({ ENCRYPTION_KEY: 'k', DATABASE_URL: 'postgres://x', OIDC_ENTRA_CLIENT_SECRET: 's', AWS_SECRET_ACCESS_KEY: 'a', ORK_AZURE: '{}' });
    for (const name of ['ENCRYPTION_KEY', 'DATABASE_URL', 'OIDC_ENTRA_CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY']) {
      await expect(r.resolve(`env://${name}`)).rejects.toThrow(/platform configuration/);
    }
    await expect(r.resolve('env://ORK_AZURE')).resolves.toBe('{}');
  });

  it('reads aws-sm references, JSON keys and ARN regions, with a short cache', async () => {
    const calls: { region: string; id: string }[] = [];
    let t = 0;
    const r = new AwsSecretsManagerResolver({
      defaultRegion: 'us-east-1',
      now: () => t,
      clientFor: (region) => ({
        send: (async (cmd: { input: { SecretId: string } }) => {
          calls.push({ region, id: cmd.input.SecretId });
          if (cmd.input.SecretId.endsWith('missing')) throw Object.assign(new Error('arn:aws:secretsmanager:us-east-1:123456789012:secret:missing'), { name: 'ResourceNotFoundException' });
          return { SecretString: cmd.input.SecretId.includes('json') ? '{"password":"p@ss","port":5432}' : 'plain-value' };
        }) as never,
      }),
    });
    await expect(r.resolve('aws-sm://acme/plain')).resolves.toBe('plain-value');
    await expect(r.resolve('aws-sm://acme/json#password')).resolves.toBe('p@ss');
    await expect(r.resolve('aws-sm://acme/json#port')).resolves.toBe('5432');
    await expect(r.resolve('aws-sm://acme/json#nope')).rejects.toThrow(/no string field/);
    await expect(r.resolve('aws-sm://acme/plain#key')).rejects.toThrow(/not JSON/);
    await r.resolve('aws-sm://arn:aws:secretsmanager:eu-west-1:123456789012:secret:db-AbCdEf');
    expect(calls.filter((c) => c.id === 'acme/json')).toHaveLength(1); // cached
    expect(calls.at(-1)!.region).toBe('eu-west-1');
    t += 10 * 60_000;
    await r.resolve('aws-sm://acme/json#password');
    expect(calls.filter((c) => c.id === 'acme/json')).toHaveLength(2); // expired
    const err = await r.resolve('aws-sm://arn:aws:secretsmanager:us-east-1:123456789012:secret:missing').catch((e: Error) => e.message);
    expect(err).toMatch(/ResourceNotFoundException/);
    expect(err).not.toContain('123456789012');
  });

  it('routes references by scheme', async () => {
    const r = new CompositeSecretResolver({ env: new EnvSecretResolver({ A: '1' }) });
    await expect(r.resolve('env://A')).resolves.toBe('1');
    await expect(r.resolve('aws-sm://x')).rejects.toThrow(/Supported: env:\/\//);
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

  it('derives stable, purpose bound secrets from the key', () => {
    const box = new SecretBox(undefined, 'x'.repeat(40));
    const a = box.derive('supabase:db:t1:ork-acme-prod-db');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(box.derive('supabase:db:t1:ork-acme-prod-db')).toBe(a);
    expect(box.derive('supabase:db:t1:other')).not.toBe(a);
    expect(new SecretBox(undefined, 'y'.repeat(40)).derive('supabase:db:t1:ork-acme-prod-db')).not.toBe(a);
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
    // IPv6 forms that embed IPv4 must not smuggle private addresses through (URL normalizes these to hex).
    await expect(assertSafeWebhookUrl('https://[::ffff:127.0.0.1]/hook', false)).rejects.toThrow(/public/);
    await expect(assertSafeWebhookUrl('https://[::ffff:a9fe:a9fe]/hook', false)).rejects.toThrow(/public/);
    await expect(assertSafeWebhookUrl('https://[64:ff9b::a00:1]/hook', false)).rejects.toThrow(/public/);
    await expect(assertSafeWebhookUrl('https://[2002:7f00:1::]/hook', false)).rejects.toThrow(/public/);
    await expect(assertSafeWebhookUrl('https://[fe90::1]/hook', false)).rejects.toThrow(/public/);
    await expect(assertSafeWebhookUrl('https://198.18.0.1/hook', false)).rejects.toThrow(/public/);
    await expect(assertSafeWebhookUrl('https://[2606:4700::1111]/hook', false)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeWebhookUrl('http://localhost:9999/hook', true)).resolves.toBeInstanceOf(URL);
  });
});
