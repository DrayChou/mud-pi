import { describe, expect, test } from "bun:test";
import type { NpcDecision } from "../types/npc.ts";
import type { WorldState } from "../types/world.ts";
import { executeNpcDecision, visibleEntityIds } from "./npc-intents.ts";

function state(): WorldState {
  return {
    worldId: "test",
    worldPack: "test",
    turn: 4,
    schema: { defs: [] },
    player: {
      id: "player1", name: "旅客", roomId: "hall",
      stats: {}, maxStats: {}, inventory: [], equipment: {},
    },
    rooms: {
      hall: { id: "hall", title: "大厅", desc: "", exits: { east: "platform" }, source: "static" },
      platform: { id: "platform", title: "站台", desc: "", exits: { west: "hall" }, source: "static" },
    },
    npcs: {
      clerk: {
        id: "clerk", name: "售票员", roomId: "hall", alive: true,
        personality: "", controller: "pi_session", source: "static",
        stats: {}, maxStats: {}, hostile: false,
      },
    },
    items: {}, plotThreads: {}, worldFacts: [], objectives: {}, endingRules: [],
  };
}

function decision(s: WorldState, intent: NpcDecision["intent"]): NpcDecision {
  return {
    npcId: "clerk",
    context: {
      requestedAtTurn: s.turn,
      roomId: "hall",
      visibleEntityIds: visibleEntityIds(s, "hall"),
    },
    intent,
  };
}

describe("executeNpcDecision", () => {
  test("turns a valid move into an engine mutation", () => {
    const s = state();
    const result = executeNpcDecision(s, decision(s, { verb: "move", direction: "east" }));

    expect(result.mutations).toEqual([
      { kind: "engine/npc_moved", npcId: "clerk", toRoomId: "platform" },
    ]);
    expect(result.action).toMatchObject({
      verb: "move", direction: "east", fromRoomId: "hall", toRoomId: "platform", succeeded: true,
    });
  });

  test("rejects a move without an exit", () => {
    const s = state();
    const result = executeNpcDecision(s, decision(s, { verb: "move", direction: "north" }));

    expect(result.mutations).toEqual([]);
    expect(result.action.succeeded).toBe(false);
    expect(result.action.reason).toContain("没有可用出口");
  });

  test("rejects a stale response after room composition changes", () => {
    const s = state();
    const pending = decision(s, { verb: "say", content: "请出示车票。" });
    s.player.roomId = "platform";

    const result = executeNpcDecision(s, pending);
    expect(result.action.succeeded).toBe(false);
    expect(result.action.reason).toBe("房间内角色已经变化");
  });

  test("rejects a response from an earlier turn", () => {
    const s = state();
    const pending = decision(s, { verb: "wait" });
    s.turn += 1;

    const result = executeNpcDecision(s, pending);
    expect(result.action.reason).toBe("决策对应的回合已经过期");
  });
});
