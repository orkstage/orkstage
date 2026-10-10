-- CreateEnum
CREATE TYPE "TriggerSource" AS ENUM ('MANUAL', 'SCHEDULE', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "TriggerRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "TriggerRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "source" "TriggerSource" NOT NULL,
    "status" "TriggerRunStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedById" UUID,
    "apiKeyId" UUID,
    "correlationId" TEXT NOT NULL,
    "reference" TEXT,
    "url" TEXT,
    "message" TEXT,
    "errorClass" TEXT,
    "queuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TriggerRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TriggerRun_instanceId_queuedAt_idx" ON "TriggerRun"("instanceId", "queuedAt");

-- CreateIndex
CREATE INDEX "TriggerRun_tenantId_queuedAt_idx" ON "TriggerRun"("tenantId", "queuedAt");

-- AddForeignKey
ALTER TABLE "TriggerRun" ADD CONSTRAINT "TriggerRun_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

