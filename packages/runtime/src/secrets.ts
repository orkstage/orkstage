import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Resolves secret references to values at the moment of use. Values are never stored in the
 * platform database or returned by the API (spec §21, §74). Schemes:
 * - `env://NAME` — process environment (local development, simple installs);
 * - `aws-sm://<name-or-arn>[#jsonKey]` — AWS Secrets Manager, read with the control plane's own
 *   credentials (default provider chain: task role, instance profile, SSO, env).
 */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

const scheme = (ref: string) => /^([a-z][a-z0-9-]*):\/\//.exec(ref)?.[1];

export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(ref: string): Promise<string> {
    const match = /^env:\/\/([A-Z0-9_]+)$/.exec(ref);
    if (!match) throw new Error(`Unsupported secret reference scheme in "${ref.split('://')[0]}://…".`);
    const value = this.env[match[1]!];
    if (!value) throw new Error(`Secret ${match[1]} is not set.`);
    return value;
  }
}

type SecretsManagerLike = Pick<SecretsManagerClient, 'send'>;

/**
 * `aws-sm://` resolver. The region comes from an ARN when one is given, otherwise from
 * `defaultRegion`. Values are cached briefly in memory (never logged or persisted) so a
 * deployment with many references does not hit Secrets Manager rate limits.
 */
export class AwsSecretsManagerResolver implements SecretResolver {
  private readonly clients = new Map<string, SecretsManagerLike>();
  private readonly cache = new Map<string, { value: string; expires: number }>();

  constructor(
    private readonly opts: {
      defaultRegion: string;
      endpoint?: string;
      cacheTtlMs?: number;
      clientFor?: (region: string) => SecretsManagerLike;
      now?: () => number;
    },
  ) {}

  async resolve(ref: string): Promise<string> {
    const match = /^aws-sm:\/\/([^#]+)(?:#(.+))?$/.exec(ref);
    if (!match) throw new Error('Malformed aws-sm:// reference. Use aws-sm://<name-or-arn>[#jsonKey].');
    const [, secretId, jsonKey] = match as unknown as [string, string, string | undefined];
    const raw = await this.secretString(secretId);
    if (!jsonKey) return raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Secret ${redact(secretId)} is not JSON, so #${jsonKey} cannot be read from it.`);
    }
    const value = (parsed as Record<string, unknown>)[jsonKey];
    if (value === undefined || value === null || typeof value === 'object') throw new Error(`Secret ${redact(secretId)} has no string field "${jsonKey}".`);
    return String(value);
  }

  private async secretString(secretId: string): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(secretId);
    if (hit && hit.expires > now) return hit.value;
    const region = /^arn:aws[\w-]*:secretsmanager:([a-z0-9-]+):/.exec(secretId)?.[1] ?? this.opts.defaultRegion;
    try {
      const out = await this.client(region).send(new GetSecretValueCommand({ SecretId: secretId }));
      const value = out.SecretString ?? (out.SecretBinary ? Buffer.from(out.SecretBinary).toString('utf8') : undefined);
      if (value === undefined) throw new Error('empty secret');
      this.cache.set(secretId, { value, expires: now + (this.opts.cacheTtlMs ?? 5 * 60_000) });
      return value;
    } catch (err) {
      // SDK messages can echo the ARN (account id); keep the error class, not the details.
      const name = (err as { name?: string }).name ?? 'Error';
      throw new Error(`Could not read secret ${redact(secretId)} from AWS Secrets Manager (${name}).`);
    }
  }

  private client(region: string): SecretsManagerLike {
    let c = this.clients.get(region);
    if (!c) {
      c = this.opts.clientFor?.(region) ?? new SecretsManagerClient({ region, ...(this.opts.endpoint ? { endpoint: this.opts.endpoint } : {}) });
      this.clients.set(region, c);
    }
    return c;
  }
}

/** Routes each reference to the resolver for its scheme. */
export class CompositeSecretResolver implements SecretResolver {
  constructor(private readonly byScheme: Record<string, SecretResolver>) {}

  async resolve(ref: string): Promise<string> {
    const s = scheme(ref);
    const resolver = s ? this.byScheme[s] : undefined;
    if (!resolver) throw new Error(`Unsupported secret reference scheme "${s ?? ref.split(':')[0]}://". Supported: ${Object.keys(this.byScheme).map((k) => `${k}://`).join(', ')}.`);
    return resolver.resolve(ref);
  }
}

/** The platform's resolver: `env://` always, `aws-sm://` with the given region/endpoint. */
export function createSecretResolver(opts: { awsRegion: string; awsEndpoint?: string; env?: NodeJS.ProcessEnv }): SecretResolver {
  return new CompositeSecretResolver({
    env: new EnvSecretResolver(opts.env),
    'aws-sm': new AwsSecretsManagerResolver({ defaultRegion: opts.awsRegion, endpoint: opts.awsEndpoint }),
  });
}

/** Secret ids in error messages: keep the name, drop the account id of an ARN. */
function redact(secretId: string): string {
  return secretId.replace(/^arn:aws[\w-]*:secretsmanager:([a-z0-9-]+):\d{12}:secret:/, 'arn:…:secret:');
}

/** Keys that suggest someone put a secret into non-secret target config. */
const SECRET_KEY = /secret|password|token|private.?key|access.?key|credential/i;

export function findSecretLikeKeys(config: Record<string, unknown>, prefix = ''): string[] {
  const found: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY.test(k)) found.push(path);
    if (v && typeof v === 'object' && !Array.isArray(v)) found.push(...findSecretLikeKeys(v as Record<string, unknown>, path));
  }
  return found;
}
