import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { IAMClient } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  ProviderError,
  type CloudCapability,
  type CloudProviderAdapter,
  type CloudTarget,
  type DriftChange,
  type HealthResult,
  type LogLine,
  type ProviderContext,
  type ResourceIdentifier,
  type ResourcePlan,
  type ResourceRequest,
  type ResourceResult,
  type ResourceState,
  type TargetValidationCheck,
  type TargetValidationResult,
  type ValidateTargetOptions,
} from '@co/cloud-core';
import { TofuError, type TofuRunner, type TofuStack } from '@co/iac';
import { AWS_CAPABILITIES } from './catalog.js';
import { awsConfig, isEmulator, stateBucketFor } from './config.js';
import { AwsCredentialProvider, type ExternalIdResolver, type StsClientFactory } from './credentials.js';
import { checkAwsHealth, probeAwsExists, readAwsLogs } from './health.js';
import { probePermissions } from './permissions.js';
import { flattenOutputs, rootConfig, stateKeyFor } from './stacks.js';

export interface AwsAdapterOptions {
  resolveExternalId: ExternalIdResolver;
  stsFactory?: StsClientFactory;
  /** OpenTofu runner. Without it, the adapter can validate targets but not provision. */
  runner?: TofuRunner;
  /**
   * Emulator endpoint as reachable from this process and its runner (e.g. http://ministack:4566
   * inside Docker Compose). Overrides the target's endpointUrl/runnerEndpointUrl; links shown
   * to users keep the target's own (browser-reachable) endpoint.
   */
  emulatorEndpoint?: string;
}

/**
 * AWS adapter. Resources are provisioned with OpenTofu modules, one isolated state per resource
 * (blast radius = one resource), executed in a throwaway runner container. Actual state and
 * health are read back through AWS APIs. The same code targets real AWS (cross-account
 * AssumeRole) and local emulators such as MiniStack (endpoint override, test credentials).
 */
export class AwsAdapter implements CloudProviderAdapter {
  readonly provider = 'aws' as const;
  readonly simulated = false;
  private readonly creds: AwsCredentialProvider;
  private readonly runner?: TofuRunner;
  private readonly stsFactory: StsClientFactory;

  private readonly emulatorEndpoint?: string;

  constructor(opts: AwsAdapterOptions) {
    this.stsFactory = opts.stsFactory ?? ((region) => new STSClient({ region }));
    this.creds = new AwsCredentialProvider(opts.resolveExternalId, this.stsFactory);
    this.runner = opts.runner;
    this.emulatorEndpoint = opts.emulatorEndpoint;
  }

  /** Applies the process-level emulator endpoint override, if any. */
  private effective(ctx: ProviderContext): ProviderContext {
    const cfg = awsConfig(ctx.target);
    if (!this.emulatorEndpoint || !isEmulator(cfg)) return ctx;
    const config = { ...cfg, publicEndpointUrl: cfg.publicEndpointUrl ?? cfg.endpointUrl, endpointUrl: this.emulatorEndpoint, runnerEndpointUrl: this.emulatorEndpoint };
    return { ...ctx, target: { ...ctx.target, config: config as unknown as Record<string, unknown> } };
  }

  capabilities(_target: CloudTarget): CloudCapability[] {
    return AWS_CAPABILITIES;
  }

  async validateTarget(rawCtx: ProviderContext, opts: ValidateTargetOptions = {}): Promise<TargetValidationResult> {
    const ctx = this.effective(rawCtx);
    const checks: TargetValidationCheck[] = [];
    const validatedAt = new Date().toISOString();
    const cfg = awsConfig(ctx.target);
    const emulator = isEmulator(cfg);

    if (!cfg.accountId || !/^\d{12}$/.test(cfg.accountId)) {
      checks.push({ name: 'Account id', status: 'error', message: 'accountId must be a 12-digit AWS account id.' });
    }
    if (!emulator && (!cfg.roleArn || !/^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/.test(cfg.roleArn))) {
      checks.push({ name: 'Deployment role', status: 'error', message: 'roleArn must be an IAM role ARN.' });
    }
    if (!ctx.target.allowedRegions.includes(ctx.region)) {
      checks.push({ name: 'Region', status: 'error', message: `${ctx.region} is not allowed for this target.` });
    }
    if (checks.length > 0) return { ok: false, checks, validatedAt };

    let identity: string | undefined;
    try {
      const clientCfg = await this.creds.clientConfig(ctx);
      checks.push(
        emulator
          ? { name: 'Credentials', status: 'ok', message: `Local emulator (${cfg.emulator}) at ${cfg.endpointUrl}.` }
          : { name: 'Assume deployment role', status: 'ok', message: 'Role assumed with short-lived credentials.' },
      );
      const who = await new STSClient(clientCfg).send(new GetCallerIdentityCommand({}), { abortSignal: ctx.signal });
      identity = who.Account;
      checks.push(
        who.Account === cfg.accountId
          ? { name: 'Account access', status: 'ok', message: `Connected to account ${who.Account}.` }
          : { name: 'Account access', status: 'error', message: `Credentials resolved to account ${who.Account}, expected ${cfg.accountId}.` },
      );
      checks.push(await this.stateBucketCheck(ctx));
      // Emulators allow everything; on real AWS, simulate the role against what its modules call.
      if (!emulator && cfg.roleArn) {
        checks.push(
          ...(await probePermissions({
            iam: new IAMClient(clientCfg),
            roleArn: cfg.roleArn,
            stateBucket: stateBucketFor(cfg, ctx.region),
            serviceKinds: opts.serviceKinds,
            signal: ctx.signal,
          })),
        );
      }
    } catch (err) {
      checks.push({ name: emulator ? 'Emulator reachable' : 'Assume deployment role', status: 'error', message: safeAwsMessage(err) });
    }

    checks.push(
      this.runner
        ? { name: 'Provisioning runner', status: 'ok', message: 'OpenTofu runner configured.' }
        : { name: 'Provisioning runner', status: 'skipped', message: 'No OpenTofu runner in this process (validation only).' },
    );
    return { ok: checks.every((c) => c.status !== 'error' && c.status !== 'missing'), checks, validatedAt, identity };
  }

  async ensureResource(rawCtx: ProviderContext, req: ResourceRequest): Promise<ResourceResult> {
    const ctx = this.effective(rawCtx);
    const runner = this.requireRunner();
    if (req.spec.autoscaling && isEmulator(awsConfig(ctx.target))) {
      ctx.log?.('warn', `${req.resourceId}: autoscaling is not emulated; running ${String(req.spec.replicas ?? 1)} fixed replica(s).`);
    }
    await this.ensureStateBucket(ctx);
    const config = rootConfig(ctx, req);
    const stack = await this.stack(ctx, req.name, config);
    try {
      const result = await runner.apply(stack);
      // Keep the exact configuration beside its state so destroy never depends on a stale template.
      await this.putObject(ctx, `${stateKeyFor(req.name)}.config.json`, JSON.stringify(config));
      const outputs = flattenOutputs(result.outputs.all);
      const unchanged = result.changes.add + result.changes.change + result.changes.remove === 0;
      return { providerResourceId: providerIdFrom(req.serviceKind, outputs), outputs, unchanged };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async planResource(rawCtx: ProviderContext, req: ResourceRequest): Promise<ResourcePlan> {
    const ctx = this.effective(rawCtx);
    const runner = this.requireRunner();
    try {
      const plan = await runner.plan(await this.stack(ctx, req.name, rootConfig(ctx, req)));
      return { ...plan, destructive: isDestructivePlan(plan.actions) };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async detectDrift(rawCtx: ProviderContext, req: ResourceRequest): Promise<DriftChange[]> {
    const ctx = this.effective(rawCtx);
    const runner = this.requireRunner();
    try {
      return await runner.drift(await this.stack(ctx, req.name, rootConfig(ctx, req)));
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async deleteResource(rawCtx: ProviderContext, res: ResourceIdentifier): Promise<void> {
    const ctx = this.effective(rawCtx);
    const runner = this.requireRunner();
    const raw = await this.getObject(ctx, `${stateKeyFor(res.name)}.config.json`);
    if (!raw) return; // never applied, or already destroyed: idempotent
    try {
      await runner.destroy(await this.stack(ctx, res.name, JSON.parse(raw) as Record<string, unknown>));
      await this.deleteObject(ctx, `${stateKeyFor(res.name)}.config.json`);
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async getResource(rawCtx: ProviderContext, res: ResourceIdentifier): Promise<ResourceState> {
    const ctx = this.effective(rawCtx);
    const raw = await this.getObject(ctx, stateKeyFor(res.name));
    if (!raw) return { exists: false, outputs: {} };
    const state = JSON.parse(raw) as { resources?: { mode: string }[]; outputs?: { all?: { value: unknown } } };
    const exists = (state.resources ?? []).some((r) => r.mode === 'managed');
    // observedSpecHash stays undefined: drift is checked with a refresh-only plan, not on every read.
    return { exists, outputs: exists ? flattenOutputs(state.outputs?.all?.value) : {} };
  }

  async checkHealth(rawCtx: ProviderContext, res: ResourceIdentifier): Promise<HealthResult> {
    const ctx = this.effective(rawCtx);
    const state = await this.getResource(ctx, res);
    if (!state.exists) return { state: 'UNHEALTHY', message: 'Resource does not exist (no managed state).', checkedAt: new Date().toISOString() };
    try {
      return await checkAwsHealth(res.serviceKind, state.outputs, await this.creds.clientConfig(ctx), ctx.signal);
    } catch (err) {
      return { state: 'UNHEALTHY', message: safeAwsMessage(err), checkedAt: new Date().toISOString() };
    }
  }

  async probeExists(rawCtx: ProviderContext, res: ResourceIdentifier): Promise<boolean | undefined> {
    const ctx = this.effective(rawCtx);
    const state = await this.getResource(ctx, res);
    if (!state.exists) return false;
    return probeAwsExists(res.serviceKind, state.outputs, await this.creds.clientConfig(ctx), ctx.signal);
  }

  async getLogs(rawCtx: ProviderContext, res: ResourceIdentifier, limit: number): Promise<LogLine[]> {
    const ctx = this.effective(rawCtx);
    const state = await this.getResource(ctx, res);
    return state.exists ? readAwsLogs(state.outputs, await this.creds.clientConfig(ctx), limit, ctx.signal) : [];
  }

  // ───────────────────────── state bucket & runner plumbing ─────────────────────────

  private requireRunner(): TofuRunner {
    if (!this.runner) {
      throw new ProviderError('AWS_RUNNER_NOT_CONFIGURED', 'No OpenTofu runner is configured in this process; AWS resources are provisioned by the worker.', 'DEPLOYMENT_ERROR', 'aws');
    }
    return this.runner;
  }

  private async stack(ctx: ProviderContext, name: string, config: Record<string, unknown>): Promise<TofuStack> {
    const c = await this.creds.get(ctx);
    return {
      stateKey: `${ctx.target.id}/${ctx.region}/${stateKeyFor(name)}`,
      config,
      env: {
        AWS_ACCESS_KEY_ID: c.accessKeyId,
        AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
        ...(c.sessionToken ? { AWS_SESSION_TOKEN: c.sessionToken } : {}),
        AWS_REGION: ctx.region,
      },
      signal: ctx.signal,
      onLog: (l) => ctx.log?.(l.level, l.message),
    };
  }

  private async s3(ctx: ProviderContext) {
    return new S3Client({ ...(await this.creds.clientConfig(ctx)), forcePathStyle: true });
  }

  private async stateBucketCheck(ctx: ProviderContext): Promise<TargetValidationCheck> {
    const bucket = stateBucketFor(awsConfig(ctx.target), ctx.region);
    try {
      await this.ensureStateBucket(ctx);
      return { name: 'State bucket', status: 'ok', message: `OpenTofu state in s3://${bucket} (encrypted, locked).` };
    } catch (err) {
      return { name: 'State bucket', status: 'missing', message: `s3://${bucket}: ${safeAwsMessage(err)}` };
    }
  }

  /** Real AWS: the bucket must already exist. Emulators: created on first use. */
  private async ensureStateBucket(ctx: ProviderContext): Promise<void> {
    const cfg = awsConfig(ctx.target);
    const bucket = stateBucketFor(cfg, ctx.region);
    const s3 = await this.s3(ctx);
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: ctx.signal });
    } catch (err) {
      if (!isEmulator(cfg)) {
        throw new ProviderError('AWS_STATE_BUCKET_MISSING', `State bucket ${bucket} is not accessible. Create it (versioned, encrypted) or set stateBucket on the target.`, 'VALIDATION_ERROR', 'aws');
      }
      if ((err as { name?: string }).name !== 'NotFound' && (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw err;
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    }
  }

  private async putObject(ctx: ProviderContext, key: string, body: string) {
    const bucket = stateBucketFor(awsConfig(ctx.target), ctx.region);
    await (await this.s3(ctx)).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json', ServerSideEncryption: 'AES256' }));
  }

  private async getObject(ctx: ProviderContext, key: string): Promise<string | null> {
    const bucket = stateBucketFor(awsConfig(ctx.target), ctx.region);
    try {
      const r = await (await this.s3(ctx)).send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: ctx.signal });
      return (await r.Body?.transformToString()) ?? null;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.name === 'NoSuchBucket' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  private async deleteObject(ctx: ProviderContext, key: string) {
    const bucket = stateBucketFor(awsConfig(ctx.target), ctx.region);
    await (await this.s3(ctx)).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

function providerIdFrom(kind: string, out: Record<string, unknown>): string {
  const id = out.service_arn ?? out.arn ?? out.vpc_id ?? out.repository_arn ?? out.queue_arn ?? out.identifier ?? out.replication_group_id ?? out.bucket ?? out.fqdn;
  return String(id ?? kind);
}

/** Maps runner failures to failure classes that drive retries and incidents. */
function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof TofuError) {
    const text = `${err.message} ${err.diagnostics.join(' ')}`;
    const failureClass =
      err.kind === 'timeout' ? 'TIMEOUT'
      : err.kind === 'cancelled' ? 'UNKNOWN'
      : /Throttl|Rate exceeded|TooManyRequests|SlowDown/i.test(text) ? 'PROVIDER_RATE_LIMIT'
      : /AccessDenied|UnauthorizedOperation|not authorized|InvalidClientTokenId|ExpiredToken/i.test(text) ? 'AUTHORIZATION_ERROR'
      : /LimitExceeded|QuotaExceeded|limit exceeded/i.test(text) ? 'QUOTA_EXCEEDED'
      : /AlreadyExists|already exists|Conflict|state lock|Error acquiring the state lock/i.test(text) ? 'RESOURCE_CONFLICT'
      : /timeout|connection reset|EOF|dial tcp|no such host/i.test(text) ? 'NETWORK_ERROR'
      : 'DEPLOYMENT_ERROR';
    return new ProviderError(err.kind === 'cancelled' ? 'CANCELLED' : 'AWS_TOFU_FAILED', err.message, failureClass, 'aws', { diagnostics: err.diagnostics.slice(0, 5) });
  }
  return new ProviderError('AWS_UNEXPECTED', safeAwsMessage(err), 'UNKNOWN', 'aws');
}

/** AWS error messages can echo ARNs and request ids; keep only the error name and a short message. */
/**
 * Replacements that are how AWS rolls changes out, not losses: a task definition is immutable,
 * so every image or size change registers a new revision while the service keeps running.
 */
const ROUTINE_REPLACEMENTS = /(^|\.)aws_ecs_task_definition\.[^.]+$/;

/** A plan needs production approval when it deletes or replaces something that matters. */
export function isDestructivePlan(actions: { address: string; action: string }[]): boolean {
  return actions.some((a) => a.action === 'delete' || (a.action === 'replace' && !ROUTINE_REPLACEMENTS.test(a.address)));
}

export function safeAwsMessage(err: unknown): string {
  const e = err as { name?: string; message?: string };
  const name = e.name ?? 'Error';
  if (name === 'AccessDenied' || name === 'AccessDeniedException') {
    return 'Access denied assuming the deployment role. Check the trust policy and external id.';
  }
  return `${name}: ${(e.message ?? 'unknown error').replace(/arn:aws[^\s"']*/g, '<arn>').slice(0, 200)}`;
}
