import { defineConfig, env } from 'prisma/config';

// Prisma 7 does not load .env files itself.
try {
  process.loadEnvFile('../../.env');
} catch {
  // No root .env: rely on the process environment (CI, containers).
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
