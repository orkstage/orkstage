import type { CloudCapability } from './types.js';

export interface CapabilityRequirement {
  serviceKind: string;
  /** Explicit implementation requested by the template, if any. */
  implementation?: string;
  /** Features that must be supported, e.g. `ha:zone-redundant`. */
  features: string[];
  region: string;
}

export type CapabilityResolution =
  | { ok: true; capability: CloudCapability }
  | { ok: false; reason: string; suggestions: string[] };

function availableIn(cap: CloudCapability, region: string): boolean {
  return cap.regions === '*' || cap.regions.includes(region);
}

function missingFeatures(cap: CloudCapability, features: string[], region: string): string[] {
  const gaps = cap.regionalGaps?.[region] ?? [];
  return features.filter((f) => !cap.features.includes(f) || gaps.includes(f));
}

/**
 * Picks a provider implementation for a logical resource (spec §8): logical resource →
 * required capability → provider catalog → implementation. When nothing fits, returns the
 * reason plus concrete alternatives instead of guessing (spec §42.6).
 */
export function resolveCapability(
  catalog: readonly CloudCapability[],
  req: CapabilityRequirement,
): CapabilityResolution {
  const ofKind = catalog.filter((c) => c.serviceKind === req.serviceKind);
  if (ofKind.length === 0) {
    return { ok: false, reason: `This provider does not offer ${req.serviceKind}.`, suggestions: ['Place this resource on another provider.'] };
  }

  const candidates = req.implementation ? ofKind.filter((c) => c.capability === req.implementation) : ofKind;
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `Implementation "${req.implementation}" is not available for ${req.serviceKind}.`,
      suggestions: ofKind.map((c) => `Use ${c.capability} (${c.displayName})`),
    };
  }

  const ordered = [...candidates].sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false));
  for (const cap of ordered) {
    if (availableIn(cap, req.region) && missingFeatures(cap, req.features, req.region).length === 0) {
      return { ok: true, capability: cap };
    }
  }

  const first = ordered[0]!;
  const suggestions: string[] = [];
  if (!availableIn(first, req.region)) {
    const regions = first.regions === '*' ? [] : first.regions.slice(0, 3);
    return {
      ok: false,
      reason: `${first.displayName} is not available in ${req.region}.`,
      suggestions: [...regions.map((r) => `Use region ${r}`), 'Place this resource on another provider.'],
    };
  }

  const missing = missingFeatures(first, req.features, req.region);
  for (const f of missing) {
    if (f === 'ha:zone-redundant') suggestions.push('Use same-zone high availability', 'Use another region');
    else suggestions.push(`Drop the "${f}" requirement`);
  }
  for (const alt of ofKind) {
    if (alt !== first && availableIn(alt, req.region) && missingFeatures(alt, req.features, req.region).length === 0) {
      suggestions.push(`Use ${alt.capability} (${alt.displayName})`);
    }
  }
  suggestions.push('Place this resource on another provider.');
  return {
    ok: false,
    reason: `${first.displayName} in ${req.region} does not support: ${missing.join(', ')}.`,
    suggestions: [...new Set(suggestions)],
  };
}
