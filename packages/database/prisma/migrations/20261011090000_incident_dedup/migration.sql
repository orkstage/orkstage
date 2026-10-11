-- Close any duplicate unresolved incidents left by concurrent health ticks, keeping the oldest.
UPDATE "Incident" i SET "status" = 'RESOLVED', "resolvedAt" = now()
WHERE i."dedupKey" IS NOT NULL AND i."status" <> 'RESOLVED'
  AND EXISTS (
    SELECT 1 FROM "Incident" o
    WHERE o."dedupKey" = i."dedupKey" AND o."status" <> 'RESOLVED' AND o."openedAt" < i."openedAt"
  );

-- One unresolved incident per dedup key.
CREATE UNIQUE INDEX "Incident_dedupKey_open_key" ON "Incident"("dedupKey") WHERE "dedupKey" IS NOT NULL AND "status" <> 'RESOLVED';

-- Retention deletes by age across all instances.
CREATE INDEX "HealthCheckResult_checkedAt_idx" ON "HealthCheckResult"("checkedAt");
