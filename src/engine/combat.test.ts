import { describe, expect, test } from "bun:test";
import { simulateCombat } from "./combat.ts";
import type { NpcDef, PlayerState, StatsSchema } from "../types/world.ts";

const schema: StatsSchema = { defs: [
  { key: "hp", label: "HP", min: 0, max: 100, default: 100, display: "bar", onDeplete: "death", role: "pool" },
  { key: "attack", label: "Attack", min: 0, max: 100, default: 10, display: "number", onDeplete: "narrative", role: "attack" },
  { key: "defense", label: "Defense", min: 0, max: 100, default: 0, display: "number", onDeplete: "narrative", role: "defense" },
  { key: "speed", label: "Speed", min: 1, max: 100, default: 10, display: "number", onDeplete: "narrative", role: "speed" },
] };

function player(stats: Record<string, number>): PlayerState {
  return {
    id: "player1", name: "玩家", roomId: "arena", lifecycle: "active",
    stats, maxStats: { hpMax: stats.hp ?? 100 }, inventory: [], equipment: {},
  };
}

function npc(stats: Record<string, number>): NpcDef {
  return {
    id: "enemy", name: "敌人", roomId: "arena", alive: true, personality: "",
    source: "static", hostile: true, stats, maxStats: { hpMax: stats.hp ?? 100 },
  };
}

describe("simulateCombat", () => {
  test("uses speed gauges to determine attack order and resolves once", () => {
    const result = simulateCombat(
      schema,
      player({ hp: 30, attack: 10, defense: 0, speed: 20 }),
      npc({ hp: 15, attack: 8, defense: 0, speed: 5 })
    );

    expect(result.winner).toBe("player");
    expect(result.actions[0]).toMatchObject({ actorId: "player1", tick: 5, damage: 10 });
    expect(result.npc.poolAfter).toBe(0);
    expect(result.player.poolAfter).toBe(30);
  });

  test("predictably marks a losing matchup without randomness", () => {
    const first = simulateCombat(
      schema,
      player({ hp: 20, attack: 3, defense: 0, speed: 5 }),
      npc({ hp: 50, attack: 20, defense: 5, speed: 15 })
    );
    const second = simulateCombat(
      schema,
      player({ hp: 20, attack: 3, defense: 0, speed: 5 }),
      npc({ hp: 50, attack: 20, defense: 5, speed: 15 })
    );

    expect(first).toEqual(second);
    expect(first.winner).toBe("npc");
    expect(first.risk).toBe("likely_failure");
    expect(first.player.poolAfter).toBe(0);
  });
});
