import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeRepositoriesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { DescribeServicesCommand, ECSClient } from '@aws-sdk/client-ecs';
import { DescribeReplicationGroupsCommand, ElastiCacheClient } from '@aws-sdk/client-elasticache';
import {
  DescribeLoadBalancersCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { GetHostedZoneCommand, Route53Client } from '@aws-sdk/client-route-53';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { HealthResult, LogLine, ResourceOutputs } from '@co/cloud-core';
import type { HealthState } from '@co/domain';

type ClientConfig = Record<string, unknown> & { region: string };

const result = (state: HealthState, message: string, started: number): HealthResult => ({
  state,
  message,
  latencyMs: Date.now() - started,
  checkedAt: new Date().toISOString(),
});

/**
 * Reads actual state from AWS APIs for one resource, using the identifiers recorded in its
 * OpenTofu outputs. Works the same against real AWS and emulators (endpoint override).
 */
export async function checkAwsHealth(kind: string, out: ResourceOutputs, cfg: ClientConfig, signal?: AbortSignal): Promise<HealthResult> {
  const started = Date.now();
  const opts = { abortSignal: signal };
  switch (kind) {
    case 'network': {
      const r = await new EC2Client(cfg).send(new DescribeVpcsCommand({ VpcIds: [String(out.vpc_id)] }), opts);
      const state = r.Vpcs?.[0]?.State;
      return result(state === 'available' ? 'HEALTHY' : 'DEGRADED', `VPC ${state ?? 'unknown'}`, started);
    }
    case 'container-registry': {
      const name = String(out.repository_uri).split('/').slice(1).join('/');
      await new ECRClient(cfg).send(new DescribeRepositoriesCommand({ repositoryNames: [name] }), opts);
      return result('HEALTHY', 'Repository available', started);
    }
    case 'compute.container-service': {
      const r = await new ECSClient(cfg).send(new DescribeServicesCommand({ cluster: String(out.cluster_name), services: [String(out.service_name)] }), opts);
      const svc = r.services?.[0];
      const desired = svc?.desiredCount ?? 0;
      const running = svc?.runningCount ?? 0;
      const state: HealthState = desired > 0 && running >= desired ? 'HEALTHY' : running > 0 ? 'DEGRADED' : 'UNHEALTHY';
      return result(state, `${running}/${desired} task(s) running`, started);
    }
    case 'database.postgresql': {
      const r = await new RDSClient(cfg).send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: String(out.identifier) }), opts);
      const status = r.DBInstances?.[0]?.DBInstanceStatus ?? 'unknown';
      const state: HealthState = status === 'available' ? 'HEALTHY' : ['backing-up', 'modifying', 'maintenance', 'upgrading'].includes(status) ? 'DEGRADED' : 'UNHEALTHY';
      return result(state, `RDS ${status}`, started);
    }
    case 'cache.redis': {
      const r = await new ElastiCacheClient(cfg).send(new DescribeReplicationGroupsCommand({ ReplicationGroupId: String(out.replication_group_id) }), opts);
      const status = r.ReplicationGroups?.[0]?.Status ?? 'unknown';
      return result(status === 'available' ? 'HEALTHY' : status === 'modifying' ? 'DEGRADED' : 'UNHEALTHY', `Cache ${status}`, started);
    }
    case 'queue': {
      await new SQSClient(cfg).send(new GetQueueAttributesCommand({ QueueUrl: String(out.queue_url), AttributeNames: ['QueueArn'] }), opts);
      return result('HEALTHY', 'Queue reachable', started);
    }
    case 'object-storage': {
      await new S3Client({ ...cfg, forcePathStyle: true }).send(new HeadBucketCommand({ Bucket: String(out.bucket) }), opts);
      return result('HEALTHY', 'Bucket reachable', started);
    }
    case 'ingress': {
      const elb = new ElasticLoadBalancingV2Client(cfg);
      const lb = await elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [String(out.arn)] }), opts);
      const lbState = lb.LoadBalancers?.[0]?.State?.Code ?? 'unknown';
      if (lbState !== 'active') return result(lbState === 'provisioning' ? 'DEGRADED' : 'UNHEALTHY', `Load balancer ${lbState}`, started);
      let unhealthy = 0;
      let total = 0;
      for (const arn of Object.values(JSON.parse(String(out.target_groups ?? '{}')) as Record<string, string>)) {
        const th = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: arn }), opts);
        for (const t of th.TargetHealthDescriptions ?? []) {
          total++;
          if (t.TargetHealth?.State !== 'healthy') unhealthy++;
        }
      }
      if (total === 0) return result('DEGRADED', 'Load balancer active, no registered targets yet', started);
      return result(unhealthy === 0 ? 'HEALTHY' : unhealthy < total ? 'DEGRADED' : 'UNHEALTHY', `${total - unhealthy}/${total} target(s) healthy`, started);
    }
    case 'dns': {
      await new Route53Client(cfg).send(new GetHostedZoneCommand({ Id: String(out.zone_id) }), opts);
      return result('HEALTHY', `${out.fqdn} resolvable (zone present)`, started);
    }
    default:
      return result('UNKNOWN', `No health check for ${kind}`, started);
  }
}

export async function readAwsLogs(out: ResourceOutputs, cfg: ClientConfig, limit: number, signal?: AbortSignal): Promise<LogLine[]> {
  if (!out.log_group) return [];
  const r = await new CloudWatchLogsClient(cfg).send(
    new FilterLogEventsCommand({ logGroupName: String(out.log_group), limit, startTime: Date.now() - 60 * 60 * 1000 }),
    { abortSignal: signal },
  );
  return (r.events ?? []).map((e) => ({
    timestamp: new Date(e.timestamp ?? Date.now()).toISOString(),
    level: /error|exception/i.test(e.message ?? '') ? 'error' : 'info',
    message: (e.message ?? '').slice(0, 2000),
  }));
}
