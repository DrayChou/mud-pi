import type { Stats, StatsSchema } from "../types/world.ts";

export interface CombatSchemaKeys {
  poolKey: string;
  attackKey: string;
  defenseKey?: string;
  defaultPoolMax: number;
}

export function resolveCombatSchema(schema: StatsSchema): CombatSchemaKeys {
  const poolDef = schema.defs.find((def) => def.role === "pool" && def.onDeplete !== "narrative");
  const attackDef = schema.defs.find((def) => def.role === "attack");
  const defenseDef = schema.defs.find((def) => def.role === "defense");
  return {
    poolKey: poolDef?.key ?? "hp",
    attackKey: attackDef?.key ?? poolDef?.key ?? "hp",
    defenseKey: defenseDef?.key,
    defaultPoolMax: poolDef?.max ?? 100,
  };
}

export function calculateDamage(
  attacker: Stats,
  defender: Stats,
  keys: CombatSchemaKeys,
  fallbackAttack: number
): number {
  const attack = attacker[keys.attackKey] ?? fallbackAttack;
  const defense = keys.defenseKey ? defender[keys.defenseKey] ?? 0 : 0;
  return Math.max(1, attack - defense);
}
