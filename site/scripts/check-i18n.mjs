// Checks the marketing copy dictionaries (lib/i18n/messages/*.ts):
// 1. every locale has exactly the keys of the English dictionary (same nesting, same array sizes),
// 2. no value is empty,
// 3. every value follows the writing rules (scripts/lib/prose.mjs): no dashes or hyphens in prose,
//    no ellipsis, arrows or curly quotes, no filler phrases; text in backticks is code and skipped,
// 4. page titles and meta descriptions fit search result limits.
// Node strips the TypeScript types on import (Node 24+).
// Usage: node scripts/check-i18n.mjs
import { headingProblems, proseProblems, stripInline } from './lib/prose.mjs';

const { en } = await import('../lib/i18n/messages/en.ts');
const { ptBR } = await import('../lib/i18n/messages/pt-br.ts');
const dictionaries = { en, 'pt-BR': ptBR };

/** Values checked as headings (sentence case, no question): titles and section titles. */
const HEADING_KEY = /(^|\.)(title|[a-z]+Title|headline)$/;
const LIMITS = { 'meta.title': [20, 60], 'meta.description': [70, 160] };

const failures = [];

function flatten(value, prefix = '', out = new Map()) {
  if (typeof value === 'string') out.set(prefix, value);
  else if (Array.isArray(value)) value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  else out.set(prefix, value);
  return out;
}

const flat = Object.fromEntries(Object.entries(dictionaries).map(([locale, dict]) => [locale, flatten(dict)]));
const reference = flat.en;

for (const [locale, entries] of Object.entries(flat)) {
  if (locale !== 'en') {
    for (const key of reference.keys()) if (!entries.has(key)) failures.push(`${locale}: missing key ${key}`);
    for (const key of entries.keys()) if (!reference.has(key)) failures.push(`${locale}: extra key ${key}`);
  }
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      failures.push(`${locale}.${key}: not a string`);
      continue;
    }
    if (!value.trim()) failures.push(`${locale}.${key}: empty`);
    const text = stripInline(value);
    const problems = HEADING_KEY.test(key) ? headingProblems(text) : proseProblems(text);
    for (const p of problems) failures.push(`${locale}.${key}: ${p}\n    ${value}`);
    const limit = LIMITS[key];
    if (limit && (value.length < limit[0] || value.length > limit[1])) failures.push(`${locale}.${key}: length ${value.length}, expected ${limit[0]} to ${limit[1]}\n    ${value}`);
  }
}

// Titles and descriptions must differ between locales (a missed translation shows up here).
for (const key of ['meta.title', 'meta.description', 'hero.lead']) {
  if (flat.en.get(key) === flat['pt-BR'].get(key)) failures.push(`pt-BR.${key}: identical to English`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`\n[check:i18n] ${failures.length} problem(s).`);
  process.exit(1);
}
console.log(`[check:i18n] ${Object.keys(dictionaries).length} dictionaries, ${reference.size} keys each, all values clean.`);
