import { describe, expect, test } from "bun:test";
import { simulateCombat } from "./combat.ts";
import type { NpcDef, PlayerState, StatsSchema } from "../types/world.ts";

const schema: StatsSchema = { defs: [
  { key: "hp", label: "HP", min: 0, max: 100, default: 100, display: "bar" },
  { key: "attack", label: "Attack", min: 0, max: 100, default: 10, display: "number" },
  { key: "defense", label: "Defense", min: 0, max: 100, default: 0, display: "number" },
  { key: "speed", label: "Speed", min: 1, max: 100, default: 10, display: "number" },
] };

function player(stats: Record<string, number>): PlayerState {
  return { id: "player1", name: "玩家", roomId: "arena", lifecycle: "active", stats, maxStats: { hpMax: stats.hp ?? 100 }, inventory: [], equipment: {} };
}
function npc(stats: Record<string, number>): NpcDef {
  return { id: "enemy", name: "敌人", roomId: "arena", alive: true, personality: "", source: "static", hostile: true, stats, maxStats: { hpMax: stats.hp ?? 100 } };
}

const fixedRules = {
  mode: "auto_combat" as const,
  algorithm: "gauge-random-v1" as const,
  baseHitChance: 1, minHitChance: 1, maxHitChance: 1,
  baseCritChance: 0, maxCritChance: 0,
  normalDamageMin: 1, normalDamageMax: 1,
};

describe("simulateCombat", () => {
  test("uses speed gauges to determine attack order and resolves once", () => {
    const result = simulateCombat(
      schema,
      player({ hp: 30, attack: 10, defense: 0, speed: 20 }),
      npc({ hp: 15, attack: 8, defense: 0, speed: 5 }),
      fixedRules,
      "speed-order"
    );
    expect(result.winner).toBe("player");
    expect(result.actions[0]).toMatchObject({ actorId: "player1", tick: 5, damage: 10, hit: true });
    expect(result.npc.poolAfter).toBe(0);
    expect(result.player.poolAfter).toBe(30);
  });

  test("replays the same random battle from the same seed", () => {
    const args = [
      schema,
      player({ hp: 20, attack: 3, defense: 0, speed: 5 }),
      npc({ hp: 50, attack: 20, defense: 5, speed: 15 }),
      { mode: "auto_combat", algorithm: "gauge-random-v1" } as const,
      "losing-match",
    ] as const;
    const first = simulateCombat(...args);
    const second = simulateCombat(...args);
    expect(first).toEqual(second);
    expect(first.winner).toBe("npc");
    expect(first.risk).toBe("likely_failure");
  });

  test("records misses, critical hits, and luck-dependent rolls", () => {
    const luckySchema: StatsSchema = { defs: [
      ...schema.defs,
      { key: "luck", label: "Luck", min: 0, max: 100, default: 0, display: "number" },
    ] };
    const result = simulateCombat(
      luckySchema,
      player({ hp: 100, attack: 10, defense: 0, speed: 20, luck: 40 }),
      npc({ hp: 100, attack: 5, defense: 0, speed: 10, luck: 0 }),
      {
        mode: "auto_combat", algorithm: "gauge-random-v1",
        baseHitChance: 0.5, luckHitScale: 0.01,
        baseCritChance: 0.1, luckCritScale: 0.02, maxCritChance: 0.9,
        normalDamageMin: 0.5, normalDamageMax: 1.5, critMultiplier: 2,
      },
      "luck-frames"
    );
    expect(result.actions.some((frame) => frame.critical && frame.damageMultiplier === 2)).toBe(true);
    expect(result.actions.every((frame) => frame.hit || frame.damage === 0)).toBe(true);
    expect(result.actions.every((frame) => frame.hitRoll >= 0 && frame.hitRoll < 1)).toBe(true);
  });
});
