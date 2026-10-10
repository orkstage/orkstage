import { ProviderError, requestJson } from '@orkstage/cloud-core';

/** How OpenTofu and the control plane reach the Kubernetes API of a CKS cluster. */
export interface ClusterAccess {
  /** API server URL, e.g. https://<id>.k8s.us-east-04a.coreweave.com. */
  host: string;
  /** Bearer token. With CKS managed auth this is a CoreWeave API access token. */
  token: string;
  /** PEM cluster CA. Empty for the managed endpoint, which uses a publicly trusted certificate. */
  ca: string;
}

/** The parts of a kubeconfig OrkStage uses: the current context's server, CA and bearer token. */
export interface KubeconfigParts {
  server: string;
  token?: string;
  ca?: string;
}

type Entry = Record<string, string>;

/**
 * Reads a kubeconfig in JSON or in the YAML layout kubectl and the CoreWeave Console write, raw
 * or base64. Only bearer token users are supported; there is no YAML library on purpose, so
 * each list item is flattened to its scalar `key: value` pairs.
 */
export function parseKubeconfig(input: string): KubeconfigParts {
  const text = decodeMaybeBase64(input.trim());
  let clusters: Entry[];
  let contexts: Entry[];
  let users: Entry[];
  let current: string | undefined;
  if (text.startsWith('{')) {
    const doc = JSON.parse(text) as {
      clusters?: { name: string; cluster?: Entry }[];
      contexts?: { name: string; context?: Entry }[];
      users?: { name: string; user?: Entry }[];
      'current-context'?: string;
    };
    clusters = (doc.clusters ?? []).map((c) => ({ ...c.cluster, name: c.name }));
    contexts = (doc.contexts ?? []).map((c) => ({ ...c.context, name: c.name }));
    users = (doc.users ?? []).map((u) => ({ ...u.user, name: u.name }));
    current = doc['current-context'];
  } else {
    const sections = yamlSections(text);
    clusters = sections.clusters ?? [];
    contexts = sections.contexts ?? [];
    users = sections.users ?? [];
    current = /^current-context:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, '');
  }
  const context = contexts.find((c) => c.name === current) ?? contexts[0];
  const cluster = clusters.find((c) => c.name === context?.cluster) ?? clusters[0];
  const user = users.find((u) => u.name === context?.user) ?? users[0];
  if (!cluster?.server) {
    throw new ProviderError('COREWEAVE_KUBECONFIG_INVALID', 'The kubeconfig in the credential secret has no cluster server.', 'AUTHENTICATION_ERROR', 'coreweave');
  }
  const caData = cluster['certificate-authority-data'];
  return {
    server: cluster.server.replace(/\/$/, ''),
    token: user?.token || undefined,
    ca: caData ? Buffer.from(caData, 'base64').toString('utf8') : undefined,
  };
}

function decodeMaybeBase64(text: string): string {
  if (/^[A-Za-z0-9+/=\s]+$/.test(text) && !text.includes(':')) {
    return Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8').trim();
  }
  return text;
}

/** Top level list sections (`clusters`, `contexts`, `users`) as flattened items. */
function yamlSections(text: string): Record<string, Entry[]> {
  const out: Record<string, Entry[]> = {};
  let section: string | undefined;
  let item: Entry | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (top) {
      section = top[1];
      item = undefined;
      continue;
    }
    if (!section) continue;
    const startsItem = /^\s*-\s+/.test(line) && !line.trimStart().startsWith('- -');
    if (startsItem && line.indexOf('-') <= 2) {
      item = {};
      (out[section] ??= []).push(item);
    }
    const pair = /^[\s-]*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (item && pair && pair[2] !== '') item[pair[1]!] = pair[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** JSON call to the Kubernetes API with the cluster's bearer token. */
export function kubeRequest<T>(
  f: typeof fetch,
  access: ClusterAccess,
  path: string,
  init: { method?: string; body?: unknown; contentType?: string; allow404?: boolean; signal?: AbortSignal } = {},
): Promise<T | null> {
  return requestJson<T>(`${access.host}${path}`, {
    fetch: f,
    signal: init.signal,
    method: init.method ?? 'GET',
    allow404: init.allow404,
    headers: {
      authorization: `Bearer ${access.token}`,
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': init.contentType ?? 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

/** Plain text call (pod logs). */
export async function kubeText(f: typeof fetch, access: ClusterAccess, path: string, signal?: AbortSignal): Promise<string> {
  const res = await f(`${access.host}${path}`, {
    headers: { authorization: `Bearer ${access.token}` },
    signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
  });
  if (!res.ok) return '';
  return res.text();
}
