// Windows only. `next build` with `output: 'export'` names the router's prefetch files
// `__next.<segment path with dots>.txt`, but on Windows the segment path uses "\" and Next only
// replaces "/", so the files land in nested folders (`__next.!KGVuKQ/docs.txt`) and every client
// prefetch gets a 404. This moves them to the flat names the router requests. On Linux and macOS
// (CI) the export is already right and this script does nothing.
import { readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

if (process.platform !== 'win32') process.exit(0);

const OUT = 'out';
let moved = 0;

function files(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

function visit(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!statSync(path).isDirectory()) continue;
    if (entry.startsWith('__next.')) {
      for (const file of files(path)) {
        const flat = `${entry}.${relative(path, file).split(sep).join('.')}`;
        renameSync(file, join(dir, flat));
        moved++;
      }
      rmSync(path, { recursive: true, force: true });
    } else if (entry !== '_next') {
      visit(path);
    }
  }
}

visit(OUT);
console.log(`[fix-segment-files] ${moved} prefetch file(s) renamed.`);
