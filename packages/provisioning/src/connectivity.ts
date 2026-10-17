// SPDX-License-Identifier: AGPL-3.0-only
import type { ConnectivityRequirement } from '@orkstage/templates';
import type { LinkWiring, ResolvedConnectivity, ResolvedResource } from './types.js';

/** Resource types that publish credentials (a `secret_ref` output). */
const PUBLISHES_CREDENTIALS = new Set(['database.postgresql']);
/** Providers whose container services keep credentials of another provider in their own secret store. */
const COPIES_CREDENTIALS = new Set(['aws', 'azure', 'gcp']);
/** Providers whose PostgreSQL has a public endpoint that can allowlist addresses. */
const DATABASE_ALLOWLIST = new Set(['azure', 'gcp']);

/**
 * Chooses how two resources reach each other (spec §42.4). Cross-cloud private links (VPN /
 * interconnect) are never created silently: `private-preferred` falls back to TLS over a public
 * endpoint with strict allowlisting, and the choice is surfaced to the operator.
 */
export function resolveConnectivity(
  req: ConnectivityRequirement,
  from: ResolvedResource,
  to: ResolvedResource,
): ResolvedConnectivity {
  const link = classify(req, from, to);
  return { ...link, wiring: credentialWiring(link, from, to) };
}

function credentialWiring(link: Omit<ResolvedConnectivity, 'wiring'>, from: ResolvedResource, to: ResolvedResource): LinkWiring {
  if (!PUBLISHES_CREDENTIALS.has(to.type)) return { credentials: 'none' };
  if (!link.crossCloud) return { credentials: 'native' };
  if (COPIES_CREDENTIALS.has(effectiveProvider(from)) && from.type === 'compute.container-service') {
    link.notes.push(`The credentials of ${to.id} are copied into ${effectiveProvider(from)}'s secret store for ${from.id} at deploy time; the values never appear in stored configuration.`);
    return { credentials: 'copied' };
  }
  link.notes.push(`${from.id} receives only a reference to the credentials of ${to.id} (${effectiveProvider(from)} has no secret wiring for it): read them with the reference at start.`);
  return { credentials: 'reference' };
}

/**
 * Gives a `public-tls-allowlist` link its allowlist: the database waits for the consumer's network
 * and allows only that network's egress addresses (spec §42.4). Mutates the target resource (a
 * dependency and `spec.allowlistNetworks`); the caller recomputes its hash.
 */
export function wireAllowlist(link: ResolvedConnectivity, resources: ResolvedResource[]): ResolvedResource | null {
  if (link.strategy !== 'public-tls-allowlist') return null;
  const from = resources.find((r) => r.id === link.from)!;
  const to = resources.find((r) => r.id === link.to)!;
  if (!PUBLISHES_CREDENTIALS.has(to.type)) return null;
  if (!DATABASE_ALLOWLIST.has(effectiveProvider(to))) {
    link.wiring.allowlistGap = `${effectiveProvider(to)} PostgreSQL has no public endpoint to allowlist: ${from.id} cannot reach ${to.id} without a VPN or interconnect.`;
    link.notes.push(link.wiring.allowlistGap);
    return null;
  }
  const network = resources.find((r) => r.type === 'network' && r.targetId === from.targetId && r.region === from.region);
  if (!network) {
    link.wiring.allowlistGap = `${from.id} has no network in its placement, so there is no egress address to allowlist; ${to.id} accepts TLS from any address.`;
    link.notes.push(link.wiring.allowlistGap);
    return null;
  }
  link.wiring.allowlistNetwork = network.id;
  link.notes.push(`The ${to.id} firewall allows only the egress addresses of ${network.id} (${effectiveProvider(from)}).`);
  if (!network.spec.natGateway) {
    link.notes.push(`${network.id} has no NAT gateway, so its egress has no fixed address and the allowlist stays empty: set natGateway on ${network.id}.`);
  }
  if (!to.dependsOn.includes(network.id)) to.dependsOn = [...to.dependsOn, network.id].sort();
  const current = Array.isArray(to.spec.allowlistNetworks) ? (to.spec.allowlistNetworks as string[]) : [];
  if (!current.includes(network.id)) to.spec = { ...to.spec, allowlistNetworks: [...current, network.id].sort() };
  return to;
}

function classify(req: ConnectivityRequirement, from: ResolvedResource, to: ResolvedResource): Omit<ResolvedConnectivity, 'wiring'> {
  const sameTargetRegion = from.targetId === to.targetId && from.region === to.region;
  const sameProvider = effectiveProvider(from) === effectiveProvider(to);
  const crossCloud = !sameProvider;
  const notes: string[] = [];

  if (sameTargetRegion) {
    return { ...req, strategy: 'private-network', crossCloud, notes: ['Same account and region: private network path.'] };
  }

  if (sameProvider) {
    if (req.mode === 'secure') {
      return { ...req, strategy: 'public-tls', crossCloud, notes: ['TLS over the provider network.'] };
    }
    notes.push('Different account or region on the same provider: requires peering (cost and setup apply).');
    return { ...req, strategy: 'private-peering', crossCloud, notes };
  }

  notes.push(`Cross-cloud traffic ${effectiveProvider(from)} → ${effectiveProvider(to)} adds latency and may incur egress charges.`);
  switch (req.mode) {
    case 'private-required':
      notes.push('Private cross-cloud connectivity requires a VPN or interconnect, which the platform does not provision automatically.');
      return { ...req, strategy: 'unsatisfiable', crossCloud, notes };
    case 'private-preferred':
      notes.push('Private interconnect not justified by default; using TLS with source allowlisting instead.');
      return { ...req, strategy: 'public-tls-allowlist', crossCloud, notes };
    default:
      return { ...req, strategy: 'public-tls', crossCloud, notes };
  }
}

export function effectiveProvider(r: Pick<ResolvedResource, 'provider' | 'simulatedProvider'>): string {
  return r.simulatedProvider ?? r.provider;
}
