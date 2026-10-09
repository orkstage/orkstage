// Writing rules shared by scripts/check-i18n.mjs (dictionaries) and scripts/check-prose.mjs (MDX).
// The rules apply to prose only: code blocks, inline code, URLs, identifiers and JSX attribute
// values that are not visible text are removed before checking (see `mdxToProse`).

/** Characters that never appear in prose. */
const FORBIDDEN_CHARS = [
  ['\u2014', 'em dash'],
  ['\u2013', 'en dash'],
  ['\u2026', 'ellipsis character'],
  ['\u2192', 'arrow'],
  ['\u21D2', 'arrow'],
  ['\u2190', 'arrow'],
  ['\u2194', 'arrow'],
  ['\u201C', 'curly quote'],
  ['\u201D', 'curly quote'],
  ['\u2018', 'curly quote'],
  ['\u2019', 'curly quote'],
  ['\u2022', 'bullet character'],
];

/** Words and phrases that read as filler or marketing boilerplate (English and Portuguese). */
const BANNED_PHRASES = [
  /\bseamless(ly)?\b/i,
  /\bleverag(e|es|ed|ing)\b/i,
  /\brobust(ness)?\b/i,
  /\bunleash/i,
  /\bempower/i,
  /\belevat(e|es|ed|ing)\b/i,
  /\bdelv(e|es|ing)\b/i,
  /\bcutting edge\b/i,
  /\bgame changer\b/i,
  /\bsupercharg/i,
  /\brevolutioni[sz]/i,
  /\beffortless(ly)?\b/i,
  /\bstreamlin/i,
  /\bharness(es|ed|ing)?\b/i,
  /\bworld class\b/i,
  /\bnext generation\b/i,
  /\bfast paced\b/i,
  /\bnot just\b.*\bbut\b/i,
  /\bwhether you('re| are)\b/i,
  /\bsay goodbye\b/i,
  /\blook no further\b/i,
  /\bmoreover\b/i,
  /\bfurthermore\b/i,
  /\badditionally\b/i,
  // Portuguese
  /\bperfeitamente integrad/i,
  /\balavanc/i,
  /\bpotencializ/i,
  /\brevolucion/i,
  /\bde ponta\b/i,
  /\bsem esfor[cç]o\b/i,
  /\bdiga adeus\b/i,
  /\bn[aã]o procure mais\b/i,
  /\bademais\b/i,
  /\boutrossim\b/i,
  /\bal[eé]m disso\b/i,
  /\bn[aã]o apenas\b.*\bmas\b/i,
  /\bseja voc[eê]\b/i,
  /\bpróxima geração\b/i,
  /\bde classe mundial\b/i,
];

/**
 * Hyphenated tokens that are names or identifiers, not prose compounds. Anything else written as
 * word-word must be rewritten (open form or rephrase) or put in inline code.
 */
const HYPHEN_ALLOW = new Set([
  'pt-BR',
  'en-US',
  'x-default',
  'Apache-2.0',
]);
/** Uppercase/digit tokens such as AGPL-3.0, SHA-256, AES-256-GCM, CC-BY-4.0, ISO-8601. */
const HYPHEN_ALLOW_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9][A-Za-z0-9.]*)+$/;

const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Checks one line of prose. Returns a list of problems (empty when clean).
 * @param {string} text
 * @returns {string[]}
 */
export function proseProblems(text) {
  const problems = [];
  for (const [ch, name] of FORBIDDEN_CHARS) if (text.includes(ch)) problems.push(`${name} (${JSON.stringify(ch)})`);
  if (/(^|\s)--?(\s|$)/.test(text)) problems.push('hyphen used as punctuation (" - ")');
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}.]*(?:-[\p{L}\p{N}][\p{L}\p{N}.]*)+/gu)) {
    const token = m[0].replace(/\.+$/, '');
    if (HYPHEN_ALLOW.has(token) || HYPHEN_ALLOW_PATTERN.test(token)) continue;
    problems.push(`hyphenated word "${token}"`);
  }
  if (EMOJI.test(text.replace(/[©®™]/g, ''))) problems.push('emoji');
  for (const re of BANNED_PHRASES) {
    const m = text.match(re);
    if (m) problems.push(`banned phrase "${m[0]}"`);
  }
  return problems;
}

/**
 * Checks a heading: sentence case and no question headings, on top of the prose rules.
 * Capitalized words after the first are allowed only for names (see `NAMES`), acronyms and
 * identifiers.
 */
export function headingProblems(text) {
  const problems = proseProblems(text);
  if (/\?\s*$/.test(text)) problems.push('question used as a heading');
  const words = text
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s/]+/)
    .filter(Boolean);
  // A capital is expected on the first word of each sentence (after ".", ":", "!" or "?").
  let sentenceStart = true;
  for (const raw of words) {
    const startsSentence = sentenceStart;
    sentenceStart = /[.:!?]$/.test(raw);
    if (!/\p{L}/u.test(raw)) {
      sentenceStart ||= startsSentence;
      continue;
    }
    if (startsSentence) continue;
    const w = raw.replace(/[^\p{L}\p{N}.'-]/gu, '').replace(/\.+$/, '');
    if (!w || !/^\p{Lu}/u.test(w)) continue;
    if (/^\p{Lu}[\p{Lu}\p{N}]+s?$/u.test(w)) continue; // acronym (API, AWS, OIDC, IaC handled below)
    if (/\p{Lu}/u.test(w.slice(1))) continue; // internal capital: OpenTofu, MiniStack, IaC
    if (NAMES.has(w)) continue;
    problems.push(`heading not in sentence case ("${raw}")`);
  }
  return problems;
}

/** Proper nouns that keep their capital letter inside a sentence case heading. */
const NAMES = new Set(
  `OrkStage Ork Azure Postgres Redis Valkey Docker Compose Kubernetes Helm Terraform Mailpit Google Entra Microsoft Amazon Fargate Route Lambda
  Git Linux Windows Node Rust Next.js Fumadocs Prometheus Grafana Loki Jira ServiceNow PagerDuty Opsgenie Slack Teams Okta Keycloak Auth0
  Community Enterprise Preview Planned Control Console Brazil English Portuguese Português Inglês Brasil OpenAPI Swagger Pino Vault Bitnami
  CloudFront Caddy Nginx Traefik Prisma NestJS React Vite Turborepo Wasm WebAssembly SAM Contributor Covenant Apache MIT Discussions Code Conduct
  Developer Edition Certificate Origin Elastic Container Registry Simple Storage Service Identity Access Management Secrets Manager Key CloudWatch
  Flexible Server Object Storage Oracle Cloud Infrastructure Subscription Resource Manager Bicep Pulumi Ansible Mac Ubuntu Debian Alpine Chrome Edge
  Acme Actions License Node.js Corepack TypeScript JavaScript Python Go Java Gradle Maven Cargo`.split(/\s+/),
);

/**
 * Turns MDX source into prose lines with their line numbers: front matter title/description,
 * text outside code, and the visible-text attributes of components (title, description, alt).
 * @param {string} source
 * @returns {{ line: number, text: string, heading: boolean }[]}
 */
export function mdxToProse(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  let i = 0;
  if (lines[0] === '---') {
    i = 1;
    for (; i < lines.length && lines[i] !== '---'; i++) {
      const m = lines[i].match(/^(title|description):\s*(.*)$/);
      if (m) out.push({ line: i + 1, text: unquote(m[2]), heading: m[1] === 'title' });
    }
    i++;
  }
  let fence = null;
  let inComment = false;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const fenceMatch = raw.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (fenceMatch && fenceMatch[1].startsWith(fence[0]) && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    let text = raw;
    if (inComment) {
      const end = text.indexOf('*/}');
      if (end === -1) continue;
      text = text.slice(end + 3);
      inComment = false;
    }
    text = text.replace(/\{\/\*.*?\*\/\}/g, ' ');
    const start = text.indexOf('{/*');
    if (start !== -1) {
      text = text.slice(0, start);
      inComment = true;
    }
    if (/^\s*(import|export)\s/.test(text)) continue;
    if (/^\s*\|?\s*:?-{3,}/.test(text)) continue; // table separator
    const heading = /^\s*#{1,6}\s/.test(text);
    const attrs = [];
    // Visible-text attributes of JSX components, checked as prose of their own.
    text = text.replace(/\b(title|description|alt|label)=("([^"]*)"|'([^']*)')/g, (_, _n, _q, a, b) => {
      attrs.push(a ?? b ?? '');
      return ' ';
    });
    text = stripInline(text)
      .replace(/<\/?[A-Za-z][^>]*>/g, ' ') // remaining tags with their non-visible attributes
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '') // list markers
      .replace(/\|/g, ' ');
    for (const a of attrs) if (stripInline(a).trim()) out.push({ line: i + 1, text: stripInline(a), heading: false });
    if (text.trim()) out.push({ line: i + 1, text, heading });
  }
  return out;
}

/** Removes inline code, links' targets, bare URLs, emphasis markers and JSX expressions. */
export function stripInline(text) {
  return text
    .replace(/(`+)[\s\S]*?\1/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<https?:[^>]+>/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/\b(?:mailto:)?[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ' ')
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(/\*\*|__|(?<![\w*])\*(?![\s*])|(?<=\S)\*(?![\w*])/g, '')
    .replace(/&[a-z]+;/g, ' ');
}

function unquote(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}
