// SPDX-License-Identifier: AGPL-3.0-only
import type { ResourceActionDescriptor } from '@orkstage/cloud-core';
import { catalogAction, catalogActionFor, type CatalogAction } from '@orkstage/domain';
import type { TemplateResource, TemplateTrigger } from '@orkstage/templates';

export type TriggerParamValue = string | number | boolean;
export type TriggerSource = 'MANUAL' | 'SCHEDULE' | 'WEBHOOK';

export type TriggerResolution =
  | { ok: true; params: Record<string, TriggerParamValue> }
  | { ok: false; errors: string[] };

/** Whether a trigger may be started this way (console or CLI, cron, or an API key). */
export function triggerAllows(trigger: TemplateTrigger, source: TriggerSource): boolean {
  if (source === 'MANUAL') return trigger.on.manual;
  if (source === 'WEBHOOK') return trigger.on.webhook;
  return Boolean(trigger.on.schedule);
}

/**
 * Final parameters for one run: the template defaults, then the caller's values for names the
 * template marks overridable. When the provider describes the action, unknown names, missing
 * required values and wrong types are rejected before anything reaches the provider.
 */
export function resolveTriggerParams(
  trigger: TemplateTrigger,
  overrides: Record<string, TriggerParamValue>,
  descriptor?: ResourceActionDescriptor,
): TriggerResolution {
  const errors: string[] = [];
  for (const name of Object.keys(overrides)) {
    if (!trigger.overridable.includes(name)) errors.push(`Parameter "${name}" cannot be set when running "${trigger.name}".`);
  }
  const params = { ...trigger.params, ...Object.fromEntries(Object.entries(overrides).filter(([k]) => trigger.overridable.includes(k))) };

  if (descriptor) {
    const known = new Map(descriptor.params.map((p) => [p.name, p]));
    for (const [name, value] of Object.entries(params)) {
      const spec = known.get(name);
      if (!spec) errors.push(`Action "${descriptor.name}" has no parameter "${name}".`);
      else if (typeof value !== spec.type) errors.push(`Parameter "${name}" must be a ${spec.type}.`);
    }
    for (const p of descriptor.params) {
      if (p.required && params[p.name] === undefined) errors.push(`Parameter "${p.name}" is required by "${descriptor.name}".`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, params };
}

export interface ResolvedAction {
  /** The provider's action that runs. */
  descriptor: ResourceActionDescriptor;
  /** The catalog action it stands for (ADR 0009), when it is one. */
  catalog?: CatalogAction;
  /** Catalog parameter name to the provider's, where they differ. */
  params: Readonly<Record<string, string>>;
}

/**
 * The provider action a trigger runs: the provider's own name, or a catalog id (`service.restart`)
 * that one of the provider's actions stands for on this resource type (ADR 0009).
 */
export function resolveAction(name: string, resourceType: string, provider: string, descriptors: readonly ResourceActionDescriptor[]): ResolvedAction | undefined {
  const exact = descriptors.find((d) => d.name === name);
  if (exact) return { descriptor: exact, catalog: catalogActionFor(name, resourceType, provider)?.action, params: {} };
  const action = catalogAction(name);
  if (!action?.resourceTypes.includes(resourceType)) return undefined;
  for (const alias of action.aliases) {
    if (alias.provider && alias.provider !== provider) continue;
    const descriptor = descriptors.find((d) => d.name === alias.name);
    if (descriptor) return { descriptor, catalog: action, params: alias.params ?? {} };
  }
  return undefined;
}

/** Parameter values with catalog names turned into the provider's. */
export function toProviderParams<T>(values: Readonly<Record<string, T>>, rename: Readonly<Record<string, string>>): Record<string, T> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [rename[k] ?? k, v]));
}

/** The trigger as the provider sees it: its defaults and overridable names with provider names. */
export function withProviderParams(trigger: TemplateTrigger, rename: Readonly<Record<string, string>>): TemplateTrigger {
  return { ...trigger, params: toProviderParams(trigger.params, rename), overridable: trigger.overridable.map((n) => rename[n] ?? n) };
}

/**
 * Instances `service.scale` may set (ADR 0009): the template autoscaling bounds when the service has
 * them, otherwise 1 up to the tenant's replica limit (100 without one).
 */
export function scaleRange(resource: TemplateResource | undefined, maxReplicasPerService?: number): { min: number; max: number } {
  const auto = resource?.type === 'compute.container-service' ? resource.autoscaling : undefined;
  const ceiling = maxReplicasPerService ?? 100;
  if (auto) return { min: Math.max(1, auto.minReplicas), max: Math.min(auto.maxReplicas, ceiling) };
  return { min: 1, max: ceiling };
}

/** Stable scheduler id for a scheduled trigger, so redeploys replace it instead of adding another. */
export const triggerSchedulerId = (instanceId: string, trigger: string) => `trigger:${instanceId}:${trigger}`;
