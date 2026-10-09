import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Last modification date of a source file, for sitemap `lastmod` and JSON-LD `dateModified`.
 * Committed, unchanged files use the date of their last commit (stable across builds and
 * checkouts). Files with local changes, or untracked ones, use their mtime. Without git (e.g. a
 * tarball build) the date is omitted rather than invented.
 */
let commitDates: Map<string, string> | null | undefined;
let dirty: Set<string> = new Set();

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

function load(): Map<string, string> | null {
  if (commitDates !== undefined) return commitDates;
  try {
    const log = git(['log', '--format=@%cI', '--name-only', '--relative', '--', '.']);
    const map = new Map<string, string>();
    let date = '';
    for (const line of log.split('\n')) {
      if (line.startsWith('@')) date = line.slice(1).trim();
      else if (line.trim() && !map.has(line.trim())) map.set(line.trim(), date);
    }
    dirty = new Set(
      git(['ls-files', '--modified', '--others', '--exclude-standard'])
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    commitDates = map;
  } catch {
    commitDates = null;
  }
  return commitDates;
}

/** ISO date of the most recent change among `files` (paths relative to the site root). */
export function lastModified(...files: string[]): string | undefined {
  const dates = load();
  if (!dates) return undefined;
  let latest: string | undefined;
  for (const file of files.map((f) => f.replace(/\\/g, '/'))) {
    let date: string | undefined;
    if (dirty.has(file) || !dates.has(file)) {
      try {
        date = statSync(join(process.cwd(), file)).mtime.toISOString();
      } catch {
        date = undefined;
      }
    } else {
      date = dates.get(file);
    }
    if (date && (!latest || Date.parse(date) > Date.parse(latest))) latest = date;
  }
  return latest ? new Date(latest).toISOString() : undefined;
}

/** Source files whose content makes up the landing page in a given locale. */
export const landingSources = {
  en: ['lib/i18n/messages/en.ts', 'components/landing/home-page.tsx', 'components/landing/artifacts.tsx', 'components/landing/topology.tsx'],
  'pt-BR': ['lib/i18n/messages/pt-br.ts', 'components/landing/home-page.tsx', 'components/landing/artifacts.tsx', 'components/landing/topology.tsx'],
} as const;
