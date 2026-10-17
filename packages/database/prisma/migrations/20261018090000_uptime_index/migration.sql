-- Open item 11: uptime per tenant reads the health history by tenant and time.
CREATE INDEX "HealthCheckResult_tenantId_checkedAt_idx" ON "HealthCheckResult"("tenantId", "checkedAt");
