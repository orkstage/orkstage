// Checks the writing rules on every handwritten docs page (content/docs/**/*.mdx and meta.json):
// forbidden characters, hyphens in prose, filler phrases, sentence case headings, and SEO limits on
// front matter (title and description length). Generated API reference pages are skipped: their
// text comes from the API's OpenAPI document.
// Usage: node scripts/check-prose.mjs [path ...]   (default: content/docs)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { headingProblems, mdxToProse, proseProblems } from './lib/prose.mjs';

const GENERATED = join('content', 'docs', 'developer', 'api-reference');
/** "<title> | OrkStage" must fit in about 60 characters. */
const TITLE_MAX = 60 - ' | OrkStage'.length;
const DESCRIPTION_MIN = 70;
const DESCRIPTION_MAX = 160;

function walk(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

function isGenerated(file) {
  const rel = relative('.', file);
  return rel.startsWith(GENERATED + sep) && !rel.endsWith(`${sep}index.mdx`) && rel !== join(GENERATED, 'meta.json');
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['content/docs'];
const files = targets.flatMap(walk).filter((f) => /\.(mdx|json)$/.test(f) && !isGenerated(f));
const failures = [];
const report = (file, line, problem, text) => failures.push(`${relative('.', file)}:${line}: ${problem}${text ? `\n    ${text.trim()}` : ''}`);

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const meta = JSON.parse(source);
    for (const key of ['title', 'description']) {
      if (typeof meta[key] !== 'string') continue;
      const problems = key === 'title' ? headingProblems(meta[key]) : proseProblems(meta[key]);
      for (const p of problems) report(file, 1, `${key}: ${p}`, meta[key]);
    }
    continue;
  }
  for (const m of source.matchAll(/^(title|description): ([^"'\r\n].*)$/gm)) {
    if (/: |#/.test(m[2])) report(file, 1, `front matter ${m[1]} contains ": " or "#" and must be quoted (YAML)`, m[2]);
  }
  const frontTitle =source.match(/^---\r?\n(?:.*\r?\n)*?title:\s*(.*)\r?\n/)?.[1]?.replace(/^["']|["']$/g, '');
  const frontDescription = source.match(/^---\r?\n(?:.*\r?\n)*?description:\s*(.*)\r?\n/)?.[1]?.replace(/^["']|["']$/g, '');
  if (!frontTitle) report(file, 1, 'missing front matter title');
  else if (frontTitle.length > TITLE_MAX) report(file, 1, `title longer than ${TITLE_MAX} characters (${frontTitle.length})`, frontTitle);
  if (!frontDescription) report(file, 1, 'missing front matter description');
  else if (frontDescription.length < DESCRIPTION_MIN || frontDescription.length > DESCRIPTION_MAX)
    report(file, 1, `description must be ${DESCRIPTION_MIN} to ${DESCRIPTION_MAX} characters (${frontDescription.length})`, frontDescription);

  for (const { line, text, heading } of mdxToProse(source)) {
    for (const p of heading ? headingProblems(text) : proseProblems(text)) report(file, line, p, text);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`\n[check:prose] ${failures.length} problem(s) in ${files.length} file(s).`);
  process.exit(1);
}
console.log(`[check:prose] ${files.length} file(s) clean.`);
