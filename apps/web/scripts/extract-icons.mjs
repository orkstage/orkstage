#!/usr/bin/env node
/**
 * Extracts only the brand/service icons the console uses from @iconify-json/logos (CC0, a
 * devDependency) into src/lib/cloud-icons.json, which is committed. The app renders them
 * offline with <Icon icon={data} />: the full icon set is never shipped and Iconify never
 * fetches from its API at runtime.
 *
 * Run: node apps/web/scripts/extract-icons.mjs   (re-run after changing ICONS)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICONS = [
  // providers
  'aws',
  'azure-icon',
  'google-cloud',
  'oracle',
  // AWS services
  'aws-vpc',
  'aws-ecs',
  'aws-fargate',
  'aws-rds',
  'aws-elasticache',
  'aws-sqs',
  'aws-s3',
  'aws-elb',
  'aws-route53',
  // technologies
  'postgresql',
  'redis',
  'docker',
];

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const setPath = require.resolve('@iconify-json/logos/icons.json');
const set = JSON.parse(readFileSync(setPath, 'utf8'));

const out = {};
const missing = [];
for (const name of ICONS) {
  const icon = set.icons[name];
  if (!icon) {
    missing.push(name);
    continue;
  }
  out[name] = {
    body: icon.body,
    width: icon.width ?? set.width ?? 16,
    height: icon.height ?? set.height ?? 16,
    ...(icon.left !== undefined ? { left: icon.left } : {}),
    ...(icon.top !== undefined ? { top: icon.top } : {}),
  };
}
if (missing.length) {
  console.error(`Missing icons in @iconify-json/logos: ${missing.join(', ')}`);
  process.exit(1);
}
const target = resolve(here, '../src/lib/cloud-icons.json');
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${Object.keys(out).length} icons to ${target}`);
