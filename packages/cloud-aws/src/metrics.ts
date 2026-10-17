// SPDX-License-Identifier: AGPL-3.0-only
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { MetricPoint, ResourceOutputs } from '@orkstage/cloud-core';

/** The platform's metric names (alert rules and the console use these on every provider). */
export const PLATFORM_METRICS = ['cpu', 'memory', 'requests', 'errors_5xx', 'latency_ms', 'connections'] as const;
export type PlatformMetric = (typeof PLATFORM_METRICS)[number];

export interface CloudWatchQuery {
  namespace: string;
  metricName: string;
  dimensions: { Name: string; Value: string }[];
  stat: 'Average' | 'Sum' | 'Maximum';
  /** Applied to each value, e.g. seconds to milliseconds. */
  scale?: number;
}

/** `app/<name>/<id>` from a load balancer ARN: the dimension value CloudWatch expects. */
export function loadBalancerDimension(arn: string): string | null {
  return /:loadbalancer\/(app\/[^/]+\/[^/]+)$/.exec(arn)?.[1] ?? null;
}

/**
 * Which CloudWatch metric answers a platform metric for one resource, from the outputs its module
 * recorded. Null when the resource kind has no such metric.
 */
export function cloudWatchQuery(serviceKind: string, outputs: ResourceOutputs, metric: string): CloudWatchQuery | null {
  const out = (k: string) => (outputs[k] === undefined ? '' : String(outputs[k]));
  switch (serviceKind) {
    case 'compute.container-service': {
      if (!out('cluster_name') || !out('service_name')) return null;
      const dimensions = [{ Name: 'ClusterName', Value: out('cluster_name') }, { Name: 'ServiceName', Value: out('service_name') }];
      if (metric === 'cpu') return { namespace: 'AWS/ECS', metricName: 'CPUUtilization', dimensions, stat: 'Average' };
      if (metric === 'memory') return { namespace: 'AWS/ECS', metricName: 'MemoryUtilization', dimensions, stat: 'Average' };
      return null;
    }
    case 'ingress': {
      const lb = loadBalancerDimension(out('arn'));
      if (!lb) return null;
      const dimensions = [{ Name: 'LoadBalancer', Value: lb }];
      if (metric === 'requests') return { namespace: 'AWS/ApplicationELB', metricName: 'RequestCount', dimensions, stat: 'Sum' };
      if (metric === 'errors_5xx') return { namespace: 'AWS/ApplicationELB', metricName: 'HTTPCode_Target_5XX_Count', dimensions, stat: 'Sum' };
      if (metric === 'latency_ms') return { namespace: 'AWS/ApplicationELB', metricName: 'TargetResponseTime', dimensions, stat: 'Average', scale: 1000 };
      return null;
    }
    case 'database.postgresql': {
      if (!out('identifier')) return null;
      const dimensions = [{ Name: 'DBInstanceIdentifier', Value: out('identifier') }];
      if (metric === 'cpu') return { namespace: 'AWS/RDS', metricName: 'CPUUtilization', dimensions, stat: 'Average' };
      if (metric === 'connections') return { namespace: 'AWS/RDS', metricName: 'DatabaseConnections', dimensions, stat: 'Average' };
      return null;
    }
    case 'cache.redis': {
      if (!out('replication_group_id')) return null;
      // Metrics are per node; the primary of a group created by OrkStage is node 001.
      const dimensions = [{ Name: 'CacheClusterId', Value: `${out('replication_group_id')}-001` }];
      if (metric === 'cpu') return { namespace: 'AWS/ElastiCache', metricName: 'EngineCPUUtilization', dimensions, stat: 'Average' };
      if (metric === 'connections') return { namespace: 'AWS/ElastiCache', metricName: 'CurrConnections', dimensions, stat: 'Average' };
      return null;
    }
    default:
      return null;
  }
}

/** One value per minute over the last `minutes`, oldest first (`GetMetricData`, 60 second period). */
export async function readCloudWatch(
  client: Pick<CloudWatchClient, 'send'>,
  query: CloudWatchQuery,
  minutes: number,
  signal?: AbortSignal,
  now = new Date(),
): Promise<MetricPoint[]> {
  const end = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const start = new Date(end.getTime() - minutes * 60_000);
  const res = await client.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      ScanBy: 'TimestampAscending',
      MetricDataQueries: [
        { Id: 'm', MetricStat: { Metric: { Namespace: query.namespace, MetricName: query.metricName, Dimensions: query.dimensions }, Period: 60, Stat: query.stat }, ReturnData: true },
      ],
    }),
    { abortSignal: signal },
  );
  const r = res.MetricDataResults?.[0];
  const times = r?.Timestamps ?? [];
  const values = r?.Values ?? [];
  return times
    .map((t, i) => ({ timestamp: new Date(t).toISOString(), value: Math.round((values[i] ?? 0) * (query.scale ?? 1) * 100) / 100 }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
