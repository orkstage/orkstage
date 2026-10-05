import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTemplate } from './validation.js';
import type { EnvironmentTemplate } from './schema.js';

const BUILTIN_DIR = fileURLToPath(new URL('../builtin/', import.meta.url));

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
