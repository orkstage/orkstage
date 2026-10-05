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
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().default(1025),
    SMTP_SECURE: bool.default(false),
    EMAIL_FROM: z.string().default('OrkStage <noreply@example.local>'),
    HEALTH_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(30),
    // OpenTofu runner (worker only). Each command runs in a throwaway container.
    TOFU_IMAGE: z.string().default('ghcr.io/opentofu/opentofu:1.12.7'),
    TOFU_MODULES_DIR: z.string().optional(),
    TOFU_WORK_DIR: z.string().optional(),
    TOFU_PLUGIN_CACHE_VOLUME: z.string().default('orkstage-tofu-plugins'),
    TOFU_DOCKER_NETWORK: z.string().optional(),
    // Containerized worker: named volume mounted at TOFU_WORK_DIR, and modules baked into TOFU_IMAGE.
    TOFU_WORK_VOLUME: z.string().optional(),
    TOFU_MODULES_IN_IMAGE: bool.default(false),
    // Emulator endpoint as reachable from inside containers (e.g. http://ministack:4566).
    AWS_EMULATOR_ENDPOINT: z.string().optional(),
    // 32 random bytes, base64. Encrypts secrets the platform must read back (webhook secrets).
    ENCRYPTION_KEY: z.string().optional(),
    // Local development only: allow http:// and private-network webhook URLs.
    WEBHOOK_ALLOW_PRIVATE: bool.default(false),
    TOFU_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(45),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
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
