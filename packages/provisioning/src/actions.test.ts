// SPDX-License-Identifier: AGPL-3.0-only
import type { ResourceActionDescriptor } from '@orkstage/cloud-core';
import type { TemplateResource, TemplateTrigger } from '@orkstage/templates';
import { describe, expect, it } from 'vitest';
import { resolveAction, resolveTriggerParams, scaleRange, toProviderParams, withProviderParams } from './triggers.js';

const render: ResourceActionDescriptor[] = [
  { name: 'restart', description: '', params: [] },
  { name: 'scale', description: '', params: [{ name: 'numInstances', type: 'number', required: true }] },
  { name: 'suspend', description: '', params: [] },
];

describe('resolveAction (ADR 0009)', () => {
  it('runs a catalog id through the provider action it stands for, renaming parameters', () => {
    const scale = resolveAction('service.scale', 'compute.container-service', 'render', render);
    expect(scale).toMatchObject({ descriptor: { name: 'scale' }, catalog: { id: 'service.scale', risk: 'disruptive' }, params: { replicas: 'numInstances' } });
    expect(resolveAction('service.restart', 'compute.container-service', 'render', render)?.descriptor.name).toBe('restart');
  });

  it('keeps provider names working, and knows their catalog action when they have one', () => {
    expect(resolveAction('restart', 'compute.container-service', 'render', render)?.catalog?.id).toBe('service.restart');
    expect(resolveAction('suspend', 'compute.container-service', 'render', render)).toMatchObject({ descriptor: { name: 'suspend' }, catalog: undefined });
  });

  it('finds nothing for an action the provider or the resource type does not have', () => {
    expect(resolveAction('database.reboot', 'compute.container-service', 'render', render)).toBeUndefined();
    expect(resolveAction('cdn.invalidate', 'web.frontend', 'render', render)).toBeUndefined();
  });

  it('validates catalog parameters under the provider names', () => {
    const trigger = { name: 'scale-api', resource: 'api', action: 'service.scale', params: { replicas: 2 }, overridable: ['replicas'], on: { manual: true, webhook: false } } as TemplateTrigger;
    const action = resolveAction(trigger.action, 'compute.container-service', 'render', render)!;
    const resolved = resolveTriggerParams(withProviderParams(trigger, action.params), toProviderParams({ replicas: 4 }, action.params), action.descriptor);
    expect(resolved).toEqual({ ok: true, params: { numInstances: 4 } });
  });
});

describe('scaleRange', () => {
  const service = (autoscaling?: { minReplicas: number; maxReplicas: number; targetCpuPercent: number }) =>
    ({ id: 'api', type: 'compute.container-service', ...(autoscaling ? { autoscaling } : {}) }) as unknown as TemplateResource;

  it('uses the autoscaling bounds, capped by the tenant limit', () => {
    expect(scaleRange(service({ minReplicas: 2, maxReplicas: 8, targetCpuPercent: 60 }))).toEqual({ min: 2, max: 8 });
    expect(scaleRange(service({ minReplicas: 0, maxReplicas: 8, targetCpuPercent: 60 }), 5)).toEqual({ min: 1, max: 5 });
  });

  it('otherwise allows 1 up to the tenant limit', () => {
    expect(scaleRange(service(), 6)).toEqual({ min: 1, max: 6 });
    expect(scaleRange(undefined)).toEqual({ min: 1, max: 100 });
  });
});
