// SPDX-License-Identifier: AGPL-3.0-only
import type { ResourceActionDescriptor } from '@orkstage/cloud-core';
import type { TemplateTrigger } from '@orkstage/templates';

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

/** Stable scheduler id for a scheduled trigger, so redeploys replace it instead of adding another. */
export const triggerSchedulerId = (instanceId: string, trigger: string) => `trigger:${instanceId}:${trigger}`;
