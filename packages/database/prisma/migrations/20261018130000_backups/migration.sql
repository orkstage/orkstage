-- Open item 18: the last backup check of each database resource.
ALTER TABLE "InstanceResource" ADD COLUMN "backupState" JSONB;
