-- ADR 0007: profiles replace the default cloud targets of N3. Every tenant scope and environment
-- that had default targets gets a default profile named after the environment, holding them.
CREATE TABLE "Profile" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "name" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProfileTarget" (
    "profileId" UUID NOT NULL,
    "provider" "CloudProvider" NOT NULL,
    "targetId" UUID NOT NULL,
    "region" TEXT,

    CONSTRAINT "ProfileTarget_pkey" PRIMARY KEY ("profileId","provider")
);

CREATE INDEX "Profile_tenantId_idx" ON "Profile"("tenantId");
CREATE INDEX "ProfileTarget_targetId_idx" ON "ProfileTarget"("targetId");

-- Names are unique per tenant scope (shared profiles have no tenant), ignoring case.
CREATE UNIQUE INDEX "Profile_name_key" ON "Profile" (COALESCE("tenantId", '00000000-0000-0000-0000-000000000000'::uuid), lower("name"));
-- At most one default per tenant scope and environment.
CREATE UNIQUE INDEX "Profile_default_key" ON "Profile" (COALESCE("tenantId", '00000000-0000-0000-0000-000000000000'::uuid), "environment") WHERE "isDefault";

ALTER TABLE "Profile" ADD CONSTRAINT "Profile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProfileTarget" ADD CONSTRAINT "ProfileTarget_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProfileTarget" ADD CONSTRAINT "ProfileTarget_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "CloudTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Instance" ADD COLUMN "profileId" UUID;
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "Profile" ("id", "tenantId", "name", "environment", "isDefault", "updatedAt")
SELECT gen_random_uuid(), s."tenantId", s."environment", s."environment", true, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "tenantId", "environment" FROM "CloudTarget" WHERE "isDefault") s;

INSERT INTO "ProfileTarget" ("profileId", "provider", "targetId", "region")
SELECT p."id", t."provider", t."id", NULL
FROM "CloudTarget" t
JOIN "Profile" p ON p."tenantId" IS NOT DISTINCT FROM t."tenantId" AND p."environment" = t."environment"
WHERE t."isDefault";

DROP INDEX "CloudTarget_default_key";
ALTER TABLE "CloudTarget" DROP COLUMN "isDefault";
