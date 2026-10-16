-- Cloud targets: the environment becomes a fixed set (production, staging, development, sandbox,
-- any) checked by the `target-environment` policy; free text labels from before (simulation,
-- local-emulator, ...) become `any`, which keeps their current behavior.
UPDATE "CloudTarget" SET "environment" = 'any'
  WHERE "environment" NOT IN ('production', 'staging', 'development', 'sandbox', 'any');
ALTER TABLE "CloudTarget" ALTER COLUMN "environment" SET DEFAULT 'any';

-- Target names are unique per tenant (and among shared targets), ignoring case. Existing
-- duplicates get a numeric suffix first.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "tenantId", lower("name") ORDER BY "createdAt", "id") AS n
  FROM "CloudTarget"
)
UPDATE "CloudTarget" c SET "name" = c."name" || ' (' || r.n || ')'
  FROM ranked r WHERE c."id" = r."id" AND r.n > 1;
CREATE UNIQUE INDEX "CloudTarget_tenant_name_key"
  ON "CloudTarget" (COALESCE("tenantId", '00000000-0000-0000-0000-000000000000'::uuid), lower("name"));
