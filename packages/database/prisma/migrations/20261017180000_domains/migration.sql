-- Open item 9: custom domains with ownership verification and certificate tracking.
CREATE TYPE "DomainKind" AS ENUM ('PLATFORM', 'CUSTOM');
CREATE TYPE "DomainStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'FAILED');
CREATE TYPE "CertificateStatus" AS ENUM ('NONE', 'PENDING_VALIDATION', 'ISSUED', 'EXPIRING', 'EXPIRED', 'FAILED');

CREATE TABLE "Domain" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "resourceId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "kind" "DomainKind" NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verificationToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3),
    "lastCheckedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "certificateStatus" "CertificateStatus" NOT NULL DEFAULT 'NONE',
    "certificateExpiresAt" TIMESTAMPTZ(3),
    "certificateRecords" JSONB NOT NULL DEFAULT '[]',
    "expiryNoticeDays" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Domain_hostname_key" ON "Domain"("hostname");
CREATE INDEX "Domain_tenantId_idx" ON "Domain"("tenantId");
CREATE INDEX "Domain_instanceId_idx" ON "Domain"("instanceId");
CREATE INDEX "Domain_status_lastCheckedAt_idx" ON "Domain"("status", "lastCheckedAt");

ALTER TABLE "Domain" ADD CONSTRAINT "Domain_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
