-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('PlatformOwner', 'PlatformAdmin', 'PlatformOperator');

-- CreateEnum
CREATE TYPE "TenantRole" AS ENUM ('CustomerOwner', 'CustomerAdmin', 'CustomerDeveloper', 'CustomerViewer');

-- CreateEnum
CREATE TYPE "TemplateVisibility" AS ENUM ('SYSTEM', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "TemplateVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "CloudProvider" AS ENUM ('aws', 'azure', 'gcp', 'oci', 'mock');

-- CreateEnum
CREATE TYPE "TargetStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "InstanceStatus" AS ENUM ('DRAFT', 'VALIDATING', 'PLANNING', 'AWAITING_APPROVAL', 'PROVISIONING', 'DEPLOYING', 'CONFIGURING', 'VERIFYING', 'READY', 'VALIDATION_FAILED', 'PLAN_FAILED', 'PROVISION_FAILED', 'DEPLOY_FAILED', 'VERIFICATION_FAILED', 'DEGRADED', 'DESTROYING', 'DESTROY_FAILED', 'DESTROYED');

-- CreateEnum
CREATE TYPE "HealthState" AS ENUM ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "ResourceStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "KnowledgeState" AS ENUM ('DESIRED', 'KNOWN', 'ACTUAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DriftStatus" AS ENUM ('IN_SYNC', 'DRIFT_DETECTED', 'REMEDIATION_PENDING', 'REMEDIATION_FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DeploymentKind" AS ENUM ('APPLY', 'DESTROY');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'PARTIALLY_FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StatusState" AS ENUM ('OPERATIONAL', 'DEGRADED', 'PARTIAL_OUTAGE', 'MAJOR_OUTAGE', 'MAINTENANCE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "IncidentSource" AS ENUM ('MANUAL', 'AUTOMATED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platformRole" "PlatformRole",
    "disabledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "planId" UUID NOT NULL,
    "allowedEmailDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "TenantRole" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityProvider" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretRef" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['openid', 'email', 'profile']::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalIdentity" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entitlements" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "visibility" "TemplateVisibility" NOT NULL DEFAULT 'ORGANIZATION',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateVersion" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "status" "TemplateVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "source" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "validation" JSONB,
    "publishedAt" TIMESTAMPTZ(3),
    "publishedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "registryKind" TEXT NOT NULL DEFAULT 'ecr',
    "repository" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "healthPath" TEXT NOT NULL DEFAULT '/health',
    "readinessPath" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationVersion" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "imageUri" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "architectures" TEXT[] DEFAULT ARRAY['amd64']::TEXT[],
    "scanStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudTarget" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "provider" "CloudProvider" NOT NULL,
    "name" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "config" JSONB NOT NULL,
    "credentialRef" TEXT,
    "allowedRegions" TEXT[],
    "defaultRegion" TEXT NOT NULL,
    "allowedServices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxConcurrentDeployments" INTEGER NOT NULL DEFAULT 3,
    "status" "TargetStatus" NOT NULL DEFAULT 'ACTIVE',
    "health" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "lastValidation" JSONB,
    "lastValidatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CloudTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Instance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "status" "InstanceStatus" NOT NULL DEFAULT 'DRAFT',
    "health" "HealthState" NOT NULL DEFAULT 'UNKNOWN',
    "templateVersionId" UUID NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "bindings" JSONB NOT NULL,
    "desiredStateHash" TEXT,
    "protectedFromDestroy" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceTransition" (
    "id" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "from" "InstanceStatus" NOT NULL,
    "to" "InstanceStatus" NOT NULL,
    "deploymentId" UUID,
    "reason" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstanceTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceResource" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "resourceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "provider" "CloudProvider" NOT NULL,
    "simulatedProvider" TEXT,
    "targetId" UUID NOT NULL,
    "region" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "capabilityName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "critical" BOOLEAN NOT NULL DEFAULT true,
    "providerResourceId" TEXT,
    "specHash" TEXT,
    "idempotencyKey" TEXT,
    "outputs" JSONB NOT NULL DEFAULT '{}',
    "status" "ResourceStatus" NOT NULL DEFAULT 'PENDING',
    "knowledge" "KnowledgeState" NOT NULL DEFAULT 'DESIRED',
    "health" "HealthState" NOT NULL DEFAULT 'UNKNOWN',
    "healthMessage" TEXT,
    "healthCheckedAt" TIMESTAMPTZ(3),
    "consecutiveHealthFailures" INTEGER NOT NULL DEFAULT 0,
    "drift" "DriftStatus" NOT NULL DEFAULT 'UNKNOWN',
    "driftCheckedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InstanceResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "kind" "DeploymentKind" NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'QUEUED',
    "templateVersionId" UUID NOT NULL,
    "requestedById" UUID,
    "correlationId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "cancelRequestedAt" TIMESTAMPTZ(3),
    "onlyResources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "retryOfId" UUID,
    "resolved" JSONB,
    "plan" JSONB,
    "cost" JSONB,
    "outputs" JSONB,
    "errorClass" TEXT,
    "errorMessage" TEXT,
    "queuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentStep" (
    "id" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "region" TEXT,
    "errorClass" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DeploymentStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentEvent" (
    "id" BIGSERIAL NOT NULL,
    "deploymentId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "stepKey" TEXT,
    "message" TEXT NOT NULL,
    "data" JSONB,

    CONSTRAINT "DeploymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthCheckResult" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "resourceId" TEXT NOT NULL,
    "state" "HealthState" NOT NULL,
    "latencyMs" INTEGER,
    "message" TEXT,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthCheckResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusComponent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "resourceIds" TEXT[],
    "critical" BOOLEAN NOT NULL DEFAULT true,
    "status" "StatusState" NOT NULL DEFAULT 'UNKNOWN',
    "position" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StatusComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "instanceId" UUID,
    "title" TEXT NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'INVESTIGATING',
    "impact" "StatusState" NOT NULL DEFAULT 'DEGRADED',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "source" "IncidentSource" NOT NULL DEFAULT 'MANUAL',
    "dedupKey" TEXT,
    "componentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deploymentId" UUID,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdById" UUID,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentUpdate" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "status" "IncidentStatus" NOT NULL,
    "message" TEXT NOT NULL,
    "createdById" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceWindow" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "instanceId" UUID,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "name" TEXT NOT NULL,
    "condition" JSONB NOT NULL,
    "severity" TEXT NOT NULL,
    "actions" TEXT[],
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 900,
    "autoResolve" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "userId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" UUID,
    "actorType" TEXT NOT NULL,
    "actorLabel" TEXT,
    "tenantId" UUID,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "correlationId" TEXT,
    "changes" JSONB,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "tenantId" UUID,
    "enabled" BOOLEAN NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "Tenant_organizationId_idx" ON "Tenant"("organizationId");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_tenantId_userId_key" ON "Membership"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_tenantId_idx" ON "Invitation"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityProvider_key_key" ON "IdentityProvider"("key");

-- CreateIndex
CREATE INDEX "ExternalIdentity_userId_idx" ON "ExternalIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentity_providerId_subject_key" ON "ExternalIdentity"("providerId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Template_name_key" ON "Template"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateVersion_templateId_version_key" ON "TemplateVersion"("templateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Application_name_key" ON "Application"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationVersion_applicationId_version_key" ON "ApplicationVersion"("applicationId", "version");

-- CreateIndex
CREATE INDEX "CloudTarget_tenantId_idx" ON "CloudTarget"("tenantId");

-- CreateIndex
CREATE INDEX "Instance_tenantId_status_idx" ON "Instance"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Instance_tenantId_slug_key" ON "Instance"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "InstanceTransition_instanceId_at_idx" ON "InstanceTransition"("instanceId", "at");

-- CreateIndex
CREATE INDEX "InstanceResource_tenantId_idx" ON "InstanceResource"("tenantId");

-- CreateIndex
CREATE INDEX "InstanceResource_status_healthCheckedAt_idx" ON "InstanceResource"("status", "healthCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InstanceResource_instanceId_resourceId_key" ON "InstanceResource"("instanceId", "resourceId");

-- CreateIndex
CREATE INDEX "Deployment_tenantId_queuedAt_idx" ON "Deployment"("tenantId", "queuedAt");

-- CreateIndex
CREATE INDEX "Deployment_instanceId_queuedAt_idx" ON "Deployment"("instanceId", "queuedAt");

-- CreateIndex
CREATE INDEX "Deployment_operationKey_idx" ON "Deployment"("operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentStep_deploymentId_key_key" ON "DeploymentStep"("deploymentId", "key");

-- CreateIndex
CREATE INDEX "DeploymentEvent_deploymentId_id_idx" ON "DeploymentEvent"("deploymentId", "id");

-- CreateIndex
CREATE INDEX "HealthCheckResult_instanceId_checkedAt_idx" ON "HealthCheckResult"("instanceId", "checkedAt");

-- CreateIndex
CREATE INDEX "StatusComponent_tenantId_idx" ON "StatusComponent"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StatusComponent_instanceId_name_key" ON "StatusComponent"("instanceId", "name");

-- CreateIndex
CREATE INDEX "Incident_tenantId_openedAt_idx" ON "Incident"("tenantId", "openedAt");

-- CreateIndex
CREATE INDEX "Incident_dedupKey_status_idx" ON "Incident"("dedupKey", "status");

-- CreateIndex
CREATE INDEX "IncidentUpdate_incidentId_at_idx" ON "IncidentUpdate"("incidentId", "at");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_tenantId_startsAt_idx" ON "MaintenanceWindow"("tenantId", "startsAt");

-- CreateIndex
CREATE INDEX "AlertRule_tenantId_idx" ON "AlertRule"("tenantId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_event_channel_key" ON "NotificationPreference"("userId", "event", "channel");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_idx" ON "NotificationDelivery"("status");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_at_idx" ON "AuditEvent"("tenantId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_resourceType_resourceId_idx" ON "AuditEvent"("resourceType", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_tenantId_key" ON "FeatureFlag"("key", "tenantId");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "IdentityProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationVersion" ADD CONSTRAINT "ApplicationVersion_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudTarget" ADD CONSTRAINT "CloudTarget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "TemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstanceTransition" ADD CONSTRAINT "InstanceTransition_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstanceResource" ADD CONSTRAINT "InstanceResource_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentStep" ADD CONSTRAINT "DeploymentStep_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentEvent" ADD CONSTRAINT "DeploymentEvent_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusComponent" ADD CONSTRAINT "StatusComponent_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentUpdate" ADD CONSTRAINT "IncidentUpdate_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Audit log is append-only (spec §38): ordinary UPDATE/DELETE is rejected at the database.
CREATE FUNCTION audit_event_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();
