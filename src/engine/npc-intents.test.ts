import { describe, expect, test } from "bun:test";
import type { GameEvent } from "../types/events.ts";
import type { NpcDecision } from "../types/npc.ts";
import type { WorldState } from "../types/world.ts";
import { applyMutations } from "../store/apply.ts";
import { buildRuleNpcDecisions, executeNpcDecision, visibleEntityIds } from "./npc-intents.ts";

function state(): WorldState {
  return {
    worldId: "test",
    worldPack: "test",
    turn: 4,
    schema: { defs: [] },
    player: {
      id: "player1", name: "旅客", roomId: "hall", lifecycle: "active",
      stats: {}, maxStats: {}, inventory: [], equipment: {},
    },
    rooms: {
      hall: { id: "hall", title: "大厅", desc: "", exits: { east: "platform" }, source: "static", discovered: true },
      platform: { id: "platform", title: "站台", desc: "", exits: { west: "hall" }, source: "static", discovered: false },
    },
    npcs: {
      clerk: {
        id: "clerk", name: "售票员", roomId: "hall", alive: true,
        personality: "", controller: "pi_session", source: "static",
        stats: {}, maxStats: {}, hostile: false,
      },
    },
    items: {}, plotThreads: {}, worldFacts: [], objectives: {},
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

  test("settles an NPC attack as a separately validated player damage mutation", () => {
    const s = state();
    s.schema.defs = [
      { key: "hp", label: "HP", min: 0, max: 20, default: 20, display: "bar", onDeplete: "death", role: "pool" },
      { key: "attack", label: "Attack", min: 0, max: 20, default: 3, display: "number", onDeplete: "narrative", role: "attack" },
      { key: "defense", label: "Defense", min: 0, max: 20, default: 0, display: "number", onDeplete: "narrative", role: "defense" },
    ];
    s.player.stats = { hp: 20, defense: 1 };
    s.player.maxStats = { hpMax: 20 };
    s.npcs.clerk!.stats = { hp: 10, attack: 6 };

    const result = executeNpcDecision(s, decision(s, { verb: "attack", targetId: "player1" }));
    applyMutations(s, result.mutations);

    expect(result.mutations).toEqual([{ kind: "engine/player_stat_changed", stat: "hp", delta: -5 }]);
    expect(result.action).toMatchObject({ verb: "attack", targetId: "player1", damage: 5, succeeded: true });
    expect(s.player.stats.hp).toBe(15);
  });

  test("applies flee movement and surrender as authoritative engine mutations", () => {
    const fleeing = state();
    const fleeResult = executeNpcDecision(fleeing, decision(fleeing, { verb: "flee", direction: "east" }));
    applyMutations(fleeing, fleeResult.mutations);
    expect(fleeResult.action.verb).toBe("flee");
    expect(fleeing.npcs.clerk?.roomId).toBe("platform");

    const surrendering = state();
    const surrenderResult = executeNpcDecision(surrendering, decision(surrendering, { verb: "surrender" }));
    applyMutations(surrendering, surrenderResult.mutations);
    expect(surrenderResult.mutations).toEqual([{ kind: "engine/npc_surrendered", npcId: "clerk" }]);
    expect(surrendering.npcs.clerk?.combatState).toBe("surrendered");
  });

  test("rule-controlled NPC retaliates only after receiving a settled attack event", () => {
    const s = state();
    s.npcs.clerk!.controller = "rule";
    const event: GameEvent = {
      kind: "entity_attacked",
      turn: s.turn + 1,
      targetId: "clerk",
      roomId: "hall",
      stat: "hp",
      amount: 3,
    };

    expect(buildRuleNpcDecisions(s, [])).toEqual([]);
    expect(buildRuleNpcDecisions(s, [event])).toEqual([
      expect.objectContaining({ npcId: "clerk", intent: { verb: "attack", targetId: "player1" } }),
    ]);
  });

  test("rejects a response from an earlier turn", () => {
    const s = state();
    const pending = decision(s, { verb: "wait" });
    s.turn += 1;

    const result = executeNpcDecision(s, pending);
    expect(result.action.reason).toBe("决策对应的回合已经过期");
  });
});
