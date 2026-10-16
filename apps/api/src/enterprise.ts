// SPDX-License-Identifier: AGPL-3.0-only
import type { Type } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The Enterprise module, when this build has it. The Enterprise source lives in the private
 * orkstage-ee repository, a git submodule at src/ee: official images are built with it, and a clone
 * without access to it builds the Community edition, where this returns undefined. The core never
 * imports the Enterprise code by name (docs/OPEN_CORE.md); it only loads this one entry point.
 */
export async function loadEnterpriseModule(): Promise<Type | undefined> {
  const entry = new URL('./ee/ee.module.js', import.meta.url);
  if (!existsSync(fileURLToPath(entry))) return undefined;
  const loaded = (await import(entry.href)) as { EnterpriseModule?: Type };
  if (!loaded.EnterpriseModule) throw new Error(`${fileURLToPath(entry)} does not export EnterpriseModule`);
  return loaded.EnterpriseModule;
}
