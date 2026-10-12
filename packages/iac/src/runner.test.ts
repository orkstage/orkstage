// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { driftChanges } from './runner.js';

const drift = (address: string, before: Record<string, unknown>, after: Record<string, unknown>, actions = ['update']) => ({
  address,
  change: { actions, before, after },
});

describe('driftChanges', () => {
  it('names the attributes changed outside OpenTofu, never their values', () => {
    const changes = driftChanges({
      resource_drift: [drift('aws_sqs_queue.this', { visibility_timeout_seconds: 30, tags: null }, { visibility_timeout_seconds: 300, tags: {} })],
    });
    expect(changes).toEqual([{ address: 'aws_sqs_queue.this', action: 'update', attributes: ['visibility_timeout_seconds'] }]);
    expect(JSON.stringify(changes)).not.toContain('300');
  });

  it('ignores representation-only differences: empty values and set order', () => {
    const changes = driftChanges({
      resource_drift: [
        drift('aws_ecr_repository.this', { tags: null, user_group_ids: null }, { tags: {}, user_group_ids: [] }),
        drift('aws_db_subnet_group.this', { subnet_ids: ['subnet-b', 'subnet-a'] }, { subnet_ids: ['subnet-a', 'subnet-b'] }),
        drift('aws_db_instance.this', { enabled_cloudwatch_logs_exports: [], domain_dns_ips: null }, { enabled_cloudwatch_logs_exports: null, domain_dns_ips: [] }),
      ],
    });
    expect(changes).toEqual([]);
  });

  it('reports deletions even without attribute values', () => {
    expect(driftChanges({ resource_drift: [drift('aws_ecs_service.this[0]', { name: 'api' }, {}, ['delete'])] })).toEqual([
      { address: 'aws_ecs_service.this[0]', action: 'delete', attributes: ['name'] },
    ]);
  });

  it('keeps real changes inside nested blocks', () => {
    const changes = driftChanges({
      resource_drift: [drift('aws_security_group.lb', { ingress: [{ from_port: 443, cidr_blocks: ['0.0.0.0/0'] }] }, { ingress: [{ from_port: 443, cidr_blocks: ['10.0.0.0/8'] }] })],
    });
    expect(changes).toEqual([{ address: 'aws_security_group.lb', action: 'update', attributes: ['ingress'] }]);
  });
});
