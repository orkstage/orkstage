import type { CloudTarget } from '@co/cloud-core';

/** Non-secret AWS target configuration stored on the cloud target. */
export interface AwsTargetConfig {
  accountId: string;
  /** Role in the customer account that the platform assumes (spec §11). Not used for emulators. */
  roleArn?: string;
  /** Local emulator flavour. When set, static test credentials and endpoint overrides are used. */
  emulator?: 'ministack';
  /** AWS API endpoint as reached by the control plane (emulator only), e.g. http://localhost:4566. */
  endpointUrl?: string;
  /** Same endpoint as reached from the OpenTofu runner container, e.g. http://ministack:4566. */
  runnerEndpointUrl?: string;
  /** Endpoint as reached from a browser (links shown to users). Defaults to endpointUrl. */
  publicEndpointUrl?: string;
  /** S3 bucket holding OpenTofu state. Must exist (versioned, encrypted) on real AWS. */
  stateBucket?: string;
  /** Platform DNS zone for instance subdomains, e.g. apps.example.com. */
  dnsZone?: string;
  /** Create the DNS zone when missing (emulator convenience; real zones are pre-provisioned). */
  createDnsZone?: boolean;
  /** AMI for ECS on EC2 capacity; empty = latest ECS-optimized AMI from SSM. */
  ecsAmiId?: string;
}

export function awsConfig(target: CloudTarget): AwsTargetConfig {
  return target.config as unknown as AwsTargetConfig;
}

export function isEmulator(cfg: AwsTargetConfig): boolean {
  return Boolean(cfg.emulator && cfg.endpointUrl);
}

export function stateBucketFor(cfg: AwsTargetConfig, region: string): string {
  return cfg.stateBucket ?? `orkstage-tfstate-${cfg.accountId}-${region}`;
}

/** Services whose endpoints are overridden for emulators (SDK and OpenTofu provider). */
export const EMULATED_SERVICES = [
  'acm', 'autoscaling', 'cloudwatch', 'ec2', 'ecr', 'ecs', 'elasticache', 'elbv2', 'iam', 'logs',
  'rds', 'route53', 's3', 'secretsmanager', 'sqs', 'ssm', 'sts',
] as const;
