// SPDX-License-Identifier: AGPL-3.0-only
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import type { TargetValidationCheck } from '@orkstage/cloud-core';

/**
 * The IAM actions each module in infra/tofu/modules/aws needs to create, update and delete its
 * resources. Not exhaustive (OpenTofu also reads/describes), but these are the calls a scoped
 * deployment role most often lacks; keep them in sync when a module gains a resource type.
 */
export const REQUIRED_ACTIONS: Record<string, string[]> = {
  network: [
    'ec2:CreateVpc', 'ec2:DeleteVpc', 'ec2:CreateSubnet', 'ec2:DeleteSubnet', 'ec2:CreateInternetGateway', 'ec2:AttachInternetGateway',
    'ec2:AllocateAddress', 'ec2:CreateNatGateway', 'ec2:DeleteNatGateway', 'ec2:CreateRouteTable', 'ec2:CreateRoute', 'ec2:AssociateRouteTable',
    'ec2:CreateSecurityGroup', 'ec2:AuthorizeSecurityGroupIngress', 'ec2:CreateTags',
  ],
  'container-registry': ['ecr:CreateRepository', 'ecr:DeleteRepository', 'ecr:PutLifecyclePolicy', 'ecr:TagResource'],
  'compute.container-service': [
    'ecs:CreateCluster', 'ecs:DeleteCluster', 'ecs:RegisterTaskDefinition', 'ecs:DeregisterTaskDefinition', 'ecs:CreateService', 'ecs:UpdateService',
    'ecs:DeleteService', 'ecs:PutClusterCapacityProviders', 'ecs:CreateCapacityProvider', 'iam:CreateRole', 'iam:DeleteRole', 'iam:PutRolePolicy',
    'iam:AttachRolePolicy', 'iam:PassRole', 'iam:CreateInstanceProfile', 'iam:AddRoleToInstanceProfile', 'logs:CreateLogGroup', 'logs:DeleteLogGroup',
    'logs:PutRetentionPolicy', 'ec2:CreateLaunchTemplate', 'autoscaling:CreateAutoScalingGroup', 'ec2:CreateSecurityGroup',
    'application-autoscaling:RegisterScalableTarget', 'application-autoscaling:PutScalingPolicy', 'application-autoscaling:DeregisterScalableTarget',
  ],
  'database.postgresql': [
    'rds:CreateDBInstance', 'rds:ModifyDBInstance', 'rds:DeleteDBInstance', 'rds:CreateDBSubnetGroup', 'rds:AddTagsToResource',
    'secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:DeleteSecret', 'ec2:CreateSecurityGroup',
  ],
  'cache.redis': [
    'elasticache:CreateReplicationGroup', 'elasticache:ModifyReplicationGroup', 'elasticache:DeleteReplicationGroup',
    'elasticache:CreateCacheSubnetGroup', 'ec2:CreateSecurityGroup',
  ],
  queue: ['sqs:CreateQueue', 'sqs:SetQueueAttributes', 'sqs:DeleteQueue', 'sqs:TagQueue'],
  'object-storage': [
    's3:CreateBucket', 's3:DeleteBucket', 's3:PutBucketVersioning', 's3:PutEncryptionConfiguration', 's3:PutBucketPublicAccessBlock',
    's3:PutLifecycleConfiguration', 's3:PutBucketTagging', 'iam:CreateUser', 'iam:PutUserPolicy', 'iam:CreateAccessKey',
    'secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue',
  ],
  ingress: [
    'elasticloadbalancing:CreateLoadBalancer', 'elasticloadbalancing:DeleteLoadBalancer', 'elasticloadbalancing:CreateTargetGroup',
    'elasticloadbalancing:CreateListener', 'elasticloadbalancing:CreateRule', 'elasticloadbalancing:AddTags', 'ec2:CreateSecurityGroup',
  ],
  dns: [
    'route53:CreateHostedZone', 'route53:ChangeResourceRecordSets', 'route53:DeleteHostedZone', 'acm:RequestCertificate',
    'acm:DeleteCertificate', 'acm:DescribeCertificate', 'elasticloadbalancing:CreateListener',
  ],
};

/** Every run needs the OpenTofu state bucket (S3 backend with lock files). */
const STATE_ACTIONS = ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'];

type IamLike = Pick<IAMClient, 'send'>;

/**
 * Simulates the deployment role against the actions its services need (iam:SimulatePrincipalPolicy,
 * which the role must be allowed to call on itself). With `serviceKinds` (a deployment), a missing
 * action is a failing check; without (the "Validate" button), it is a warning per service, since a
 * target may legitimately be scoped to fewer services.
 */
export async function probePermissions(opts: {
  iam: IamLike;
  roleArn: string;
  stateBucket: string;
  serviceKinds?: string[];
  signal?: AbortSignal;
}): Promise<TargetValidationCheck[]> {
  const kinds = (opts.serviceKinds ?? Object.keys(REQUIRED_ACTIONS)).filter((k) => REQUIRED_ACTIONS[k]);
  const strict = opts.serviceKinds !== undefined;
  const wanted = new Map<string, string[]>([['state', STATE_ACTIONS], ...kinds.map((k) => [k, REQUIRED_ACTIONS[k]!] as [string, string[]])]);
  const actions = [...new Set([...wanted.values()].flat())];

  const denied = new Set<string>();
  try {
    for (let i = 0; i < actions.length; i += 50) {
      let marker: string | undefined;
      do {
        const out = await opts.iam.send(
          new SimulatePrincipalPolicyCommand({ PolicySourceArn: opts.roleArn, ActionNames: actions.slice(i, i + 50), ResourceArns: ['*'], Marker: marker }),
          { abortSignal: opts.signal },
        );
        for (const r of out.EvaluationResults ?? []) if (r.EvalDecision !== 'allowed' && r.EvalActionName) denied.add(r.EvalActionName);
        marker = out.IsTruncated ? out.Marker : undefined;
      } while (marker);
    }
  } catch (err) {
    const name = (err as { name?: string }).name ?? 'Error';
    return [{
      name: 'Permissions',
      status: 'skipped',
      message: name === 'AccessDenied' || name === 'AccessDeniedException'
        ? 'Not checked: allow the deployment role iam:SimulatePrincipalPolicy on itself to verify permissions before deploying.'
        : `Not checked (${name}).`,
    }];
  }

  const checks: TargetValidationCheck[] = [];
  for (const [kind, list] of wanted) {
    const missing = list.filter((a) => denied.has(a));
    if (missing.length === 0) continue;
    const label = kind === 'state' ? `the state bucket ${opts.stateBucket}` : kind;
    checks.push({
      name: `Permissions: ${kind}`,
      status: strict || kind === 'state' ? 'missing' : 'warn',
      message: `The deployment role is missing ${missing.join(', ')} (needed for ${label}).`,
    });
  }
  if (checks.length === 0) {
    checks.push({ name: 'Permissions', status: 'ok', message: `${actions.length} required actions allowed for ${strict ? kinds.join(', ') : 'all supported services'}.` });
  }
  return checks;
}
