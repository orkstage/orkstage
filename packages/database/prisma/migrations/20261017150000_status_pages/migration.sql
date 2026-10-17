-- Open item 8: status page visibility and settings, subscriptions, configurable components and
-- maintenance windows that notify subscribers.
CREATE TYPE "StatusVisibility" AS ENUM ('PRIVATE', 'CUSTOMER_ONLY', 'PUBLIC');

CREATE TABLE "StatusPage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "visibility" "StatusVisibility" NOT NULL DEFAULT 'CUSTOMER_ONLY',
    "slug" TEXT,
    "title" TEXT,
    "description" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StatusPage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StatusSubscription" (
    "id" UUID NOT NULL,
    "statusPageId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "userId" UUID,
    "tokenHash" TEXT NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StatusPage_tenantId_key" ON "StatusPage"("tenantId");
CREATE UNIQUE INDEX "StatusPage_slug_key" ON "StatusPage"("slug");
CREATE UNIQUE INDEX "StatusSubscription_tokenHash_key" ON "StatusSubscription"("tokenHash");
CREATE UNIQUE INDEX "StatusSubscription_statusPageId_email_key" ON "StatusSubscription"("statusPageId", "email");

ALTER TABLE "StatusPage" ADD CONSTRAINT "StatusPage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StatusSubscription" ADD CONSTRAINT "StatusSubscription_statusPageId_fkey" FOREIGN KEY ("statusPageId") REFERENCES "StatusPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StatusComponent" ADD COLUMN "label" TEXT,
ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sortOrder" INTEGER;

ALTER TABLE "MaintenanceWindow" ADD COLUMN "message" TEXT,
ADD COLUMN "componentNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "startedAt" TIMESTAMPTZ(3),
ADD COLUMN "completedAt" TIMESTAMPTZ(3),
ADD COLUMN "createdById" UUID;

CREATE INDEX "MaintenanceWindow_endsAt_idx" ON "MaintenanceWindow"("endsAt");
