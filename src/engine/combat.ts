import type { NpcDef, PlayerState, Stats, StatsSchema } from "../types/world.ts";

export interface CombatSchemaKeys {
  poolKey: string;
  attackKey: string;
  defenseKey?: string;
  speedKey?: string;
  defaultPoolMax: number;
}

export interface CombatantResult {
  id: string;
  name: string;
  poolBefore: number;
  poolAfter: number;
  poolMax: number;
  attack: number;
  defense: number;
  speed: number;
}

export interface CombatActionFrame {
  tick: number;
  actorId: string;
  targetId: string;
  damage: number;
  targetPoolAfter: number;
}

export interface CombatSimulationResult {
  poolKey: string;
  winner: "player" | "npc";
  risk: "safe" | "dangerous" | "likely_failure";
  ticks: number;
  player: CombatantResult;
  npc: CombatantResult;
  actions: CombatActionFrame[];
}

export function resolveCombatSchema(schema: StatsSchema): CombatSchemaKeys {
  const poolDef = schema.defs.find((def) => def.role === "pool" && def.onDeplete !== "narrative");
  const attackDef = schema.defs.find((def) => def.role === "attack");
  const defenseDef = schema.defs.find((def) => def.role === "defense");
  const speedDef = schema.defs.find((def) => def.role === "speed");
  return {
    poolKey: poolDef?.key ?? "hp",
    attackKey: attackDef?.key ?? poolDef?.key ?? "hp",
    defenseKey: defenseDef?.key,
    speedKey: speedDef?.key,
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

/**
 * Resolve the entire fight without randomness. Each tick fills both gauges by speed;
 * a combatant attacks whenever its gauge reaches 100. The returned frames are only
 * presentation data: authoritative state changes are applied once from the final result.
 */
export function simulateCombat(
  schema: StatsSchema,
  player: PlayerState,
  npc: NpcDef
): CombatSimulationResult {
  const keys = resolveCombatSchema(schema);
  const playerPoolBefore = Math.max(0, player.stats[keys.poolKey] ?? 0);
  const npcPoolBefore = Math.max(0, npc.stats[keys.poolKey] ?? 0);
  let playerPool = playerPoolBefore;
  let npcPool = npcPoolBefore;
  const playerSpeed = combatSpeed(player.stats, keys);
  const npcSpeed = combatSpeed(npc.stats, keys);
  const playerDamage = calculateDamage(player.stats, npc.stats, keys, 5);
  const npcDamage = calculateDamage(npc.stats, player.stats, keys, 3);
  let playerGauge = 0;
  let npcGauge = 0;
  let tick = 0;
  const actions: CombatActionFrame[] = [];

  while (playerPool > 0 && npcPool > 0 && tick < 100_000) {
    tick++;
    playerGauge += playerSpeed;
    npcGauge += npcSpeed;
    const ready: Array<"player" | "npc"> = [];
    if (playerGauge >= 100) ready.push("player");
    if (npcGauge >= 100) ready.push("npc");
    ready.sort((a, b) => {
      const gaugeA = a === "player" ? playerGauge : npcGauge;
      const gaugeB = b === "player" ? playerGauge : npcGauge;
      const speedA = a === "player" ? playerSpeed : npcSpeed;
      const speedB = b === "player" ? playerSpeed : npcSpeed;
      return gaugeB - gaugeA || speedB - speedA || (a === "player" ? -1 : 1);
    });

    for (const actor of ready) {
      if (playerPool <= 0 || npcPool <= 0) break;
      if (actor === "player") {
        playerGauge -= 100;
        npcPool = Math.max(0, npcPool - playerDamage);
        actions.push({ tick, actorId: player.id, targetId: npc.id, damage: playerDamage, targetPoolAfter: npcPool });
      } else {
        npcGauge -= 100;
        playerPool = Math.max(0, playerPool - npcDamage);
        actions.push({ tick, actorId: npc.id, targetId: player.id, damage: npcDamage, targetPoolAfter: playerPool });
      }
    }
  }

  if (tick >= 100_000) throw new Error("Combat simulation exceeded safety limit");
  const winner = npcPool <= 0 ? "player" : "npc";
  const remainingRatio = playerPoolBefore > 0 ? playerPool / playerPoolBefore : 0;
  const risk = winner === "npc" ? "likely_failure" : remainingRatio <= 0.25 ? "dangerous" : "safe";

  return {
    poolKey: keys.poolKey,
    winner,
    risk,
    ticks: tick,
    player: {
      id: player.id,
      name: player.name,
      poolBefore: playerPoolBefore,
      poolAfter: playerPool,
      poolMax: player.maxStats[`${keys.poolKey}Max`] ?? keys.defaultPoolMax,
      attack: player.stats[keys.attackKey] ?? 5,
      defense: keys.defenseKey ? player.stats[keys.defenseKey] ?? 0 : 0,
      speed: playerSpeed,
    },
    npc: {
      id: npc.id,
      name: npc.name,
      poolBefore: npcPoolBefore,
      poolAfter: npcPool,
      poolMax: npc.maxStats[`${keys.poolKey}Max`] ?? keys.defaultPoolMax,
      attack: npc.stats[keys.attackKey] ?? 3,
      defense: keys.defenseKey ? npc.stats[keys.defenseKey] ?? 0 : 0,
      speed: npcSpeed,
    },
    actions,
  };
}

function combatSpeed(stats: Stats, keys: CombatSchemaKeys): number {
  const explicit = keys.speedKey ? stats[keys.speedKey] : undefined;
  return Math.max(1, Math.floor(explicit ?? 10));
}
