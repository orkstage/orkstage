#!/usr/bin/env node
/**
 * Checks the console dictionaries (messages/*.json):
 *   1. every locale has exactly the keys of en.json, all values are non-empty strings;
 *   2. every message is valid ICU and uses the same arguments in every locale;
 *   3. the writing rules hold for every value: no em/en dashes, no " - " punctuation, no ellipsis,
 *      no arrows, straight quotes only, no emoji, no hyphenated prose words (identifiers in the
 *      allowlist below are fine), no filler words (seamless, leverage, robust...);
 *   4. source files (src/**) contain none of the forbidden characters outside comments.
 *
 * Run: pnpm --filter @co/web check:i18n
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'en';
const LOCALES = ['en', 'pt-BR'];

/** Hyphenated tokens that are identifiers, examples or codes, not prose. */
const HYPHEN_ALLOWLIST = new Set([
  'pt-BR',
  'aws-sm',
  'name-or-arn',
  'nome-ou-arn',
  'acme-prod',
  'acme-staging',
  'my-template',
  'meu-template',
  'my-service',
  'meu-servico',
  'ci-deploy',
  'x-co-signature',
  'x-orkstage-signature',
  'us-east-1',
  'eu-west-1',
  'sa-east-1',
  'ecs-fargate',
  'rds-postgres',
  'elasticache-valkey',
  'docker-compose',
  'sha256-',
  'private-preferred',
  'OrkStage-Signature',
  'github-actions-deploy',
  '--with-token',
  'private-required',
]);

/**
 * Filler and hype wording. Matched at the start of a word, so stems also catch "seamlessly" or
 * "alavancar"; a trailing "$" means the whole word only ("elevate" but not "elevated").
 */
const FILLER_WORDS = [
  'seamless',
  'leverag',
  'robust',
  'empower',
  'unleash',
  'elevate$',
  'effortless',
  'streamline',
  'supercharg',
  'cutting edge',
  'game changer',
  'not just$',
  'alavanc',
  'potencializ',
  'sem esforço',
  'revolucion',
  'não apenas',
];
const FILLER_PATTERNS = FILLER_WORDS.map((w) => ({
  word: w.replace(/\$$/, ''),
  re: new RegExp(`(^|[^\\p{L}])${w.replace(/\$$/, '(?![\\p{L}])')}`, 'u'),
}));

const FORBIDDEN_CHARS = [
  ['—', 'em dash'],
  ['–', 'en dash'],
  ['…', 'ellipsis character'],
  ['→', 'arrow'],
  ['←', 'arrow'],
  ['⇒', 'arrow'],
  ['“', 'curly quote'],
  ['”', 'curly quote'],
  ['‘', 'curly quote'],
  ['’', 'curly quote'],
];

const errors = [];
const fail = (msg) => errors.push(msg);

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

function load(locale) {
  return JSON.parse(readFileSync(join(root, 'messages', `${locale}.json`), 'utf8'));
}

// ICU parser: a dependency of use-intl (via intl-messageformat), resolved through it.
const require = createRequire(join(root, 'package.json'));
let parse = null;
try {
  const fromUseIntl = createRequire(require.resolve('use-intl'));
  const fromIntlMf = createRequire(fromUseIntl.resolve('intl-messageformat'));
  ({ parse } = await import(pathToUrl(fromIntlMf.resolve('@formatjs/icu-messageformat-parser'))));
} catch (err) {
  fail(`Could not load the ICU parser to validate messages: ${err.message}`);
}

function pathToUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/').replace(/^\/+/, '')}`).href;
}

/** Argument names and literal text of an ICU message. */
function analyze(ast, args = new Set(), text = []) {
  for (const el of ast) {
    // TYPE: 0 literal, 1 argument, 2 number, 3 date, 4 time, 5 select, 6 plural, 7 pound, 8 tag
    if (el.type === 0) text.push(el.value);
    if ([1, 2, 3, 4, 5, 6].includes(el.type)) args.add(el.value);
    if (el.type === 5 || el.type === 6) for (const opt of Object.values(el.options)) analyze(opt.value, args, text);
    if (el.type === 8) {
      args.add(`<${el.value}>`);
      analyze(el.children, args, text);
    }
  }
  return { args, text };
}

function proseProblems(text) {
  const problems = [];
  for (const [ch, name] of FORBIDDEN_CHARS) if (text.includes(ch)) problems.push(name);
  if (/\s-\s/.test(text)) problems.push('hyphen used as punctuation (" - ")');
  if (text.includes('...')) problems.push('"..." ellipsis');
  if (/->|=>|<-/.test(text)) problems.push('arrow');
  if (/\p{Extended_Pictographic}/u.test(text)) problems.push('emoji');
  const lower = text.toLowerCase();
  for (const { word, re } of FILLER_PATTERNS) if (re.test(lower)) problems.push(`filler wording "${word}"`);
  // Hyphenated words: allowed only for identifiers (allowlist), URLs and paths.
  const tokens = text.split(/\s+/);
  for (const raw of tokens) {
    const token = raw.replace(/^[("'`[]+|[)"'`\].,:;!?]+$/g, '');
    if (!/\p{L}-\p{L}/u.test(token)) continue;
    if (token.includes('://') || token.includes('/') || /\.[a-z]{2,4}$/.test(token)) continue;
    if (HYPHEN_ALLOWLIST.has(token) || [...HYPHEN_ALLOWLIST].some((a) => a.endsWith('-') && token.startsWith(a))) continue;
    problems.push(`hyphenated word "${token}"`);
  }
  return problems;
}

const dictionaries = Object.fromEntries(LOCALES.map((l) => [l, flatten(load(l))]));
const source = dictionaries[SOURCE];

for (const locale of LOCALES) {
  const dict = dictionaries[locale];
  for (const key of source.keys()) if (!dict.has(key)) fail(`${locale}: missing key ${key}`);
  for (const key of dict.keys()) if (!source.has(key)) fail(`${locale}: extra key ${key} (not in ${SOURCE}.json)`);
  for (const [key, value] of dict) {
    if (typeof value !== 'string') {
      fail(`${locale}: ${key} must be a string`);
      continue;
    }
    if (!value.trim()) {
      fail(`${locale}: ${key} is empty`);
      continue;
    }
    if (key.includes('-')) fail(`${locale}: key ${key} must not contain "-" (use camelCase)`);
    let text = value;
    if (parse) {
      try {
        const analyzed = analyze(parse(value));
        text = analyzed.text.join(' ');
        if (locale !== SOURCE && source.has(key) && typeof source.get(key) === 'string') {
          const expected = [...analyze(parse(source.get(key))).args].sort().join(', ');
          const actual = [...analyzed.args].sort().join(', ');
          if (expected !== actual) fail(`${locale}: ${key} uses arguments [${actual}] but ${SOURCE} uses [${expected}]`);
        }
      } catch (err) {
        fail(`${locale}: ${key} is not valid ICU (${err.message})`);
      }
    }
    for (const p of proseProblems(text)) fail(`${locale}: ${key}: ${p}: "${value}"`);
    if (value !== value.trim()) fail(`${locale}: ${key}: leading or trailing whitespace`);
    if (/ {2,}/.test(value)) fail(`${locale}: ${key}: double space`);
  }
}

// Source files: forbidden characters outside comments (comments are not user visible).
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');
}
for (const file of walk(join(root, 'src'))) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const [ch, name] of FORBIDDEN_CHARS) {
      if (line.includes(ch)) fail(`${relative(root, file)}:${i + 1}: ${name} in source text`);
    }
  });
}

if (errors.length) {
  console.error(`i18n check failed (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`i18n check passed: ${source.size} keys in ${LOCALES.join(', ')}.`);
