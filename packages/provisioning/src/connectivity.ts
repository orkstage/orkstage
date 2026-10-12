// SPDX-License-Identifier: AGPL-3.0-only
import type { ConnectivityRequirement } from '@orkstage/templates';
import type { ResolvedConnectivity, ResolvedResource } from './types.js';

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
