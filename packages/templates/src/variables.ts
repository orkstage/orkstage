// SPDX-License-Identifier: AGPL-3.0-only
import { environmentTemplate, type EnvironmentTemplate } from './schema.js';
import type { ValidationIssue } from './validation.js';

export type VariableValues = Record<string, string | number | boolean>;

/**
 * Applies instance variable values onto a copy of the template. Unknown variables and
 * out-of-range values are rejected; the result is re-validated against the schema so a
 * variable can never produce a structurally invalid template.
 */
export function applyVariables(
  template: EnvironmentTemplate,
  values: VariableValues,
): { template: EnvironmentTemplate; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string, name: string) =>
    issues.push({ stage: 'semantic', severity: 'error', code, message, path: `variables.${name}` });

  const declared = new Map(template.spec.variables.map((v) => [v.name, v]));
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) err('UNKNOWN_VARIABLE', `Variable "${name}" is not declared by this template.`, name);
  }

  const copy = structuredClone(template);
  for (const v of template.spec.variables) {
    const value = values[v.name] ?? v.default;
    if (typeof value !== v.type) {
      err('VARIABLE_TYPE', `Variable "${v.name}" must be a ${v.type}.`, v.name);
      continue;
    }
    if (typeof value === 'number') {
      if (v.min !== undefined && value < v.min) err('VARIABLE_RANGE', `Variable "${v.name}" must be ≥ ${v.min}.`, v.name);
      if (v.max !== undefined && value > v.max) err('VARIABLE_RANGE', `Variable "${v.name}" must be ≤ ${v.max}.`, v.name);
    }
    if (typeof value === 'string' && v.allowed && !v.allowed.includes(value)) {
      err('VARIABLE_NOT_ALLOWED', `Variable "${v.name}" must be one of: ${v.allowed.join(', ')}.`, v.name);
    }
    const [resourceId, field] = v.target.split('.') as [string, string];
    const resource = copy.spec.resources.find((r) => r.id === resourceId);
    if (resource) (resource as Record<string, unknown>)[field] = value;
  }

  if (issues.length > 0) return { template, issues };
  const reparsed = environmentTemplate.safeParse(copy);
  if (!reparsed.success) {
    return {
      template,
      issues: reparsed.error.issues.map((i) => ({
        stage: 'semantic',
        severity: 'error',
        code: 'VARIABLE_PRODUCES_INVALID_TEMPLATE',
        message: i.message,
        path: i.path.join('.'),
      })),
    };
  }
  return { template: reparsed.data, issues };
}
