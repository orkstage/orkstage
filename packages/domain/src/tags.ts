// SPDX-License-Identifier: AGPL-3.0-only
export interface TagContext {
  organizationId: string;
  tenantId: string;
  instanceId: string;
  resourceId: string;
  deploymentId?: string;
  environment: string;
  plan: string;
  templateName: string;
  templateVersion: string;
}

/**
 * Standard metadata attached to every platform-managed cloud resource (spec §34, §79).
 * Cleanup relies on `platform:managed` + ids, never on names (spec §92).
 */
export function standardTags(ctx: TagContext): Record<string, string> {
  const tags: Record<string, string> = {
    'platform:managed': 'true',
    'platform:organization-id': ctx.organizationId,
    'platform:tenant-id': ctx.tenantId,
    'platform:instance-id': ctx.instanceId,
    'platform:resource-id': ctx.resourceId,
    'platform:environment': ctx.environment,
    'platform:plan': ctx.plan,
    'platform:template': ctx.templateName,
    'platform:template-version': ctx.templateVersion,
  };
  if (ctx.deploymentId) tags['platform:deployment-id'] = ctx.deploymentId;
  return tags;
}
