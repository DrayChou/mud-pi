import { describe, expect, test } from "bun:test";
import type { NpcDecision } from "../types/npc.ts";
import type { WorldState } from "../types/world.ts";
import { applyMutations } from "../store/apply.ts";
import { executeCommand } from "./commands.ts";
import { executeNpcDecision, visibleEntityIds } from "./npc-intents.ts";

function state(): WorldState {
  return {
    worldId: "test", worldPack: "test", turn: 4, schema: { defs: [] },
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
    itemRewardRules: {
      maxGrantedPerTurn: 2,
      templates: [{
        id: "small_recovery",
        label: "小型恢复用品",
        guidance: "完成合理帮助后可赠予",
        kind: "item",
        effects: [{ code: "recover_parameter", parameterId: "hp", value: 3 }],
        consumable: true,
        maxPerGrantor: 1,
      }],
    },
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
    expect(result.mutations).toEqual([{ kind: "engine/npc_moved", npcId: "clerk", toRoomId: "platform" }]);
    expect(result.action).toMatchObject({
      verb: "move", direction: "east", fromRoomId: "hall", toRoomId: "platform", succeeded: true,
    });
  });

  test("lets an NPC grant a usable world-template reward", () => {
    const s = state();
    s.schema.defs.push({ key: "hp", label: "生命", min: 0, max: 10, default: 10, display: "bar" });
    s.player.stats.hp = 5;
    s.player.maxStats.hpMax = 10;
    const result = executeNpcDecision(s, decision(s, {
      verb: "give_item",
      content: "这是你应得的。",
      templateId: "small_recovery",
      itemId: "clerk_reward_turn_5",
      name: "温热药茶",
      desc: "售票员从柜台下取出的纸杯。",
    }));
    expect(result.action).toMatchObject({ verb: "give_item", succeeded: true, itemId: "clerk_reward_turn_5" });
    applyMutations(s, result.mutations);
    expect(s.player.inventory).toContain("clerk_reward_turn_5");
    expect(s.items.clerk_reward_turn_5).toMatchObject({
      rewardTemplateId: "small_recovery",
      grantedByEntityId: "clerk",
      consumable: true,
      location: { kind: "inventory", ownerId: "player1" },
    });

    const useResult = executeCommand(s, {
      verb: "use",
      args: { item: "温热药茶" },
      confidence: 1,
      raw: "使用温热药茶",
    });
    applyMutations(s, useResult.mutations);
    expect(s.player.stats.hp).toBe(8);
    expect(s.items.clerk_reward_turn_5?.location).toEqual({ kind: "destroyed" });
  });

  test("rejects a reward that is not declared by the world", () => {
    const s = state();
    const result = executeNpcDecision(s, decision(s, {
      verb: "give_item",
      content: "给你神器。",
      templateId: "invented_legendary_sword",
      itemId: "bad_reward",
      name: "神器",
      desc: "不应被接受。",
    }));
    expect(result.mutations).toEqual([]);
    expect(result.action.succeeded).toBe(false);
    expect(result.action.reason).toContain("模板");
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
