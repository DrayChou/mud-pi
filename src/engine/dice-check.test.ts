import { describe, expect, test } from "bun:test";
import { simulateDiceCheck } from "./dice-check.ts";

const rules = {
  mode: "dice_check" as const,
  dice: { count: 2, sides: 6 },
  criticalSuccess: "all_max" as const,
  criticalFailure: "all_min" as const,
};

describe("simulateDiceCheck", () => {
  test("replays seeded 2d6 checks and applies modifiers against difficulty", () => {
    const first = simulateDiceCheck(rules, 4, 10, "check-seed");
    const second = simulateDiceCheck(rules, 4, 10, "check-seed");
    expect(first).toEqual(second);
    expect(first.rolls).toHaveLength(2);
    expect(first.finalTotal).toBe(first.total + 4);
    expect(first.success).toBe(first.critical === "success" || (first.critical !== "failure" && first.finalTotal >= 10));
  });

  test("supports world-defined dice pools", () => {
    const result = simulateDiceCheck(
      { mode: "dice_check", dice: { count: 3, sides: 8 } },
      0,
      12,
      "three-d-eight"
    );
    expect(result.rolls).toHaveLength(3);
    expect(result.rolls.every((roll) => roll >= 1 && roll <= 8)).toBe(true);
  });
});
