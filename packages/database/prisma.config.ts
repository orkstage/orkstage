// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'prisma/config';

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
    // `prisma generate` (part of every build) needs no database, so a fresh clone must build
    // without one. Migrate/seed commands still need a real DATABASE_URL and fail clearly without it.
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/orkstage',
  },
});
