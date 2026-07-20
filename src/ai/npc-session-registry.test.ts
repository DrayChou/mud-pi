import { describe, expect, test } from "bun:test";
import { loadWorldPack } from "../engine/world-loader.ts";
import type { GameEvent } from "../types/events.ts";
import type { NpcDef } from "../types/world.ts";
import { parseNpcResponse, selectNpcIdsForEvents } from "./npc-session-registry.ts";

const npc: NpcDef = {
  id: "ticket_clerk",
  name: "售票员",
  roomId: "StationHall",
  alive: true,
  personality: "惜字如金",
  controller: "pi_session",
  source: "static",
  stats: { hp: 10 },
  maxStats: { hpMax: 10 },
  hostile: false,
};

describe("NPC session response parsing", () => {
  test("accepts a structured say action", () => {
    expect(parseNpcResponse(
      '{"thought":"这张票很旧","action":{"verb":"say","content":"时刻未到。"}}',
      npc
    )).toEqual({ verb: "say", content: "时刻未到。" });
  });

  test("accepts JSON fenced by the model", () => {
    expect(parseNpcResponse(
      '```json\n{"thought":"沉默更好","action":{"verb":"wait"}}\n```',
      npc
    )).toEqual({ verb: "wait" });
  });

  test("accepts a move intent for later engine validation", () => {
    expect(parseNpcResponse(
      '{"thought":"去站台看看","action":{"verb":"move","direction":"east"}}',
      npc
    )).toEqual({ verb: "move", direction: "east" });
  });

  test("accepts a world-template item reward proposal", () => {
    expect(parseNpcResponse(
      '{"thought":"他确实帮了我","action":{"verb":"give_item","content":"拿着它。","templateId":"small_recovery","itemId":"clerk_tea_turn_3","name":"温热的站务茶","desc":"纸杯上印着已经停运的线路。","aliases":["茶"]}}',
      npc
    )).toEqual({
      verb: "give_item",
      content: "拿着它。",
      templateId: "small_recovery",
      itemId: "clerk_tea_turn_3",
      name: "温热的站务茶",
      desc: "纸杯上印着已经停运的线路。",
      aliases: ["茶"],
    });
  });

  test("rejects unsupported NPC actions", () => {
    expect(parseNpcResponse(
      '{"action":{"verb":"teleport","content":"Platform"}}',
      npc
    )).toBeNull();
  });
});

describe("NPC event perception routing", () => {
  test("wakes a persistent NPC for visible events but not remote events", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const visible: GameEvent = {
      kind: "item_picked_up",
      turn: state.turn,
      actorId: state.player.id,
      itemId: "old_ticket",
      roomId: state.npcs.ticket_clerk!.roomId,
    };
    const remote: GameEvent = { ...visible, roomId: "Platform" };

    expect(selectNpcIdsForEvents(state, [visible])).toEqual(["ticket_clerk"]);
    expect(selectNpcIdsForEvents(state, [remote])).toEqual([]);
  });

  test("routes directed speech only to its target and enforces the wakeup budget", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const clerk = state.npcs.ticket_clerk!;
    state.npcs.watcher = { ...structuredClone(clerk), id: "watcher", name: "旁观者" };
    state.npcs.guard = { ...structuredClone(clerk), id: "guard", name: "守卫" };
    const directed: GameEvent = {
      kind: "player_spoke",
      turn: state.turn,
      actorId: state.player.id,
      roomId: clerk.roomId,
      message: "只对你说",
      targetId: "watcher",
    };
    const publicSpeech: GameEvent = { ...directed, targetId: undefined };

    expect(selectNpcIdsForEvents(state, [directed], 2)).toEqual(["watcher"]);
    expect(selectNpcIdsForEvents(state, [publicSpeech], 2)).toHaveLength(2);

    const directedSignal: GameEvent = {
      kind: "perceptible_signal",
      turn: state.turn,
      signalId: "private-knock",
      roomId: clerk.roomId,
      message: "三短一长的敲击声",
      targetId: "guard",
    };
    expect(selectNpcIdsForEvents(state, [directedSignal], 2)).toEqual(["guard"]);
  });

  test("lets NPCs in either room perceive movement while excluding the mover", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const clerk = state.npcs.ticket_clerk!;
    state.npcs.platform_watcher = {
      ...structuredClone(clerk),
      id: "platform_watcher",
      name: "站台观察者",
      roomId: "Platform",
    };
    const movement: GameEvent = {
      kind: "npc_moved",
      turn: state.turn,
      npcId: "ticket_clerk",
      fromRoomId: clerk.roomId,
      toRoomId: "Platform",
      roomId: "Platform",
    };

    expect(selectNpcIdsForEvents(state, [movement], 3)).toEqual(["platform_watcher"]);
  });
});
