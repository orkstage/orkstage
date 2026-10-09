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
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Short-lived credentials per target via cross-account AssumeRole with an external id
 * (spec §11). Cached in memory until shortly before expiry; never persisted or logged.
 */
export class AwsCredentialProvider {
  private readonly cache = new Map<string, AwsCredentials>();

  constructor(
    private readonly resolveExternalId: ExternalIdResolver,
    private readonly stsFactory: StsClientFactory = (region) => new STSClient({ region }),
  ) {}

  async get(ctx: ProviderContext): Promise<AwsCredentials> {
    const cfg = awsConfig(ctx.target);
    if (isEmulator(cfg)) return EMULATOR_CREDENTIALS;
    const key = `${ctx.target.id}:${ctx.region}`;
    const cached = this.cache.get(key);
    if (cached?.expiration && cached.expiration.getTime() - Date.now() > REFRESH_MARGIN_MS) return cached;
    if (!cfg.roleArn) throw new ProviderError('AWS_ROLE_MISSING', 'The AWS target has no deployment role configured.', 'AUTHENTICATION_ERROR', 'aws');

    const externalId = ctx.target.credentialRef ? await this.resolveExternalId(ctx.target.credentialRef) : undefined;
    const out = await this.stsFactory(ctx.region).send(
      new AssumeRoleCommand({
        RoleArn: cfg.roleArn,
        RoleSessionName: `orkstage-${ctx.correlationId}`.replace(/[^\w+=,.@-]/g, '').slice(0, 64),
        ExternalId: externalId,
        DurationSeconds: 3600,
      }),
      { abortSignal: ctx.signal },
    );
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new ProviderError('AWS_ASSUME_ROLE_FAILED', 'STS returned no credentials.', 'AUTHENTICATION_ERROR', 'aws');
    const creds = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
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
