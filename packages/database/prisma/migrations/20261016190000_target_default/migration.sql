-- A default cloud target per tenant scope (a tenant, or the shared targets), provider and
-- environment: instance slots left unbound are bound to it when the instance is created.
ALTER TABLE "CloudTarget" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "CloudTarget_default_key"
  ON "CloudTarget" (COALESCE("tenantId", '00000000-0000-0000-0000-000000000000'::uuid), "provider", "environment")
  WHERE "isDefault";
