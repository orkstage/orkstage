// SPDX-License-Identifier: AGPL-3.0-only
/** A cloud target as profile resolution sees it. */
export interface ProfileTargetView {
  id: string;
  tenantId: string | null;
  environment: string;
  defaultRegion: string;
  status: string;
}

/** A profile with its targets, one per provider (ADR 0007). */
export interface ProfileView {
  id: string;
  tenantId: string | null;
  environment: string;
  isDefault: boolean;
  targets: readonly { provider: string; region: string | null; target: ProfileTargetView }[];
}

/** A placement slot of the template: its name and the providers it accepts (empty: any). */
export interface SlotNeed {
  name: string;
  providers: readonly string[];
}

/** A profile a tenant may use: its own or a shared one. */
export const visibleTo = (tenantId: string) => (p: { tenantId: string | null }) => p.tenantId === null || p.tenantId === tenantId;

/** A profile or target serves an environment when it names it or says `any`. */
export const serves = (environment: string) => (x: { environment: string }) => x.environment === environment || x.environment === 'any';

/**
 * The default profile for a new instance: a default that the tenant may use and that serves the
 * instance's environment. The tenant's own comes before a shared one, then the exact environment
 * before `any`.
 */
export function defaultProfile<P extends ProfileView>(profiles: readonly P[], tenantId: string, environment: string): P | undefined {
  const rank = (p: P) => (p.tenantId === tenantId ? 0 : 2) + (p.environment === environment ? 0 : 1);
  return profiles
    .filter((p) => p.isDefault && visibleTo(tenantId)(p) && serves(environment)(p))
    .sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Bindings for every slot the request left unbound, from the profile: the profile's target for
 * the first provider in the slot's list that the profile has (any of them, in profile order, when
 * the slot accepts any provider), with the profile's region or else the target's default. The
 * target must be active, usable by the tenant and serve the environment. Slots with no match stay
 * unbound, and the compiler reports them.
 */
export function bindFromProfile(
  slots: readonly SlotNeed[],
  bound: Readonly<Record<string, unknown>>,
  profile: ProfileView,
  tenantId: string,
  environment: string,
): Record<string, { targetId: string; region: string }> {
  const usable = profile.targets.filter(
    (e) => e.target.status === 'ACTIVE' && visibleTo(tenantId)(e.target) && serves(environment)(e.target),
  );
  const out: Record<string, { targetId: string; region: string }> = {};
  for (const slot of slots) {
    if (bound[slot.name]) continue;
    const entry = slot.providers.length
      ? slot.providers.map((provider) => usable.find((e) => e.provider === provider)).find(Boolean)
      : usable[0];
    if (entry) out[slot.name] = { targetId: entry.target.id, region: entry.region ?? entry.target.defaultRegion };
  }
  return out;
}
