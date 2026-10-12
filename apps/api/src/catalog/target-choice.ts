// SPDX-License-Identifier: AGPL-3.0-only
/** A placement slot as validation sees it: which providers may host it. */
export interface SlotProviders {
  name: string;
  providers: readonly string[];
}

/**
 * Picks one shared cloud target per placement slot for template validation. Candidates keep the
 * order given (callers put real providers before simulation, oldest first). The first candidate of
 * every slot is the starting point; then, slot by slot, another candidate replaces it when it
 * leaves fewer errors with the other slots unchanged. A template is only reported invalid when no
 * compatible target can host it, not because the first target found happens not to.
 *
 * Returns null when a slot has no compatible target at all.
 */
export function chooseBindings<T extends { provider: string }>(
  slots: readonly SlotProviders[],
  targets: readonly T[],
  errorsWith: (choice: Readonly<Record<string, T>>) => number,
): Record<string, T> | null {
  const candidates = new Map(slots.map((s) => [s.name, targets.filter((t) => s.providers.length === 0 || s.providers.includes(t.provider))]));
  if (slots.some((s) => candidates.get(s.name)!.length === 0)) return null;
  const choice: Record<string, T> = Object.fromEntries(slots.map((s) => [s.name, candidates.get(s.name)![0]!]));
  let best = errorsWith(choice);
  for (const slot of slots) {
    if (best === 0) break;
    for (const candidate of candidates.get(slot.name)!.slice(1)) {
      const errors = errorsWith({ ...choice, [slot.name]: candidate });
      if (errors < best) {
        best = errors;
        choice[slot.name] = candidate;
        if (best === 0) break;
      }
    }
  }
  return choice;
}
