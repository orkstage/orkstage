-- ADR 0007: optional limits per tenant replace plans. Every tenant keeps the numbers its plan gave
-- it, and every switch its plan turned off becomes a tenant feature flag override set to off.
ALTER TABLE "Tenant" ADD COLUMN "limits" JSONB NOT NULL DEFAULT '{}';

UPDATE "Tenant" t
SET "limits" = jsonb_strip_nulls(jsonb_build_object(
  'maxInstances', p."entitlements" -> 'maxInstances',
  'maxServicesPerInstance', p."entitlements" -> 'maxServices',
  'maxVcpuPerInstance', p."entitlements" -> 'maxCpu',
  'maxMemoryGiBPerInstance', to_jsonb(round((p."entitlements" ->> 'maxMemoryMiB')::numeric / 1024, 2)),
  'maxReplicasPerService', p."entitlements" -> 'maxReplicas',
  'maxDatabaseGiBPerInstance', p."entitlements" -> 'maxDatabaseGiB',
  'maxDomainsPerInstance', p."entitlements" -> 'maxDomains',
  'maxBackupRetentionDays', p."entitlements" -> 'backupRetentionDays'
))
FROM "Plan" p
WHERE p."id" = t."planId";

INSERT INTO "FeatureFlag" ("id", "key", "tenantId", "enabled")
SELECT gen_random_uuid(), f."key", t."id", false
FROM "Tenant" t
JOIN "Plan" p ON p."id" = t."planId"
CROSS JOIN (VALUES
  ('MULTI_CLOUD', 'multiCloud'),
  ('MULTI_REGION', 'multiRegion'),
  ('AUTOSCALING', 'autoscaling'),
  ('CUSTOM_DOMAINS', 'customDomains')
) AS f("key", "entitlement")
WHERE p."entitlements" ->> f."entitlement" = 'false'
ON CONFLICT ("key", "tenantId") DO NOTHING;

ALTER TABLE "Tenant" DROP CONSTRAINT "Tenant_planId_fkey";
ALTER TABLE "Tenant" DROP COLUMN "planId";
DROP TABLE "Plan";
