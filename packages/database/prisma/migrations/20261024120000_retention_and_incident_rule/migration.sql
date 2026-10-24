-- Item 30 (orkstage-dev open-items.md): the rule that opened an automated incident, and indexes
-- for the hourly retention pruning in the worker's housekeeping.
ALTER TABLE "Incident" ADD COLUMN "ruleId" UUID;

CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX "NotificationDelivery_createdAt_idx" ON "NotificationDelivery"("createdAt");
CREATE INDEX "WebhookDelivery_createdAt_idx" ON "WebhookDelivery"("createdAt");
CREATE INDEX "DeploymentEvent_at_idx" ON "DeploymentEvent"("at");
