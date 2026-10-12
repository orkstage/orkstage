// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTemplate } from './validation.js';
import type { EnvironmentTemplate } from './schema.js';

const BUILTIN_DIR = fileURLToPath(new URL('../builtin/', import.meta.url));
const MARKETPLACE_DIR = fileURLToPath(new URL('../marketplace/', import.meta.url));

export interface BuiltinTemplate {
  source: string;
  template: EnvironmentTemplate;
}

/** Loads and schema-validates the built-in templates shipped with the platform. */
export function loadBuiltinTemplates(): BuiltinTemplate[] {
  return readdirSync(BUILTIN_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => {
      const source = readFileSync(`${BUILTIN_DIR}${file}`, 'utf8');
      const parsed = parseTemplate(source);
      if (!parsed.ok) {
        throw new Error(`Built-in template ${file} is invalid: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
      }
      return { source, template: parsed.template };
    });
}

/** Listing metadata shipped with a curated marketplace template. */
export interface MarketplaceSeed {
  slug: string;
  title: string;
  summary: string;
  categories: string[];
  tags: string[];
  badges: ('VERIFIED' | 'DEVOPS')[];
  source: string;
  template: EnvironmentTemplate;
}

/**
 * Curated templates published to the marketplace by OrkStage (`marketplace/*.yaml` plus
 * `marketplace/listings.json`). Each one is schema validated here; the listing slug is the
 * template name.
 */
export function loadMarketplaceTemplates(): MarketplaceSeed[] {
  const listings = JSON.parse(readFileSync(`${MARKETPLACE_DIR}listings.json`, 'utf8')) as (Omit<MarketplaceSeed, 'slug' | 'source' | 'template'> & { template: string })[];
  return listings.map((l) => {
    const source = readFileSync(`${MARKETPLACE_DIR}${l.template}.yaml`, 'utf8');
    const parsed = parseTemplate(source);
    if (!parsed.ok) {
      throw new Error(`Marketplace template ${l.template} is invalid: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    }
    return { ...l, slug: l.template, source, template: parsed.template };
  });
}
