import type { ConflictRules, NpcDef, PlayerState, Stats, StatsSchema } from "../types/world.ts";
import { createSeededRandom } from "./procedural-map.ts";

export interface CombatSchemaKeys {
  poolKey: string;
  attackKey: string;
  defenseKey?: string;
  speedKey?: string;
  luckKey?: string;
  accuracyKey?: string;
  evasionKey?: string;
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
  luck: number;
}

export interface CombatActionFrame {
  tick: number;
  actorId: string;
  targetId: string;
  hit: boolean;
  critical: boolean;
  hitChance: number;
  hitRoll: number;
  damageMultiplier: number;
  damage: number;
  targetPoolAfter: number;
}

export interface CombatSimulationResult {
  algorithm: "gauge-random-v1";
  seed: string;
  poolKey: string;
  winner: "player" | "npc";
  risk: "safe" | "dangerous" | "likely_failure";
  estimatedPlayerWinChance: number;
  ticks: number;
  player: CombatantResult;
  npc: CombatantResult;
  actions: CombatActionFrame[];
}

type AutoCombatRules = Extract<ConflictRules, { mode: "auto_combat" }>;

const DEFAULT_RULES: Required<Omit<AutoCombatRules, "mode" | "algorithm">> = {
  baseHitChance: 0.8,
  minHitChance: 0.05,
  maxHitChance: 0.95,
  accuracyScale: 0.01,
  luckHitScale: 0.005,
  baseCritChance: 0.05,
  luckCritScale: 0.005,
  maxCritChance: 0.5,
  normalDamageMin: 0.75,
  normalDamageMax: 1.25,
  critMultiplier: 2,
  likelyFailureWarning: "你本能地意识到，贸然与{target}正面对抗，很可能无法全身而退。",
  dangerousWarning: "面对{target}，一种强烈的不安提醒你：即使取胜，也可能付出沉重代价。",
};

export function resolveCombatSchema(schema: StatsSchema): CombatSchemaKeys {
  const byRole = (role: NonNullable<StatsSchema["defs"][number]["role"]>) =>
    schema.defs.find((def) => def.role === role);
  const poolDef = schema.defs.find((def) => def.role === "pool" && def.onDeplete !== "narrative");
  return {
    poolKey: poolDef?.key ?? "hp",
    attackKey: byRole("attack")?.key ?? poolDef?.key ?? "hp",
    defenseKey: byRole("defense")?.key,
    speedKey: byRole("speed")?.key,
    luckKey: byRole("luck")?.key,
    accuracyKey: byRole("accuracy")?.key,
    evasionKey: byRole("evasion")?.key,
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

/** Resolve a complete seeded fight and return presentation frames plus final values. */
export function simulateCombat(
  schema: StatsSchema,
  player: PlayerState,
  npc: NpcDef,
  rules: AutoCombatRules = { mode: "auto_combat", algorithm: "gauge-random-v1" },
  seed = "combat"
): CombatSimulationResult {
  const resolvedRules = { ...DEFAULT_RULES, ...rules };
  const actual = simulateOnce(schema, player, npc, resolvedRules, seed);
  let wins = 0;
  const samples = 32;
  for (let index = 0; index < samples; index++) {
    if (simulateOnce(schema, player, npc, resolvedRules, `${seed}:risk:${index}`).winner === "player") wins++;
  }
  const estimatedPlayerWinChance = wins / samples;
  const remainingRatio = actual.player.poolBefore > 0
    ? actual.player.poolAfter / actual.player.poolBefore
    : 0;
  const risk = estimatedPlayerWinChance < 0.4
    ? "likely_failure"
    : estimatedPlayerWinChance < 0.7 || (actual.winner === "player" && remainingRatio <= 0.25)
      ? "dangerous"
      : "safe";
  return { ...actual, risk, estimatedPlayerWinChance };
}

function simulateOnce(
  schema: StatsSchema,
  player: PlayerState,
  npc: NpcDef,
  rules: typeof DEFAULT_RULES,
  seed: string
): Omit<CombatSimulationResult, "risk" | "estimatedPlayerWinChance"> {
  const keys = resolveCombatSchema(schema);
  const random = createSeededRandom(seed);
  const playerPoolBefore = Math.max(0, player.stats[keys.poolKey] ?? 0);
  const npcPoolBefore = Math.max(0, npc.stats[keys.poolKey] ?? 0);
  let playerPool = playerPoolBefore;
  let npcPool = npcPoolBefore;
  const playerSpeed = stat(player.stats, keys.speedKey, 10, 1);
  const npcSpeed = stat(npc.stats, keys.speedKey, 10, 1);
  const playerLuck = stat(player.stats, keys.luckKey, 0);
  const npcLuck = stat(npc.stats, keys.luckKey, 0);
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
      const attacker = actor === "player" ? player : npc;
      const defender = actor === "player" ? npc : player;
      const attackerLuck = actor === "player" ? playerLuck : npcLuck;
      const defenderLuck = actor === "player" ? npcLuck : playerLuck;
      const attackerAccuracy = stat(attacker.stats, keys.accuracyKey, 0);
      const defenderEvasion = stat(defender.stats, keys.evasionKey, 0);
      const hitChance = clamp(
        rules.baseHitChance +
        (attackerAccuracy - defenderEvasion) * rules.accuracyScale +
        (attackerLuck - defenderLuck) * rules.luckHitScale,
        rules.minHitChance,
        rules.maxHitChance
      );
      const hitRoll = random();
      const hit = hitRoll < hitChance;
      const critChance = clamp(
        rules.baseCritChance + attackerLuck * rules.luckCritScale,
        0,
        rules.maxCritChance
      );
      const critical = hit && random() < critChance;
      const normalRoll = random();
      const luckShift = (attackerLuck - defenderLuck) * 0.01;
      const normalMultiplier = clamp(
        rules.normalDamageMin + normalRoll * (rules.normalDamageMax - rules.normalDamageMin) + luckShift,
        rules.normalDamageMin,
        rules.normalDamageMax
      );
      const damageMultiplier = !hit ? 0 : critical ? rules.critMultiplier : normalMultiplier;
      const baseDamage = calculateDamage(attacker.stats, defender.stats, keys, actor === "player" ? 5 : 3);
      const damage = hit ? Math.max(1, Math.round(baseDamage * damageMultiplier)) : 0;

      if (actor === "player") {
        playerGauge -= 100;
        npcPool = Math.max(0, npcPool - damage);
      } else {
        npcGauge -= 100;
        playerPool = Math.max(0, playerPool - damage);
      }
      actions.push({
        tick,
        actorId: attacker.id,
        targetId: defender.id,
        hit,
        critical,
        hitChance,
        hitRoll,
        damageMultiplier,
        damage,
        targetPoolAfter: actor === "player" ? npcPool : playerPool,
      });
    }
  }

  if (tick >= 100_000) throw new Error("Combat simulation exceeded safety limit");
  return {
    algorithm: "gauge-random-v1",
    seed,
    poolKey: keys.poolKey,
    winner: npcPool <= 0 ? "player" : "npc",
    ticks: tick,
    player: combatant(player, playerPoolBefore, playerPool, keys, 5, playerSpeed, playerLuck),
    npc: combatant(npc, npcPoolBefore, npcPool, keys, 3, npcSpeed, npcLuck),
    actions,
  };
}

function combatant(
  entity: PlayerState | NpcDef,
  before: number,
  after: number,
  keys: CombatSchemaKeys,
  fallbackAttack: number,
  speed: number,
  luck: number
): CombatantResult {
  return {
    id: entity.id,
    name: entity.name,
    poolBefore: before,
    poolAfter: after,
    poolMax: entity.maxStats[`${keys.poolKey}Max`] ?? keys.defaultPoolMax,
    attack: entity.stats[keys.attackKey] ?? fallbackAttack,
    defense: keys.defenseKey ? entity.stats[keys.defenseKey] ?? 0 : 0,
    speed,
    luck,
  };
}

function stat(stats: Stats, key: string | undefined, fallback: number, min = Number.NEGATIVE_INFINITY): number {
  return Math.max(min, Math.floor(key ? stats[key] ?? fallback : fallback));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
