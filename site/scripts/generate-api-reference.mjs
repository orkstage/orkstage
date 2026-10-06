// Generates the API reference pages (MDX) from openapi/orkstage.json with fumadocs-openapi.
// Output: content/docs/developer/api-reference/<tag>/<method>-<path>.mdx plus meta.json files.
// Hand-written files in that folder (index.mdx) are kept; generated ones are replaced.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateFiles } from 'fumadocs-openapi';
import { createOpenAPI } from 'fumadocs-openapi/server';
import { loadOrkstageDocument, OPENAPI_FILE, SCHEMA_ID, shortPath } from '../lib/openapi-document.mjs';

const OUT = './content/docs/developer/api-reference';
const KEEP = new Set(['index.mdx']);

// Readable section names for the Swagger tags the API declares, in sidebar order.
const TAG_TITLES = {
  auth: 'Authentication',
  tenants: 'Tenants and plans',
  templates: 'Templates',
  cloud: 'Cloud targets and applications',
  instances: 'Instances',
  deployments: 'Deployments',
  incidents: 'Incidents',
  operations: 'Operations',
  'api-keys': 'API keys',
  webhooks: 'Webhooks',
  ci: 'CI/CD intake',
  imports: 'IaC import',
  license: 'License',
  enterprise: 'Enterprise (ee/)',
};

if (!existsSync(OPENAPI_FILE)) {
  console.error(`[api-reference] ${OPENAPI_FILE} is missing. Run "pnpm openapi:refresh" with the API running.`);
  process.exit(1);
}
const doc = loadOrkstageDocument();

for (const entry of existsSync(OUT) ? readdirSync(OUT) : []) {
  if (!KEEP.has(entry)) rmSync(join(OUT, entry), { recursive: true, force: true });
}

const slug = (path) =>
  shortPath(path)
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'root';

const log = console.log;
console.log = () => {}; // generateFiles prints one line per file
try {
  await generateFiles({
    input: createOpenAPI({ input: { [SCHEMA_ID]: () => doc } }),
    output: OUT,
    per: 'operation',
    groupBy: 'tag',
    name: (output) => (output.type === 'operation' ? `${output.item.method}-${slug(output.item.path)}` : output.item.name),
    meta: true,
    includeDescription: true,
    addGeneratedComment: 'Generated from openapi/orkstage.json by scripts/generate-api-reference.mjs. Do not edit; run pnpm openapi:refresh.',
    frontmatter: (title, description) => ({
      title,
      description: description ?? `${title}: OrkStage Control API v1 endpoint reference.`,
    }),
  });
} finally {
  console.log = log;
}

const folders = readdirSync(OUT).filter((f) => statSync(join(OUT, f)).isDirectory());
for (const folder of folders) {
  const metaPath = join(OUT, folder, 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
  meta.title = TAG_TITLES[folder] ?? folder;
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}
const order = Object.keys(TAG_TITLES);
folders.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
writeFileSync(join(OUT, 'meta.json'), `${JSON.stringify({ title: 'API reference', pages: ['index', ...folders] }, null, 2)}\n`);

const operations = Object.values(doc.paths ?? {}).reduce((n, item) => n + Object.keys(item).length, 0);
console.log(`[api-reference] ${operations} operations in ${folders.length} sections from ${OPENAPI_FILE} (${doc.info?.title} ${doc.info?.version}).`);
