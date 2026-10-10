import type { Entitlements, PlanCode } from '@orkstage/domain/core';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { activeResources, buildDependencyGraph, DependencyCycleError, topologicalLevels } from './graph.js';
import { environmentTemplate, type EnvironmentTemplate } from './schema.js';

export type ValidationStage = 'schema' | 'semantic' | 'plan' | 'capability' | 'policy' | 'quota';

export interface ValidationIssue {
  stage: ValidationStage;
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** Dotted location in the template, e.g. `spec.resources.api.replicas`. */
  path?: string;
  /** Suggested remedies, shown to the operator (spec §42.6). */
  suggestions?: string[];
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export function report(issues: ValidationIssue[]): ValidationReport {
  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

export type ParseResult =
  | { ok: true; template: EnvironmentTemplate }
  | { ok: false; issues: ValidationIssue[] };

/** Stage 1 — schema validation. Accepts YAML/JSON text or an already-parsed object. */
export function parseTemplate(input: string | unknown): ParseResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = parseYaml(input);
    } catch (err) {
      return {
        ok: false,
        issues: [{ stage: 'schema', severity: 'error', code: 'INVALID_YAML', message: (err as Error).message }],
      };
    }
  }
  const result = environmentTemplate.safeParse(raw);
  if (result.success) return { ok: true, template: result.data };
  return { ok: false, issues: zodIssues(result.error) };
}

function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({
    stage: 'schema' as const,
    severity: 'error' as const,
    code: 'SCHEMA_INVALID',
    message: i.message,
    path: i.path.map(String).join('.'),
  }));
}

/** Stage 2 — semantic validation: references, uniqueness, cycles, variable targets. */
export function validateSemantics(template: EnvironmentTemplate): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string, path?: string) =>
    issues.push({ stage: 'semantic', severity: 'error', code, message, path });

  const resources = template.spec.resources;
  const ids = new Set<string>();
  for (const r of resources) {
    if (ids.has(r.id)) err('DUPLICATE_RESOURCE', `Resource id "${r.id}" is used more than once.`, `spec.resources.${r.id}`);
    ids.add(r.id);
  }

  const slots = new Set(template.spec.placements.map((p) => p.name));
  if (slots.size !== template.spec.placements.length) err('DUPLICATE_PLACEMENT', 'Placement slot names must be unique.');

  const byId = new Map(resources.map((r) => [r.id, r]));
  for (const r of resources) {
    const path = `spec.resources.${r.id}`;
    if (!slots.has(r.placement)) err('UNKNOWN_PLACEMENT', `Resource "${r.id}" uses unknown placement "${r.placement}".`, `${path}.placement`);
    for (const dep of r.dependsOn) {
      if (!ids.has(dep)) err('UNKNOWN_DEPENDENCY', `Resource "${r.id}" depends on unknown resource "${dep}".`, `${path}.dependsOn`);
    }
    if (r.type === 'ingress') {
      for (const route of r.routes) {
        const target = byId.get(route.service);
        if (target?.type !== 'compute.container-service') {
          err('INVALID_ROUTE', `Ingress "${r.id}" routes to "${route.service}", which is not a container service.`, `${path}.routes`);
        } else if (!target.port) {
          err('ROUTE_WITHOUT_PORT', `Service "${route.service}" is routed by ingress "${r.id}" but declares no port.`, `spec.resources.${route.service}.port`);
        }
      }
    }
    if (r.type === 'dns' && byId.get(r.target)?.type !== 'ingress') {
      err('INVALID_DNS_TARGET', `DNS "${r.id}" must target an ingress resource.`, `${path}.target`);
    }
    if (r.type === 'compute.container-service' && r.autoscaling && r.autoscaling.minReplicas > r.autoscaling.maxReplicas) {
      err('INVALID_AUTOSCALING', `Service "${r.id}" has minReplicas greater than maxReplicas.`, `${path}.autoscaling`);
    }
  }

  for (const c of template.spec.connectivity) {
    if (!ids.has(c.from) || !ids.has(c.to)) {
      err('UNKNOWN_CONNECTIVITY_ENDPOINT', `Connectivity ${c.from} → ${c.to} references an unknown resource.`, 'spec.connectivity');
    }
  }

  for (const v of template.spec.variables) {
    const [resourceId, field] = v.target.split('.') as [string, string];
    const target = byId.get(resourceId);
    if (!target) err('UNKNOWN_VARIABLE_TARGET', `Variable "${v.name}" targets unknown resource "${resourceId}".`, `spec.variables.${v.name}`);
    else if (!(field in target)) err('UNKNOWN_VARIABLE_FIELD', `Variable "${v.name}" targets unknown field "${field}" on "${resourceId}".`, `spec.variables.${v.name}`);
  }

  const triggerNames = new Set<string>();
  for (const t of template.spec.triggers) {
    const path = `spec.triggers.${t.name}`;
    if (triggerNames.has(t.name)) err('DUPLICATE_TRIGGER', `Trigger name "${t.name}" is used more than once.`, path);
    triggerNames.add(t.name);
    if (!ids.has(t.resource)) err('UNKNOWN_TRIGGER_RESOURCE', `Trigger "${t.name}" targets unknown resource "${t.resource}".`, `${path}.resource`);
    if (!t.on.manual && !t.on.webhook && !t.on.schedule) err('TRIGGER_NEVER_RUNS', `Trigger "${t.name}" is not manual, scheduled or a webhook, so it can never run.`, `${path}.on`);
  }

  if (issues.length === 0) {
    try {
      topologicalLevels(buildDependencyGraph(template));
    } catch (e) {
      if (e instanceof DependencyCycleError) err('DEPENDENCY_CYCLE', e.message, 'spec.resources');
      else throw e;
    }
  }
  return issues;
}

export interface ResourceTotals {
  services: number;
  cpu: number;
  memoryMiB: number;
  maxReplicas: number;
  databaseGiB: number;
  domains: number;
}

/** Aggregate resource demand, counting replicas (or the autoscaling ceiling when present). */
export function resourceTotals(template: EnvironmentTemplate): ResourceTotals {
  const totals: ResourceTotals = { services: 0, cpu: 0, memoryMiB: 0, maxReplicas: 0, databaseGiB: 0, domains: 0 };
  for (const r of activeResources(template)) {
    if (r.type === 'compute.container-service') {
      const replicas = r.autoscaling?.maxReplicas ?? r.replicas;
      totals.services += 1;
      totals.cpu += r.cpu * replicas;
      totals.memoryMiB += r.memoryMiB * replicas;
      totals.maxReplicas = Math.max(totals.maxReplicas, replicas);
    } else if (r.type === 'database.postgresql') {
      totals.databaseGiB += r.storageGiB;
    } else if (r.type === 'dns') {
      // The platform subdomain is always included; only custom domains count against the plan.
      if (r.customDomain !== 'disabled') totals.domains += 1;
    }
  }
  return totals;
}

/** Stage 3 — plan compatibility against a plan's entitlements. */
export function validatePlanCompatibility(
  template: EnvironmentTemplate,
  plan: PlanCode,
  entitlements: Entitlements,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string, path?: string, suggestions?: string[]) =>
    issues.push({ stage: 'plan', severity: 'error', code, message, path, suggestions });

  if (!template.spec.plans.includes(plan)) {
    err('PLAN_NOT_ALLOWED', `Template ${template.metadata.name} is not available on the ${plan} plan.`, 'spec.plans', [
      `Use a plan in: ${template.spec.plans.join(', ')}`,
    ]);
  }

  const t = resourceTotals(template);
  const limit = (code: string, label: string, value: number, max: number) => {
    if (value > max) err(code, `${label} ${round(value)} exceeds the ${plan} limit of ${max}.`);
  };
  limit('PLAN_MAX_SERVICES', 'Service count', t.services, entitlements.maxServices);
  limit('PLAN_MAX_CPU', 'Total vCPU', t.cpu, entitlements.maxCpu);
  limit('PLAN_MAX_MEMORY', 'Total memory (MiB)', t.memoryMiB, entitlements.maxMemoryMiB);
  limit('PLAN_MAX_REPLICAS', 'Replica count', t.maxReplicas, entitlements.maxReplicas);
  limit('PLAN_MAX_DATABASE', 'Database storage (GiB)', t.databaseGiB, entitlements.maxDatabaseGiB);
  limit('PLAN_MAX_DOMAINS', 'Custom domain count', t.domains, entitlements.maxDomains);

  for (const r of activeResources(template)) {
    if (r.type === 'compute.container-service' && r.autoscaling && !entitlements.autoscaling) {
      err('PLAN_NO_AUTOSCALING', `Autoscaling on "${r.id}" is not included in the ${plan} plan.`, `spec.resources.${r.id}.autoscaling`);
    }
    if (r.type === 'dns' && r.customDomain !== 'disabled' && !entitlements.customDomains) {
      err('PLAN_NO_CUSTOM_DOMAINS', `Custom domains are not included in the ${plan} plan.`, `spec.resources.${r.id}.customDomain`);
    }
    if (r.type === 'database.postgresql' && r.backup.retentionDays > entitlements.backupRetentionDays && r.backup.enabled) {
      err('PLAN_BACKUP_RETENTION', `Backup retention of ${r.backup.retentionDays} days on "${r.id}" exceeds the ${plan} limit of ${entitlements.backupRetentionDays}.`, `spec.resources.${r.id}.backup`);
    }
  }
  return issues;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Runs schema → semantic → plan stages. Capability/policy stages live in @orkstage/provisioning. */
export function validateTemplate(
  input: string | unknown,
  plan?: { code: PlanCode; entitlements: Entitlements },
): ValidationReport & { template?: EnvironmentTemplate } {
  const parsed = parseTemplate(input);
  if (!parsed.ok) return report(parsed.issues);
  const issues = validateSemantics(parsed.template);
  if (issues.length === 0 && plan) issues.push(...validatePlanCompatibility(parsed.template, plan.code, plan.entitlements));
  return { ...report(issues), template: parsed.template };
}
