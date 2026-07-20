import type { ConflictRules } from "../types/world.ts";
import { createSeededRandom } from "./procedural-map.ts";

type DiceRules = Extract<ConflictRules, { mode: "dice_check" }>;

export interface DiceCheckResult {
  seed: string;
  rolls: number[];
  total: number;
  modifier: number;
  finalTotal: number;
  difficulty: number;
  success: boolean;
  critical: "success" | "failure" | null;
}

/** Disco-like generic check: dice total + stat/modifier against a difficulty. */
export function simulateDiceCheck(
  rules: DiceRules,
  modifier: number,
  difficulty: number,
  seed: string
): DiceCheckResult {
  const dice = rules.dice ?? { count: 2, sides: 6 };
  const random = createSeededRandom(seed);
  const rolls = Array.from({ length: dice.count }, () => 1 + Math.floor(random() * dice.sides));
  const allMin = rolls.every((roll) => roll === 1);
  const allMax = rolls.every((roll) => roll === dice.sides);
  const critical = rules.criticalFailure === "all_min" && allMin
    ? "failure"
    : rules.criticalSuccess === "all_max" && allMax
      ? "success"
      : null;
  const total = rolls.reduce((sum, roll) => sum + roll, 0);
  const finalTotal = total + modifier;
  const success = critical === "success" || (critical !== "failure" && finalTotal >= difficulty);
  return { seed, rolls, total, modifier, finalTotal, difficulty, success, critical };
}
