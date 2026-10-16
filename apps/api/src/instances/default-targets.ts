// SPDX-License-Identifier: AGPL-3.0-only
/** A cloud target as the default lookup sees it. */
export interface DefaultCandidate {
  id: string;
  provider: string;
  tenantId: string | null;
  environment: string;
  defaultRegion: string;
  isDefault: boolean;
  status: string;
}

/** A placement slot of the template: its name and the providers it accepts (empty: any). */
export interface SlotNeed {
  name: string;
  providers: readonly string[];
}

/**
 * The default cloud target for every slot the request left unbound. A candidate must be a default,
 * active, visible to the tenant (its own or shared), serve the instance's environment (or `any`)
 * and be a provider the slot accepts. Ties go to the tenant's own target, then the exact
 * environment over `any`, then the slot's provider order. Slots with no candidate stay unbound,
 * and the compiler reports them as before.
 */
export function pickDefaultBindings(
  slots: readonly SlotNeed[],
  bound: Readonly<Record<string, unknown>>,
  environment: string,
  tenantId: string,
  candidates: readonly DefaultCandidate[],
): Record<string, { targetId: string; region: string }> {
  const out: Record<string, { targetId: string; region: string }> = {};
  for (const slot of slots) {
    if (bound[slot.name]) continue;
    const fits = candidates.filter(
      (t) =>
        t.isDefault &&
        t.status === 'ACTIVE' &&
        (t.tenantId === null || t.tenantId === tenantId) &&
        (t.environment === environment || t.environment === 'any') &&
        (slot.providers.length === 0 || slot.providers.includes(t.provider)),
    );
    const rank = (t: DefaultCandidate) => [
      t.tenantId === tenantId ? 0 : 1,
      t.environment === environment ? 0 : 1,
      slot.providers.length ? slot.providers.indexOf(t.provider) : 0,
    ];
    fits.sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
    });
    if (fits[0]) out[slot.name] = { targetId: fits[0].id, region: fits[0].defaultRegion };
  }
  return out;
}
