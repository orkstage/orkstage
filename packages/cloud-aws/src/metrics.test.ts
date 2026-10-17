// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { cloudWatchQuery, loadBalancerDimension, readCloudWatch } from './metrics.js';

describe('CloudWatch metrics', () => {
  it('maps platform metrics to the CloudWatch metric of each resource kind', () => {
    expect(cloudWatchQuery('compute.container-service', { cluster_name: 'c', service_name: 's' }, 'cpu')).toMatchObject({
      namespace: 'AWS/ECS', metricName: 'CPUUtilization', dimensions: [{ Name: 'ClusterName', Value: 'c' }, { Name: 'ServiceName', Value: 's' }],
    });
    const arn = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/ork-acme-prod-edge/50dc6c495c0c9188';
    expect(loadBalancerDimension(arn)).toBe('app/ork-acme-prod-edge/50dc6c495c0c9188');
    expect(cloudWatchQuery('ingress', { arn }, 'latency_ms')).toMatchObject({ metricName: 'TargetResponseTime', scale: 1000 });
    expect(cloudWatchQuery('ingress', { arn }, 'errors_5xx')).toMatchObject({ metricName: 'HTTPCode_Target_5XX_Count', stat: 'Sum' });
    expect(cloudWatchQuery('database.postgresql', { identifier: 'db' }, 'connections')).toMatchObject({ namespace: 'AWS/RDS', metricName: 'DatabaseConnections' });
    expect(cloudWatchQuery('cache.redis', { replication_group_id: 'rg' }, 'cpu')!.dimensions).toEqual([{ Name: 'CacheClusterId', Value: 'rg-001' }]);
    expect(cloudWatchQuery('queue', {}, 'cpu')).toBeNull();
    expect(cloudWatchQuery('compute.container-service', {}, 'cpu')).toBeNull();
  });

  it('reads one point per minute, oldest first, scaled', async () => {
    const send = vi.fn(async () => ({
      MetricDataResults: [{ Timestamps: [new Date('2026-10-17T10:02:00Z'), new Date('2026-10-17T10:01:00Z')], Values: [0.25, 0.5] }],
    }));
    const points = await readCloudWatch({ send } as never, { namespace: 'AWS/ApplicationELB', metricName: 'TargetResponseTime', dimensions: [], stat: 'Average', scale: 1000 }, 2, undefined, new Date('2026-10-17T10:03:30Z'));
    expect(points).toEqual([
      { timestamp: '2026-10-17T10:01:00.000Z', value: 500 },
      { timestamp: '2026-10-17T10:02:00.000Z', value: 250 },
    ]);
    const input = (send.mock.calls[0] as unknown as [{ input: { StartTime: Date; EndTime: Date } }])[0].input;
    expect(input.EndTime.toISOString()).toBe('2026-10-17T10:03:00.000Z');
    expect(input.StartTime.toISOString()).toBe('2026-10-17T10:01:00.000Z');
  });
});
