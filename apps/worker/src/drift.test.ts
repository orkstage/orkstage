// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { meaningfulDrift } from './drift.js';

describe('meaningfulDrift', () => {
  const changes = [
    { address: 'module.resource.aws_iam_role.execution', action: 'update', attributes: ['inline_policy', 'managed_policy_arns'] },
    { address: 'module.resource.aws_lb_target_group.route[0]', action: 'update', attributes: ['load_balancer_arns', 'health_check'] },
    { address: 'module.resource.aws_sqs_queue.this', action: 'update', attributes: ['visibility_timeout_seconds'] },
  ];

  it('drops known emulator noise per resource type, keeping real changes', () => {
    expect(meaningfulDrift(changes, true)).toEqual([
      { address: 'module.resource.aws_lb_target_group.route[0]', action: 'update', attributes: ['health_check'] },
      { address: 'module.resource.aws_sqs_queue.this', action: 'update', attributes: ['visibility_timeout_seconds'] },
    ]);
  });

  it('never filters real providers', () => {
    expect(meaningfulDrift(changes, false)).toEqual(changes);
  });

  it('keeps deletions', () => {
    const gone = [{ address: 'module.resource.aws_iam_role.execution', action: 'delete', attributes: ['inline_policy'] }];
    expect(meaningfulDrift(gone, true)).toEqual([{ ...gone[0], attributes: [] }]);
  });
});
