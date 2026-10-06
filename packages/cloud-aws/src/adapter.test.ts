import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { CloudTarget, ProviderContext, ResourceRequest } from '@co/cloud-core';
import { describe, expect, it, vi } from 'vitest';
import { AwsAdapter, isDestructivePlan } from './adapter.js';
import { isAwsNotFound } from './health.js';
import { probePermissions, REQUIRED_ACTIONS } from './permissions.js';
import { moduleInputs, rootConfig } from './stacks.js';

const target: CloudTarget = {
  id: 't1',
  provider: 'aws',
  name: 'Acme prod',
  config: { accountId: '123456789012', roleArn: 'arn:aws:iam::123456789012:role/co-deploy' },
  credentialRef: 'secret://targets/t1/external-id',
  allowedRegions: ['us-east-1'],
  defaultRegion: 'us-east-1',
};
const ctx: ProviderContext = { target, region: 'us-east-1', correlationId: 'c1' };

const emulatorCtx: ProviderContext = {
  ...ctx,
  target: {
    ...target,
    config: { accountId: '000000000000', emulator: 'ministack', endpointUrl: 'http://localhost:4566', runnerEndpointUrl: 'http://ministack:4566' },
  },
};

const network = { kind: 'network', vpc_id: 'vpc-1', cidr: '10.20.0.0/16', public_subnet_ids: 'subnet-a,subnet-b', private_subnet_ids: 'subnet-c,subnet-d', private_egress: false };
const request = (over: Partial<ResourceRequest>): ResourceRequest => ({
  resourceId: 'api',
  serviceKind: 'compute.container-service',
  capability: 'ecs-fargate',
  name: 'co-acme-prod-api',
  tags: { 'platform:managed': 'true', 'platform:environment': 'production' },
  spec: { image: 'registry/api@sha256:abc', cpu: 0.5, memoryMiB: 1024, replicas: 2, port: 8080 },
  dependencyOutputs: { network },
  idempotencyKey: 'k',
  ...over,
});

describe('AwsAdapter.validateTarget', () => {
  it('rejects malformed configuration without calling AWS', async () => {
    const factory = vi.fn();
    const adapter = new AwsAdapter({ resolveExternalId: async () => 'x', stsFactory: factory });
    const result = await adapter.validateTarget({ ...ctx, target: { ...target, config: { accountId: '12', roleArn: 'nope' } } });
    expect(result.ok).toBe(false);
    expect(result.checks.map((c) => c.name)).toEqual(['Account id', 'Deployment role']);
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects regions the target does not allow', async () => {
    const adapter = new AwsAdapter({ resolveExternalId: async () => 'x', stsFactory: vi.fn() });
    const result = await adapter.validateTarget({ ...ctx, region: 'eu-west-1' });
    expect(result.checks[0]).toMatchObject({ name: 'Region', status: 'error' });
  });

  it('passes the external id and reports access denied without leaking details', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('User arn:aws:iam::999:user/x is not authorized'), { name: 'AccessDenied' }));
    const adapter = new AwsAdapter({ resolveExternalId: async (ref) => `ext-for-${ref}`, stsFactory: () => ({ send }) as never });
    const result = await adapter.validateTarget(ctx);
    const cmd = send.mock.calls[0]![0] as AssumeRoleCommand;
    expect(cmd.input.ExternalId).toBe('ext-for-secret://targets/t1/external-id');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.checks)).not.toMatch(/arn:aws/);
  });

  it('does not provision without a runner (API process)', async () => {
    const adapter = new AwsAdapter({ resolveExternalId: async () => 'x' });
    await expect(adapter.ensureResource(ctx, request({}))).rejects.toMatchObject({ code: 'AWS_RUNNER_NOT_CONFIGURED' });
  });
});

describe('OpenTofu stack rendering', () => {
  it('wires services to network, ingress target group and dependency references', () => {
    const { module, inputs } = moduleInputs(ctx, request({
      dependencyOutputs: {
        network,
        ingress: { kind: 'ingress', target_groups: JSON.stringify({ api: 'arn:tg' }), lb_sg_id: 'sg-lb' },
        database: { kind: 'database.postgresql', host: 'db.internal', port: 5432, secret_ref: 'arn:secret' },
      },
    }));
    expect(module).toBe('container-service');
    expect(inputs).toMatchObject({
      capacity: 'FARGATE',
      target_group_arn: 'arn:tg',
      subnet_ids: ['subnet-a', 'subnet-b'],
      assign_public_ip: true,
      environment: { DATABASE_HOST: 'db.internal', DATABASE_PORT: '5432', PORT: '8080' },
      secrets: { DATABASE_CREDENTIALS: 'arn:secret' },
    });
  });

  it('keeps names within provider limits', () => {
    const { inputs } = moduleInputs(ctx, request({ serviceKind: 'ingress', capability: 'alb', name: 'co-a-very-long-tenant-name-production-ingress', spec: { routes: [{ service: 'api', pathPrefix: '/', port: 8080, healthCheckPath: '/health' }] } }));
    expect(String(inputs.name).length).toBeLessThanOrEqual(32);
  });

  it('points backend and provider at the emulator from inside the runner', () => {
    const cfg = rootConfig(emulatorCtx, request({ serviceKind: 'queue', capability: 'sqs', spec: {} })) as {
      terraform: { backend: { s3: { endpoints: { s3: string }; key: string } } };
      provider: { aws: { endpoints: Record<string, string>; default_tags: { tags: Record<string, string> } } };
    };
    expect(cfg.terraform.backend.s3.endpoints.s3).toBe('http://ministack:4566');
    expect(cfg.terraform.backend.s3.key).toBe('orkstage/co-acme-prod-api.tfstate');
    expect(cfg.provider.aws.endpoints.ecs).toBe('http://ministack:4566');
    expect(cfg.provider.aws.default_tags.tags['platform:managed']).toBe('true');
  });

  it('never renders secret values into configuration', () => {
    const cfg = JSON.stringify(rootConfig(ctx, request({ serviceKind: 'database.postgresql', capability: 'rds-postgres', spec: { size: 'small', storageGiB: 20, backup: { enabled: true, retentionDays: 7 } } })));
    expect(cfg).not.toMatch(/password/i);
  });

  it('rejects implementations without a module', () => {
    expect(() => moduleInputs(ctx, request({ capability: 'ecs-managed-instances' }))).toThrow(/not implemented/);
  });
});

describe('isAwsNotFound', () => {
  it('recognises not-found errors across services', () => {
    for (const name of ['InvalidVpcID.NotFound', 'DBInstanceNotFoundFault', 'RepositoryNotFoundException', 'ClusterNotFoundException', 'NoSuchHostedZone', 'AWS.SimpleQueueService.NonExistentQueue']) {
      expect(isAwsNotFound({ name })).toBe(true);
    }
    expect(isAwsNotFound({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })).toBe(true);
  });

  it('treats throttling and auth failures as unknown, not missing', () => {
    expect(isAwsNotFound({ name: 'ThrottlingException', $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(isAwsNotFound({ name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } })).toBe(false);
  });
});

describe('isDestructivePlan', () => {
  it('treats task definition revisions as routine, other replacements and deletes as destructive', () => {
    expect(isDestructivePlan([{ address: 'module.resource.aws_ecs_task_definition.this', action: 'replace' }, { address: 'module.resource.aws_ecs_service.this', action: 'update' }])).toBe(false);
    expect(isDestructivePlan([{ address: 'module.resource.aws_security_group.service', action: 'replace' }])).toBe(true);
    expect(isDestructivePlan([{ address: 'module.resource.aws_db_instance.this', action: 'delete' }])).toBe(true);
  });
});

describe('probePermissions', () => {
  const iamDenying = (denied: string[], calls: string[][] = []) => ({
    send: (async (cmd: { input: { ActionNames: string[] } }) => {
      calls.push(cmd.input.ActionNames);
      return { EvaluationResults: cmd.input.ActionNames.map((a) => ({ EvalActionName: a, EvalDecision: denied.includes(a) ? 'implicitDeny' : 'allowed' })) };
    }) as never,
  });
  const base = { roleArn: 'arn:aws:iam::123456789012:role/co-deploy', stateBucket: 'orkstage-state' };

  it('fails a deployment that needs a denied action, naming the service and actions', async () => {
    const checks = await probePermissions({ ...base, iam: iamDenying(['rds:CreateDBInstance']), serviceKinds: ['database.postgresql', 'queue'] });
    expect(checks).toEqual([{ name: 'Permissions: database.postgresql', status: 'missing', message: expect.stringContaining('rds:CreateDBInstance') }]);
  });

  it('only warns about unused services when validating a target without a deployment', async () => {
    const checks = await probePermissions({ ...base, iam: iamDenying(['elasticache:CreateReplicationGroup']) });
    expect(checks).toEqual([expect.objectContaining({ name: 'Permissions: cache.redis', status: 'warn' })]);
  });

  it('always requires the state bucket actions, in batches of at most 50', async () => {
    const calls: string[][] = [];
    const checks = await probePermissions({ ...base, iam: iamDenying(['s3:PutObject'], calls) });
    expect(checks[0]).toMatchObject({ name: 'Permissions: state', status: 'missing' });
    expect(calls.every((c) => c.length <= 50)).toBe(true);
    expect(new Set(calls.flat()).size).toBe(new Set(['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket', ...Object.values(REQUIRED_ACTIONS).flat()]).size);
  });

  it('skips with guidance when the role may not simulate itself', async () => {
    const iam = { send: (async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); }) as never };
    const checks = await probePermissions({ ...base, iam, serviceKinds: ['queue'] });
    expect(checks).toEqual([{ name: 'Permissions', status: 'skipped', message: expect.stringContaining('iam:SimulatePrincipalPolicy') }]);
  });

  it('reports ok when everything is allowed', async () => {
    const checks = await probePermissions({ ...base, iam: iamDenying([]), serviceKinds: ['queue'] });
    expect(checks).toEqual([{ name: 'Permissions', status: 'ok', message: expect.stringContaining('queue') }]);
  });
});

describe('deployment role template (infra/aws/orkstage-deployment-role.yaml)', () => {
  it('grants every action the permission probe requires', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../../../infra/aws/orkstage-deployment-role.yaml', import.meta.url), 'utf8');
    // Action entries: `- svc:Action`, `Action: svc:*` or inline lists `[svc:A, svc:B]`.
    const granted = [...text.matchAll(/(?:^\s*-\s*|Action:\s*\[?\s*|,\s*)([a-z0-9-]+:[A-Za-z*]+)(?=[\s,\]]|$)/gm)].map((m) => m[1]!);
    const patterns = granted.map((g) => new RegExp(`^${g.replace(/\*/g, '.*')}$`));
    const required = [...new Set([...Object.values(REQUIRED_ACTIONS).flat(), 's3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket', 'iam:SimulatePrincipalPolicy'])];
    expect(required.filter((a) => !patterns.some((p) => p.test(a)))).toEqual([]);
  });
});
