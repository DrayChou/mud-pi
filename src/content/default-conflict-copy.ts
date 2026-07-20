import type { CombatSimulationResult } from "../engine/combat.ts";
import type { ConflictRules } from "../types/world.ts";

export const DEFAULT_CONFLICT_COPY = {
  likelyFailureWarning: "你本能地意识到，贸然与{target}正面对抗，很可能无法全身而退。",
  dangerousWarning: "面对{target}，一种强烈的不安提醒你：即使取胜，也可能付出沉重代价。",
} as const;

export function formatConflictWarning(
  rules: ConflictRules | undefined,
  risk: "dangerous" | "likely_failure",
  combat: CombatSimulationResult
): string {
  const worldTemplate = rules?.mode === "auto_combat"
    ? risk === "likely_failure"
      ? rules.likelyFailureWarning
      : rules.dangerousWarning
    : undefined;
  const fallback = risk === "likely_failure"
    ? DEFAULT_CONFLICT_COPY.likelyFailureWarning
    : DEFAULT_CONFLICT_COPY.dangerousWarning;
  return (worldTemplate?.trim() || fallback)
    .replaceAll("{target}", combat.npc.name)
    .replaceAll("{chance}", String(Math.round(combat.estimatedPlayerWinChance * 100)));
}
