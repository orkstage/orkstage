-- Open item 16: Slack and Teams incoming webhooks as webhook formats.
CREATE TYPE "WebhookFormat" AS ENUM ('ORKSTAGE', 'SLACK', 'TEAMS');
ALTER TABLE "WebhookEndpoint" ADD COLUMN "format" "WebhookFormat" NOT NULL DEFAULT 'ORKSTAGE';
