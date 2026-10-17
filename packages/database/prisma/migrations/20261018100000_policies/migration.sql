-- Open item 12: tenant policies (tighten the platform policy) and instance labels (cloud tags).
ALTER TABLE "Tenant" ADD COLUMN "policy" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Instance" ADD COLUMN "labels" JSONB NOT NULL DEFAULT '{}';
