import { describe, expect, test } from "bun:test";
import { loadWorldPack } from "./world-loader.ts";
import { deriveGameEvents } from "./game-events.ts";
import { applyMutations } from "../store/apply.ts";
import type { AnyMutation } from "../types/mutations.ts";

describe("deriveGameEvents", () => {
  test("derives movement and speech without mutating snapshots", async () => {
    const before = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
    });
    const after = structuredClone(before);
    const mutations: AnyMutation[] = [
      { kind: "engine/player_moved", toRoomId: "Platform" },
    ];
    applyMutations(after, mutations);

    const events = deriveGameEvents(before, mutations, after, {
      playerSpeech: { message: "  这班车去哪？  ", targetId: "ticket_clerk" },
    });

    expect(events).toEqual([
      {
        kind: "player_spoke",
        turn: 1,
        actorId: "player1",
        roomId: "StationHall",
        message: "这班车去哪？",
        targetId: "ticket_clerk",
      },
      {
        kind: "player_moved",
        turn: 1,
        actorId: "player1",
        fromRoomId: "StationHall",
        toRoomId: "Platform",
        roomId: "Platform",
      },
    ]);
    expect(before.player.roomId).toBe("StationHall");
  });

  test("derives item use and consumption from world-script mutations", async () => {
    const before = await loadWorldPack("dnd", { fallbackPlayerName: "冒险者" });
    const after = structuredClone(before);
    const mutations: AnyMutation[] = [{ kind: "engine/item_consumed", itemId: "healing_potion" }];
    applyMutations(after, mutations);

    expect(deriveGameEvents(before, mutations, after)).toEqual([{
      kind: "item_consumed",
      turn: 1,
      actorId: before.player.id,
      itemId: "healing_potion",
      roomId: before.player.roomId,
    }]);
  });

  test("derives item lifecycle events from applied mutations", async () => {
    const before = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
      protagonistId: "runaway_guard",
    });
    before.player.roomId = "Compartment1";
    const pickedUp = structuredClone(before);
    const pickup: AnyMutation[] = [
      { kind: "engine/item_picked_up", itemId: "rusty_knife" },
    ];
    applyMutations(pickedUp, pickup);

    expect(deriveGameEvents(before, pickup, pickedUp)).toEqual([
      {
        kind: "item_picked_up",
        turn: 1,
        actorId: "player1",
        itemId: "rusty_knife",
        roomId: "Compartment1",
      },
    ]);

    const dropped = structuredClone(pickedUp);
    const drop: AnyMutation[] = [
      { kind: "engine/item_dropped", itemId: "rusty_knife", roomId: "Compartment1" },
    ];
    applyMutations(dropped, drop);
    expect(deriveGameEvents(pickedUp, drop, dropped)[0]).toMatchObject({
      kind: "item_dropped",
      itemId: "rusty_knife",
      roomId: "Compartment1",
    });
  });

  test("publishes creation and direct acquisition for a DM-granted item", async () => {
  const before = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const after = structuredClone(before);
  const mutations: AnyMutation[] = [{
    kind: "dm/item_added",
    item: {
      id: "platform_token",
      name: "站台代币",
      desc: "售票员塞进你掌心的铝制代币。",
      portable: true,
      source: "dm_generated",
      location: { kind: "inventory", ownerId: before.player.id },
    },
  }];
  applyMutations(after, mutations);

  expect(deriveGameEvents(before, mutations, after)).toEqual([
    {
      kind: "item_created",
      turn: 1,
      itemId: "platform_token",
      roomId: before.player.roomId,
    },
    {
      kind: "item_granted",
      turn: 1,
      actorId: before.player.id,
      itemId: "platform_token",
      roomId: before.player.roomId,
    },
  ]);
});

test("does not publish creation for a rejected duplicate item mutation", async () => {
  const before = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const after = structuredClone(before);
  const existing = before.items.ticket!;
  const mutations: AnyMutation[] = [{
    kind: "dm/item_added",
    item: {
      ...structuredClone(existing),
      name: "伪造车票",
      location: { kind: "room", roomId: before.player.roomId },
    },
  }];
  applyMutations(after, mutations);

  expect(deriveGameEvents(before, mutations, after)).toEqual([]);
});

test("publishes creation and pickup for a DM-created item", async () => {
    const before = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
    });
    const after = structuredClone(before);
    const mutations: AnyMutation[] = [
      {
        kind: "dm/item_added",
        item: {
          id: "dark_scale",
          name: "深色鳞片",
          desc: "边缘泛着虹彩。",
          portable: true,
          source: "dm_generated",
          location: { kind: "room", roomId: "StationHall" },
        },
      },
      { kind: "engine/item_picked_up", itemId: "dark_scale" },
    ];
    applyMutations(after, mutations);

    expect(deriveGameEvents(before, mutations, after)).toEqual([
      { kind: "item_created", turn: 1, itemId: "dark_scale", roomId: "StationHall" },
      {
        kind: "item_picked_up",
        turn: 1,
        actorId: "player1",
        itemId: "dark_scale",
        roomId: "StationHall",
      },
    ]);
  });

  test("does not publish a mutation rejected by the state layer", async () => {
    const before = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
      protagonistId: "runaway_guard",
    });
    const after = structuredClone(before);
    const mutations: AnyMutation[] = [
      { kind: "engine/item_picked_up", itemId: "rusty_knife" },
      { kind: "dm/npc_moved", npcId: "ticket_clerk", toRoomId: "Platform" },
    ];
    applyMutations(after, mutations);

    expect(deriveGameEvents(before, mutations, after)).toEqual([]);
  });

  test("derives player death from a depleted death pool", async () => {
    const before = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    before.player.stats.hp = 5;
    const after = structuredClone(before);
    const mutations: AnyMutation[] = [
      { kind: "engine/player_stat_changed", stat: "hp", delta: -5 },
    ];
    applyMutations(after, mutations);

    expect(after.player.lifecycle).toBe("dead");
    expect(deriveGameEvents(before, mutations, after)).toEqual([
      {
        kind: "entity_attacked",
        turn: 1,
        targetId: "player1",
        roomId: "StationHall",
        stat: "hp",
        amount: 5,
      },
      {
        kind: "player_died",
        turn: 1,
        actorId: "player1",
        roomId: "StationHall",
      },
    ]);
  });

  test("flags the death of a critical NPC for story evaluation", async () => {
    const before = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const after = structuredClone(before);
    const mutations: AnyMutation[] = [
      { kind: "engine/npc_killed", npcId: "ticket_clerk" },
    ];
    applyMutations(after, mutations);

    expect(deriveGameEvents(before, mutations, after)).toEqual([
      {
        kind: "entity_defeated",
        turn: 1,
        entityId: "ticket_clerk",
        roomId: "StationHall",
      },
      {
        kind: "critical_npc_died",
        turn: 1,
        npcId: "ticket_clerk",
        roomId: "StationHall",
        deathPolicy: "ai_evaluate",
        notes: before.npcs.ticket_clerk?.storyRole?.notes,
      },
    ]);
  });

  test("derives attack and defeat events", async () => {
    const before = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
    });
    before.player.roomId = "Compartment3";
    const after = structuredClone(before);
    const mutations: AnyMutation[] = [
      { kind: "engine/npc_stat_changed", npcId: "shadow", stat: "hp", delta: -30 },
      { kind: "engine/npc_killed", npcId: "shadow" },
    ];
    applyMutations(after, mutations);

    expect(deriveGameEvents(before, mutations, after)).toEqual([
      {
        kind: "entity_attacked",
        turn: 1,
        targetId: "shadow",
        roomId: "Compartment3",
        stat: "hp",
        amount: 30,
      },
      {
        kind: "entity_defeated",
        turn: 1,
        entityId: "shadow",
        roomId: "Compartment3",
      },
    ]);
  });
});
