-- Release strategies, bake periods and rollbacks (ADR 0009, A8 round 2); approval of disruptive
-- trigger runs on production instances.
ALTER TYPE "TriggerRunStatus" ADD VALUE 'AWAITING_APPROVAL' BEFORE 'QUEUED';
ALTER TYPE "TriggerRunStatus" ADD VALUE 'CANCELLED';

ALTER TABLE "TriggerRun"
  ADD COLUMN "approvedById" UUID,
  ADD COLUMN "approvedAt" TIMESTAMPTZ(3);

ALTER TABLE "Deployment"
  ADD COLUMN "release" JSONB,
  ADD COLUMN "bakeUntil" TIMESTAMPTZ(3),
  ADD COLUMN "verifiedAt" TIMESTAMPTZ(3),
  ADD COLUMN "bakeFailedAt" TIMESTAMPTZ(3),
  ADD COLUMN "bakeFailure" TEXT,
  ADD COLUMN "rollbackToId" UUID;

-- Deployments still being watched: one small scan per health tick.
CREATE INDEX "Deployment_bake_watch_idx" ON "Deployment" ("bakeUntil") WHERE "bakeUntil" IS NOT NULL AND "verifiedAt" IS NULL AND "bakeFailedAt" IS NULL;
