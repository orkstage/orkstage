// Audits the static export in out/ after `pnpm build`:
// - internal links and #anchors resolve to an exported file and an existing id,
// - every page has lang, one h1, ordered headings, main landmark, a unique title and meta
//   description of sensible length, a self canonical, hreflang alternates and valid JSON-LD,
// - images have alt text and explicit width/height,
// - sitemap.xml lists every indexable page and only existing ones, with alternates for the
//   bilingual pages.
// Usage: node scripts/check-site.mjs   (no dependencies; regex based on Next's predictable HTML)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const OUT = 'out';
const SITE = 'https://orkstage.io';
const BILINGUAL = new Map([
  ['/', { en: '/', 'pt-BR': '/pt-br/', 'x-default': '/' }],
  ['/pt-br/', { en: '/', 'pt-BR': '/pt-br/', 'x-default': '/' }],
]);

if (!existsSync(OUT)) {
  console.error('[check:site] out/ is missing. Run pnpm build first.');
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const htmlFiles = walk(OUT).filter((f) => f.endsWith('.html') && !f.includes(`${sep}_not-found`) && !f.startsWith(join(OUT, '404') + sep));
/** URL path of an exported HTML file: out/docs/x/index.html -> /docs/x/ */
const urlOf = (file) => {
  const rel = relative(OUT, file).split(sep).join('/');
  if (rel === '404.html') return '/404.html';
  return `/${rel.replace(/index\.html$/, '')}`;
};

const pages = new Map();
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  pages.set(urlOf(file), { file, html, ids: new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decode(m[1]))) });
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function attr(tag, name) {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1];
}

const problems = [];
const fail = (url, msg) => problems.push(`${url}: ${msg}`);
const titles = new Map();
const descriptions = new Map();
let linksChecked = 0;

/** Resolves an internal href to an exported file (and page record when it is HTML). */
function resolve(path) {
  const clean = decodeURIComponent(path);
  if (pages.has(clean)) return { page: pages.get(clean) };
  const file = join(OUT, clean);
  if (existsSync(file) && statSync(file).isFile()) return { file };
  if (pages.has(`${clean}/`)) return { page: pages.get(`${clean}/`), redirect: true };
  return null;
}

for (const [url, { html }] of pages) {
  const is404 = url === '/404.html';
  const head = html.slice(0, html.indexOf('</head>'));
  const body = html.slice(html.indexOf('<body'));
  const lang = html.match(/<html[^>]*\slang="([^"]+)"/)?.[1];
  const expectedLang = url.startsWith('/pt-br/') ? 'pt-BR' : 'en';
  if (lang !== expectedLang) fail(url, `<html lang="${lang}">, expected "${expectedLang}"`);

  const title = decode(head.match(/<title>([^<]*)<\/title>/)?.[1] ?? '');
  const description = decode(head.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '');
  if (!title) fail(url, 'missing <title>');
  else if (title.length > 70) fail(url, `title is ${title.length} characters: ${title}`);
  if (!description) fail(url, 'missing meta description');
  else if (description.length < 50 || description.length > 170) fail(url, `meta description is ${description.length} characters`);
  if (!is404) {
    if (titles.has(title)) fail(url, `duplicate title (also ${titles.get(title)}): ${title}`);
    titles.set(title, url);
    if (descriptions.has(description)) fail(url, `duplicate description (also ${descriptions.get(description)})`);
    descriptions.set(description, url);
  }

  // Indexing tags
  if (is404) {
    if (!/<meta name="robots" content="noindex/.test(head)) fail(url, '404 page should be noindex');
  } else {
    const canonical = head.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    if (canonical !== `${SITE}${url}`) fail(url, `canonical is ${canonical}`);
    const alternates = Object.fromEntries([...head.matchAll(/<link rel="alternate" hrefLang="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    const expected = BILINGUAL.get(url) ?? { en: url, 'x-default': url };
    for (const [hl, path] of Object.entries(expected)) if (alternates[hl] !== `${SITE}${path}`) fail(url, `hreflang ${hl} is ${alternates[hl]}, expected ${SITE}${path}`);
    for (const hl of Object.keys(alternates)) if (!(hl in expected)) fail(url, `unexpected hreflang ${hl}`);
    for (const p of ['og:title', 'og:description', 'og:url', 'og:image', 'og:locale', 'twitter:card']) {
      if (!head.includes(`property="${p}"`) && !head.includes(`name="${p}"`)) fail(url, `missing ${p}`);
    }
    const ogLocale = head.match(/property="og:locale" content="([^"]+)"/)?.[1];
    if (ogLocale !== (expectedLang === 'pt-BR' ? 'pt_BR' : 'en_US')) fail(url, `og:locale is ${ogLocale}`);
    if (BILINGUAL.has(url) && !head.includes('property="og:locale:alternate"')) fail(url, 'missing og:locale:alternate');

    // JSON-LD
    const types = new Set();
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try {
        const data = JSON.parse(m[1]);
        for (const node of data['@graph'] ?? [data]) types.add(node['@type']);
      } catch (e) {
        fail(url, `invalid JSON-LD: ${e.message}`);
      }
    }
    const needed = BILINGUAL.has(url) ? ['Organization', 'WebSite', 'SoftwareApplication'] : ['TechArticle', 'BreadcrumbList'];
    for (const t of needed) if (!types.has(t)) fail(url, `JSON-LD missing ${t}`);
  }

  // Structure
  const h1 = (body.match(/<h1[\s>]/g) ?? []).length;
  if (h1 !== 1 && !(is404 && h1 === 2)) fail(url, `${h1} h1 elements`);
  if (!/<main[\s>]/.test(body)) fail(url, 'no <main> landmark');
  let prev = 0;
  for (const m of body.matchAll(/<h([1-6])[\s>]/g)) {
    const level = Number(m[1]);
    if (prev && level > prev + 1) {
      fail(url, `heading level jumps from h${prev} to h${level}`);
      break;
    }
    prev = level;
  }
  for (const m of body.matchAll(/<img\b[^>]*>/g)) {
    const tag = m[0];
    if (attr(tag, 'alt') === undefined) fail(url, `img without alt: ${tag.slice(0, 80)}`);
    if (!attr(tag, 'width') || !attr(tag, 'height')) fail(url, `img without width/height: ${attr(tag, 'src')}`);
  }

  // Links
  for (const m of body.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = decode(m[1]);
    const text = m[2].replace(/<[^>]+>/g, '').trim().toLowerCase();
    if (['click here', 'here', 'read more', 'more', 'link', 'aqui', 'clique aqui', 'saiba mais'].includes(text)) fail(url, `non descriptive link text "${text}"`);
    if (/^(https?:|mailto:|tel:|data:)/.test(href) || href === '') continue;
    linksChecked++;
    const [pathPart, hash] = href.split('#');
    const base = pathPart ? new URL(pathPart, `${SITE}${url}`).pathname : url;
    const target = resolve(base);
    if (!target) {
      fail(url, `broken link ${href}`);
      continue;
    }
    if (target.redirect) fail(url, `link without trailing slash ${href}`);
    if (hash && target.page && !target.page.ids.has(decodeURIComponent(hash))) fail(url, `missing anchor ${href}`);
  }
}

// Sitemap
const sitemap = readFileSync(join(OUT, 'sitemap.xml'), 'utf8');
const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(SITE, ''));
for (const path of listed) if (!pages.has(path)) fail('sitemap.xml', `lists ${path}, which is not exported`);
for (const url of pages.keys()) if (url !== '/404.html' && !listed.includes(url)) fail('sitemap.xml', `missing ${url}`);
for (const [url, alts] of BILINGUAL) {
  const entry = sitemap.split('<url>').find((u) => u.includes(`<loc>${SITE}${url}</loc>`)) ?? '';
  for (const [hl, path] of Object.entries(alts)) if (!entry.includes(`hreflang="${hl}" href="${SITE}${path}"`)) fail('sitemap.xml', `${url} missing alternate ${hl}`);
}
if (!/Sitemap: https:\/\/orkstage\.io\/sitemap\.xml/.test(readFileSync(join(OUT, 'robots.txt'), 'utf8'))) fail('robots.txt', 'does not point to the sitemap');

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n[check:site] ${problems.length} problem(s) in ${pages.size} page(s).`);
  process.exit(1);
}
console.log(`[check:site] ${pages.size} pages, ${linksChecked} internal links, ${listed.length} sitemap URLs: all clean.`);
