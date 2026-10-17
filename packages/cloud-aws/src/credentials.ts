// SPDX-License-Identifier: AGPL-3.0-only
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ProviderError, type ProviderContext } from '@orkstage/cloud-core';
import { awsConfig, isEmulator } from './config.js';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export type ExternalIdResolver = (credentialRef: string) => Promise<string>;
export type StsClientFactory = (region: string) => Pick<STSClient, 'send'>;

/** Emulators accept any credentials; these are not secrets. */
const EMULATOR_CREDENTIALS: AwsCredentials = { accessKeyId: 'test', secretAccessKey: 'test' };
/** SDK calls: reuse cached credentials while they have at least this long left. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Default session length; the role's MaxSessionDuration must allow it. */
export const DEFAULT_SESSION_SECONDS = 3600;

/**
 * Short-lived credentials per target via cross-account AssumeRole with an external id
 * (spec §11). Cached in memory while they still cover what the caller needs; never persisted or
 * logged. The cache key includes the role and the credential reference, so editing a target takes
 * effect at once in every process.
 */
export class AwsCredentialProvider {
  private readonly cache = new Map<string, AwsCredentials>();

  constructor(
    private readonly resolveExternalId: ExternalIdResolver,
    private readonly stsFactory: StsClientFactory = (region) => new STSClient({ region }),
    private readonly sessionSeconds: number = DEFAULT_SESSION_SECONDS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Credentials valid for at least `minValidityMs` from now. SDK calls take the default margin;
   * an OpenTofu run asks for its whole timeout, so an apply never starts with credentials that
   * expire halfway through it.
   */
  async get(ctx: ProviderContext, minValidityMs = REFRESH_MARGIN_MS): Promise<AwsCredentials> {
    const cfg = awsConfig(ctx.target);
    if (isEmulator(cfg)) return EMULATOR_CREDENTIALS;
    const key = [ctx.target.id, cfg.roleArn ?? '', ctx.target.credentialRef ?? '', ctx.region].join('|');
    const cached = this.cache.get(key);
    if (cached?.expiration && cached.expiration.getTime() - this.now() > minValidityMs) return cached;
    if (!cfg.roleArn) throw new ProviderError('AWS_ROLE_MISSING', 'The AWS target has no deployment role configured.', 'AUTHENTICATION_ERROR', 'aws');

    const externalId = ctx.target.credentialRef ? await this.resolveExternalId(ctx.target.credentialRef) : undefined;
    const out = await this.stsFactory(ctx.region).send(
      new AssumeRoleCommand({
        RoleArn: cfg.roleArn,
        RoleSessionName: `orkstage-${ctx.correlationId}`.replace(/[^\w+=,.@-]/g, '').slice(0, 64),
        ExternalId: externalId,
        DurationSeconds: this.sessionSeconds,
      }),
      { abortSignal: ctx.signal },
    );
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new ProviderError('AWS_ASSUME_ROLE_FAILED', 'STS returned no credentials.', 'AUTHENTICATION_ERROR', 'aws');
    const creds = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
    if (creds.expiration && creds.expiration.getTime() - this.now() < minValidityMs) {
      ctx.log?.(
        'warn',
        `AWS credentials last ${Math.round(this.sessionSeconds / 60)} minutes, less than this OpenTofu run may take. Raise AWS_ROLE_SESSION_MINUTES and the role's MaxSessionDuration, or lower TOFU_TIMEOUT_MINUTES.`,
      );
    }
    this.cache.set(key, creds);
    return creds;
  }

  /** SDK client options for this target: credentials plus endpoint override for emulators. */
  async clientConfig(ctx: ProviderContext) {
    const cfg = awsConfig(ctx.target);
    const credentials = await this.get(ctx);
    return {
      region: ctx.region,
      credentials,
      ...(isEmulator(cfg) ? { endpoint: cfg.endpointUrl, forcePathStyle: true } : {}),
    };
  }
}
