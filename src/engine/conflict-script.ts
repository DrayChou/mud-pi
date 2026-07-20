import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CombatSimulationResult } from "./combat.ts";
import { simulateCombat } from "./combat.ts";
import type { ConflictRules, ItemDef, NpcDef, PlayerState, StatsSchema } from "../types/world.ts";
import { createSeededRandom } from "./procedural-map.ts";

export interface ConflictScriptContext {
  schema: Readonly<StatsSchema>;
  actor: Readonly<PlayerState>;
  target: Readonly<NpcDef>;
  rules: Readonly<ConflictRules>;
  seed: string;
  options: Readonly<Record<string, unknown>>;
}

export interface ItemUseScriptContext {
  schema: Readonly<StatsSchema>;
  actor: Readonly<PlayerState>;
  item: Readonly<ItemDef>;
  seed: string;
  options: Readonly<Record<string, unknown>>;
}

export interface ItemUseScriptResult {
  parameterDeltas: Array<{ parameterId: string; delta: number }>;
  consume: boolean;
  summary: string;
  rolls?: number[];
}

export interface ConflictResolver {
  id: string;
  version: number;
  resolve(context: ConflictScriptContext): CombatSimulationResult;
  useItem?(context: ItemUseScriptContext): ItemUseScriptResult;
}

export const defaultConflictResolver: ConflictResolver = {
  id: "mud-pi-default-conflict",
  version: 1,
  resolve(context) {
    const rules = context.rules.mode === "auto_combat"
      ? context.rules
      : { mode: "auto_combat" as const, algorithm: "gauge-random-v1" as const };
    return simulateCombat(
      context.schema as StatsSchema,
      context.actor as PlayerState,
      context.target as NpcDef,
      rules,
      context.seed
    );
  },
  useItem(context) {
    const random = createSeededRandom(context.seed);
    const parameterDeltas: ItemUseScriptResult["parameterDeltas"] = [];
    const rolls: number[] = [];
    for (const effect of context.item.effects ?? []) {
      if (!effect.parameterId) continue;
      let delta = effect.value ?? 0;
      if (effect.dice) {
        for (let index = 0; index < effect.dice.count; index++) {
          const roll = 1 + Math.floor(random() * effect.dice.sides);
          rolls.push(roll);
          delta += roll;
        }
      }
      if (effect.code === "parameter_delta" || effect.code === "recover_parameter") {
        parameterDeltas.push({ parameterId: effect.parameterId, delta });
      }
    }
    return {
      parameterDeltas,
      consume: context.item.consumable === true,
      summary: parameterDeltas.length > 0 ? `使用了${context.item.name}` : `${context.item.name}没有可执行效果`,
      rolls,
    };
  },
};

export async function loadWorldConflictResolver(
  worldPack: string,
  scriptPath: string | undefined
): Promise<ConflictResolver> {
  if (!scriptPath?.trim()) return defaultConflictResolver;
  if (!scriptPath.startsWith("./")) throw new Error("World conflict script must use a ./ relative path");

  const packDir = resolve(import.meta.dir, "../../worlds", worldPack);
  const fullPath = resolve(packDir, scriptPath);
  const relativePath = relative(packDir, fullPath);
  if (relativePath.startsWith("..") || relativePath.includes("/../") || relativePath.includes("\\..\\")) {
    throw new Error("World conflict script cannot escape its world-pack directory");
  }
  if (!(await Bun.file(fullPath).exists())) throw new Error(`World conflict script not found: ${scriptPath}`);

  const module = await import(pathToFileURL(fullPath).href) as {
    conflictResolver?: unknown;
    default?: unknown;
  };
  const candidate = module.conflictResolver ?? module.default;
  if (!isConflictResolver(candidate)) {
    throw new Error(`World conflict script must export conflictResolver: ${scriptPath}`);
  }
  return candidate;
}

export function validateCombatScriptResult(
  result: CombatSimulationResult,
  actorId: string,
  targetId: string
): CombatSimulationResult {
  if (result.player.id !== actorId || result.npc.id !== targetId) {
    throw new Error("Conflict script returned mismatched actor or target ids");
  }
  const combatantNumbers = [
    result.player.poolBefore,
    result.player.poolAfter,
    result.player.poolMax,
    result.player.attack,
    result.player.defense,
    result.player.speed,
    result.player.luck,
    result.npc.poolBefore,
    result.npc.poolAfter,
    result.npc.poolMax,
    result.npc.attack,
    result.npc.defense,
    result.npc.speed,
    result.npc.luck,
    result.estimatedPlayerWinChance,
    result.ticks,
  ];
  if (!combatantNumbers.every(Number.isFinite)) {
    throw new Error("Conflict script returned non-finite parameter values");
  }
  if (
    !["player", "npc"].includes(result.winner) ||
    !["safe", "dangerous", "likely_failure"].includes(result.risk) ||
    result.estimatedPlayerWinChance < 0 || result.estimatedPlayerWinChance > 1 ||
    !Number.isInteger(result.ticks) || result.ticks < 0 || result.ticks > 10_000
  ) throw new Error("Conflict script returned invalid summary values");
  if (result.player.poolAfter < 0 || result.npc.poolAfter < 0) {
    throw new Error("Conflict script returned negative final parameter values");
  }
  if (!Array.isArray(result.actions) || result.actions.length > 10_000) {
    throw new Error("Conflict script returned too many presentation frames");
  }
  for (const frame of result.actions) {
    if (
      ![actorId, targetId].includes(frame.actorId) ||
      ![actorId, targetId].includes(frame.targetId) ||
      frame.actorId === frame.targetId ||
      ![
        frame.tick,
        frame.hitChance,
        frame.hitRoll,
        frame.damageMultiplier,
        frame.damage,
        frame.targetPoolAfter,
      ].every(Number.isFinite) ||
      !Number.isInteger(frame.tick) || frame.tick < 0 ||
      frame.hitChance < 0 || frame.hitChance > 1 ||
      frame.hitRoll < 0 || frame.hitRoll > 1 ||
      frame.damage < 0 || frame.targetPoolAfter < 0
    ) throw new Error("Conflict script returned an invalid presentation frame");
  }
  return result;
}

function isConflictResolver(value: unknown): value is ConflictResolver {
  if (!value || typeof value !== "object") return false;
  const resolver = value as Partial<ConflictResolver>;
  return typeof resolver.id === "string" && Number.isInteger(resolver.version) && typeof resolver.resolve === "function";
}
