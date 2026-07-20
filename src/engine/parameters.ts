import type { DataTrait, ItemDef, ParameterModifier, PlayerState, Stats, WorldState } from "../types/world.ts";

/** RPG Maker-style effective parameters: base values plus equipment modifiers and rates. */
export function effectivePlayerStats(state: WorldState): Stats {
  return applyParameterModifiers(state.player.stats, playerParameterModifiers(state));
}

export function baseDeltaForEffectivePlayerChange(
  state: WorldState,
  parameterId: string,
  effectiveDelta: number
): number {
  const modifiers = playerParameterModifiers(state).filter((modifier) => modifier.parameterId === parameterId);
  const add = modifiers.filter((modifier) => modifier.operation === "add").reduce((sum, modifier) => sum + modifier.value, 0);
  const rate = modifiers.filter((modifier) => modifier.operation === "rate").reduce((product, modifier) => product * modifier.value, 1);
  const baseBefore = state.player.stats[parameterId] ?? 0;
  const effectiveBefore = Math.round((baseBefore + add) * rate);
  const effectiveAfter = effectiveBefore + effectiveDelta;
  const baseAfter = Math.round(effectiveAfter / rate - add);
  return baseAfter - baseBefore;
}

export function effectivePlayerTraits(state: WorldState): DataTrait[] {
  return [
    ...(state.player.traits ?? []),
    ...equippedItems(state.player, state.items).flatMap((item) => item.traits ?? []),
  ].map((trait) => ({ ...trait }));
}

export function applyParameterModifiers(base: Stats, modifiers: ParameterModifier[]): Stats {
  const result = { ...base };
  const rates = new Map<string, number>();
  for (const modifier of modifiers) {
    if (modifier.operation === "rate") {
      rates.set(modifier.parameterId, (rates.get(modifier.parameterId) ?? 1) * modifier.value);
    } else {
      result[modifier.parameterId] = (result[modifier.parameterId] ?? 0) + modifier.value;
    }
  }
  for (const [parameterId, rate] of rates) {
    result[parameterId] = Math.round((result[parameterId] ?? 0) * rate);
  }
  return result;
}

function playerParameterModifiers(state: WorldState): ParameterModifier[] {
  return equippedItems(state.player, state.items).flatMap((item) => item.parameterModifiers ?? []);
}

export function equippedItems(player: PlayerState, items: Record<string, ItemDef>): ItemDef[] {
  return Object.values(player.equipment)
    .map((itemId) => items[itemId])
    .filter((item): item is ItemDef => item !== undefined && item.location.kind === "equipped");
}
