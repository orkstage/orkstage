// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

/**
 * API integration tests: they boot the built application (dist/, which carries the decorator
 * metadata Nest needs) against the Postgres and Redis of DATABASE_URL and REDIS_URL, migrated and
 * seeded with demo data. Files run one after another: they share the database and Redis.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
