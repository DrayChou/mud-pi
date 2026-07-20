import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CombatSimulationResult } from "./combat.ts";
import { simulateCombat } from "./combat.ts";
import type { ConflictRules, NpcDef, PlayerState, StatsSchema } from "../types/world.ts";

export interface ConflictScriptContext {
  schema: Readonly<StatsSchema>;
  actor: Readonly<PlayerState>;
  target: Readonly<NpcDef>;
  rules: Readonly<ConflictRules>;
  seed: string;
  options: Readonly<Record<string, unknown>>;
}

export interface ConflictResolver {
  id: string;
  version: number;
  resolve(context: ConflictScriptContext): CombatSimulationResult;
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
  if (![result.player.poolBefore, result.player.poolAfter, result.npc.poolBefore, result.npc.poolAfter].every(Number.isFinite)) {
    throw new Error("Conflict script returned non-finite parameter values");
  }
  if (result.player.poolAfter < 0 || result.npc.poolAfter < 0) {
    throw new Error("Conflict script returned negative final parameter values");
  }
  if (!Array.isArray(result.actions) || result.actions.length > 10_000) {
    throw new Error("Conflict script returned too many presentation frames");
  }
  return result;
}

function isConflictResolver(value: unknown): value is ConflictResolver {
  if (!value || typeof value !== "object") return false;
  const resolver = value as Partial<ConflictResolver>;
  return typeof resolver.id === "string" && Number.isInteger(resolver.version) && typeof resolver.resolve === "function";
}
