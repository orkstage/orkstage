// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** API keys, webhooks, CI intake and imports — see docs/specs/integration-api.md. */

export const API_KEY_SCOPE_VALUES = [
  'instances:read',
  'instances:write',
  'instances:deploy',
  'templates:read',
  'templates:write',
  'applications:write',
  'incidents:write',
  'imports:write',
  'webhooks:manage',
  'audit:read',
  'targets:manage',
] as const;

export const createApiKeySchema = z.object({
  name: z.string().min(2).max(80),
  tenantId: z.uuid().optional(),
  role: z.enum(['PlatformAdmin', 'PlatformOperator', 'CustomerAdmin', 'CustomerDeveloper', 'CustomerViewer']),
  scopes: z.array(z.enum(API_KEY_SCOPE_VALUES)).min(1),
  expiresAt: z.iso.datetime().optional(),
  environment: z.enum(['live', 'test']).default('live'),
});

export const WEBHOOK_EVENTS = [
  'deployment.started',
  'deployment.succeeded',
  'deployment.failed',
  'deployment.awaiting_approval',
  'instance.degraded',
  'instance.drift_detected',
  'incident.opened',
  'incident.updated',
  'incident.resolved',
  'cloud_target.unhealthy',
] as const;

export const createWebhookSchema = z.object({
  url: z.url().max(2000),
  description: z.string().max(200).default(''),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  tenantId: z.uuid().optional(),
});

export const updateWebhookSchema = z.object({
  url: z.url().max(2000).optional(),
  description: z.string().max(200).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  enabled: z.boolean().optional(),
});

/** PUT /applications/:name — create or update a catalog application (templates use catalog://<name>). */
export const upsertApplicationSchema = z.object({
  displayName: z.string().min(1).max(120),
  repository: z.string().min(3).max(500),
  registryKind: z.enum(['ecr', 'acr', 'ocir', 'gar', 'dockerhub', 'ghcr', 'other']).default('ecr'),
  port: z.number().int().min(1).max(65535),
  healthPath: z.string().startsWith('/').max(200).default('/health'),
  readinessPath: z.string().startsWith('/').max(200).optional(),
});

export const APPLICATION_NAME = /^[a-z][a-z0-9-]{1,62}$/;

export const publishApplicationVersionSchema = z.object({
  version: z.string().min(1).max(64),
  imageUri: z.string().min(3).max(500),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/, 'must be an immutable sha256 digest'),
  architectures: z.array(z.string()).default(['amd64']),
});

export const validateSourceSchema = z.object({
  source: z.string().min(1).max(200_000),
  /** Also check this tenant's limits and features (ADR 0007). */
  tenantId: z.uuid().optional(),
});

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export const createImportSchema = z
  .object({
    tenantId: z.uuid().optional(),
    files: z.array(z.object({ path: z.string().min(1).max(500), content: z.string() })).max(2000).optional(),
    report: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Boolean(v.files) !== Boolean(v.report), 'Send either files or a report.')
  .refine((v) => !v.files || v.files.reduce((n, f) => n + f.content.length, 0) <= MAX_IMPORT_BYTES, 'Files exceed 5 MB.');

export const importToTemplateSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  displayName: z.string().min(2).max(80),
});

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  tenantId: string | null;
  role: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface WebhookDto {
  id: string;
  tenantId: string | null;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  consecutiveFailures: number;
  disabledReason: string | null;
  createdAt: string;
}

export interface WebhookDeliveryDto {
  id: string;
  event: string;
  status: 'PENDING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

/** Output of the orkstage-scan engine (docs/specs/integration-api.md, ScanReport v1). */
export interface ScanReport {
  version: 1;
  generator: string;
  detectors: { kind: string; files: number }[];
  resources: {
    id: string;
    type: string;
    provider: string | null;
    implementation?: string;
    properties: Record<string, unknown>;
    sources: { kind: string; file: string; line?: number; address: string }[];
    confidence: 'high' | 'medium' | 'low';
  }[];
  unmapped: { source: { kind: string; file: string; line?: number; address: string }; type: string; reason: string }[];
  connections: { from: string; to: string; protocol: string; port?: number; evidence: string }[];
  template: string;
  warnings: string[];
}

export interface ImportDto {
  id: string;
  tenantId: string | null;
  createdAt: string;
  sourceKinds: string[];
  report: ScanReport;
  validation: { valid: boolean; issues: { stage: string; severity: string; code: string; message: string; path?: string }[] };
  templateId: string | null;
}
