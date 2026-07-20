import { describe, expect, test } from "bun:test";
import type { CombatSimulationResult } from "../engine/combat.ts";
import { formatConflictWarning } from "./default-conflict-copy.ts";

const combat = {
  npc: { name: "车厢阴影" },
  estimatedPlayerWinChance: 0.25,
} as CombatSimulationResult;

describe("conflict warning copy", () => {
  test("uses local immersive copy when a world pack has no override", () => {
    expect(formatConflictWarning(undefined, "likely_failure", combat)).toBe(
      "你本能地意识到，贸然与车厢阴影正面对抗，很可能无法全身而退。"
    );
  });

  test("prefers world-pack copy and expands supported placeholders", () => {
    const text = formatConflictWarning({
      mode: "auto_combat",
      algorithm: "gauge-random-v1",
      likelyFailureWarning: "钟声为{target}响了三次；你只有{chance}%的把握。",
    }, "likely_failure", combat);
    expect(text).toBe("钟声为车厢阴影响了三次；你只有25%的把握。");
  });
});
