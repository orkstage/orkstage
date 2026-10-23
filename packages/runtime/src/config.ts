// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** Typed, validated environment configuration (spec §55). Startup fails fast on bad config. */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    API_PORT: z.coerce.number().int().default(4000),
    API_PUBLIC_URL: z.url().default('http://localhost:4000'),
    WEB_PUBLIC_URL: z.url().default('http://localhost:3000'),
    SESSION_SECRET: z.string().min(32),
    AUTH_DEV_LOGIN_ENABLED: bool.default(false),
    OIDC_ENTRA_ISSUER: z.string().optional(),
    OIDC_ENTRA_CLIENT_ID: z.string().optional(),
    OIDC_ENTRA_CLIENT_SECRET: z.string().optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    // Deployments running at once per tenant and per provider region, across all workers (0 = no
    // limit). Per cloud target limits are set on each target.
    DEPLOY_LIMIT_PER_TENANT: z.coerce.number().int().min(0).default(5),
    DEPLOY_LIMIT_PER_PROVIDER_REGION: z.coerce.number().int().min(0).default(20),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().default(1025),
    SMTP_SECURE: bool.default(false),
    /** SMTP authentication, for providers that require it (most do outside a local relay). */
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    EMAIL_FROM: z.string().default('OrkStage <noreply@example.local>'),
    /** `smtp` (SMTP_*) or `ses` (Amazon SES v2 with the worker's AWS credentials and AWS_REGION). */
    EMAIL_TRANSPORT: z.enum(['smtp', 'ses']).default('smtp'),
    /** Notification emails one person receives per hour at most; the rest stay in the console. */
    EMAIL_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(30),
    HEALTH_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(30),
    // Days of per resource health check history kept (uptime and trends); older rows are deleted.
    HEALTH_HISTORY_DAYS: z.coerce.number().int().min(1).max(400).default(30),
    // Drift scans re-plan every applied resource on real providers (one OpenTofu plan each). 0 = off.
    DRIFT_CHECK_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(360),
    // OpenTofu runner (worker only). Each command runs in a throwaway container.
    TOFU_IMAGE: z.string().default('ghcr.io/opentofu/opentofu:1.13.2'),
    TOFU_MODULES_DIR: z.string().optional(),
    TOFU_WORK_DIR: z.string().optional(),
    TOFU_PLUGIN_CACHE_VOLUME: z.string().default('orkstage-tofu-plugins'),
    TOFU_DOCKER_NETWORK: z.string().optional(),
    // Containerized worker: named volume mounted at TOFU_WORK_DIR, and modules baked into TOFU_IMAGE.
    TOFU_WORK_VOLUME: z.string().optional(),
    TOFU_MODULES_IN_IMAGE: bool.default(false),
    // Emulator endpoint as reachable from inside containers (e.g. http://ministack:4566).
    AWS_EMULATOR_ENDPOINT: z.string().optional(),
    // aws-sm:// secret references: default region (ARNs carry their own) and an optional endpoint
    // override for emulators, as reachable from the API/worker process.
    SECRETS_AWS_REGION: z.string().default('us-east-1'),
    SECRETS_AWS_ENDPOINT: z.string().optional(),
    // 32 random bytes, base64. Encrypts secrets the platform must read back (webhook secrets).
    ENCRYPTION_KEY: z.string().optional(),
    // Local development only: allow http:// and private-network webhook URLs.
    WEBHOOK_ALLOW_PRIVATE: bool.default(false),
    // OrkStage Enterprise license key (orkstage-license.v1.…). Empty = Community edition.
    ORKSTAGE_LICENSE_KEY: z.string().optional(),
    TOFU_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(45),
    // AWS AssumeRole session length. Each OpenTofu run needs credentials that outlive
    // TOFU_TIMEOUT_MINUTES; above 60, raise the role's MaxSessionDuration to match.
    AWS_ROLE_SESSION_MINUTES: z.coerce.number().int().min(15).max(720).default(60),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    // Reverse proxies in front of the API (the console's rewrite counts as one). The client
    // address is read that many hops back in X-Forwarded-For, so clients cannot spoof it.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    // OpenAPI document and Swagger UI at /api/docs. Defaults to off in production.
    API_DOCS_ENABLED: bool.optional(),
    // Sessions end after this long without a request, besides the absolute 12 hour limit.
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && c.AUTH_DEV_LOGIN_ENABLED) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_LOGIN_ENABLED'], message: 'Dev login must be disabled in production.' });
    }
    if (c.NODE_ENV === 'production' && !c.ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', path: ['ENCRYPTION_KEY'], message: 'Set ENCRYPTION_KEY (32 bytes, base64) in production.' });
    }
    if (c.NODE_ENV === 'production' && c.WEBHOOK_ALLOW_PRIVATE) {
      ctx.addIssue({ code: 'custom', path: ['WEBHOOK_ALLOW_PRIVATE'], message: 'Private webhook targets are not allowed in production.' });
    }
    if (c.NODE_ENV === 'production' && c.SESSION_SECRET.startsWith('change-me')) {
      ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'Set a real session secret in production.' });
    }
  });

export type PlatformConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}

/** Loads the repo-root .env during local development; real environments inject variables. */
export function loadDotEnv(path = '../../.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // no .env file: rely on the process environment
  }
}
