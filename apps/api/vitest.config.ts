// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

/** Unit tests only; the integration suite in test/ has its own config (vitest.integration.config.ts). */
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
