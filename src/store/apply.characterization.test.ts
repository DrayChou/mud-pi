import { describe, expect, test } from "bun:test";
import { applyMutation, applyMutations } from "./apply.ts";
import type { AnyMutation } from "../types/mutations.ts";
import type { ItemDef, NpcDef, RoomDef, WorldState } from "../types/world.ts";

function room(id: string, discovered = false): RoomDef {
  return {
    id,
    title: id,
    desc: `${id} description`,
    exits: {},
    source: "static",
    discovered,
  };
}

function npc(id: string, controller?: NpcDef["controller"]): NpcDef {
  return {
    id,
    name: id,
    roomId: "start",
    alive: true,
    personality: "quiet",
    controller,
    source: "static",
    stats: { hp: 6 },
    maxStats: { hpMax: 10 },
    hostile: false,
  };
}

function item(id: string, location: ItemDef["location"], kind: ItemDef["kind"] = "item"): ItemDef {
  return {
    id,
    name: id,
    desc: `${id} description`,
    kind,
    location,
    portable: true,
    source: "static",
  };
}

function makeState(): WorldState {
  return {
    worldId: "characterization",
    worldPack: "characterization",
    turn: 4,
    schema: {
      defs: [
        {
          key: "hp",
          label: "HP",
          min: 0,
          max: 10,
          default: 10,
          display: "bar",
          thresholds: [
            { operator: "lte", value: 0, effect: { kind: "set_lifecycle", value: "dead" } },
            { operator: "lte", value: 2, effect: { kind: "set_lifecycle", value: "incapacitated" } },
          ],
        },
        { key: "focus", label: "Focus", min: -2, max: 5, default: 1, display: "number" },
      ],
    },
    itemRewardRules: {
      maxGrantedPerTurn: 2,
      templates: [
        {
          id: "tonic",
          label: "Tonic",
          guidance: "A small restorative.",
          kind: "item",
          effects: [{ code: "recover", parameterId: "hp", value: 2 }],
          consumable: true,
          maxPerGrantor: 1,
        },
        {
          id: "badge",
          label: "Badge",
          guidance: "A wearable badge.",
          kind: "equipment",
          equipSlot: "chest",
          parameterModifiers: [{ parameterId: "focus", operation: "add", value: 1 }],
          maxPerGrantor: 2,
        },
      ],
    },
    player: {
      id: "player",
      name: "Player",
      roomId: "start",
      lifecycle: "active",
      stats: { hp: 6, focus: 1 },
      maxStats: { hpMax: 10, focusMax: 5 },
      inventory: [],
      equipment: {},
    },
    rooms: { start: room("start", true), hall: room("hall") },
    npcs: {
      dm_npc: npc("dm_npc", "dm"),
      legacy_npc: npc("legacy_npc"),
      rule_npc: npc("rule_npc", "rule"),
      dead_npc: { ...npc("dead_npc", "dm"), alive: false },
    },
    items: {
      floor_item: item("floor_item", { kind: "room", roomId: "start" }),
      remote_item: item("remote_item", { kind: "room", roomId: "hall" }),
      carried: item("carried", { kind: "inventory", ownerId: "player" }),
      old_hat: item("old_hat", { kind: "inventory", ownerId: "player" }, "equipment"),
      new_hat: item("new_hat", { kind: "inventory", ownerId: "player" }, "equipment"),
    },
    plotThreads: {},
    worldFacts: [],
    objectives: {
      quest: {
        id: "quest",
        title: "Quest",
        description: "Finish the quest",
        completion: { kind: "visit_room", roomId: "hall" },
        status: "active",
        reward: {
          mode: "ai_judged",
          guidance: "Reward completion",
          allowedTemplateIds: ["tonic"],
          eligibleGrantorNpcIds: ["dm_npc"],
          maxAwards: 1,
        },
      },
    },
  };
}

function expectRejectedWithoutChange(state: WorldState, mutation: AnyMutation): void {
  const before = structuredClone(state);
  applyMutation(state, mutation);
  expect(state).toEqual(before);
}

describe("applyMutation characterization", () => {
  test("moves the player, discovers the destination, and records only the first visit turn", () => {
    const state = makeState();

    applyMutation(state, { kind: "engine/player_moved", toRoomId: "hall" });
    expect(state.player.roomId).toBe("hall");
    expect(state.rooms.hall).toMatchObject({ discovered: true, visitedTurn: 5 });

    state.turn = 9;
    state.player.roomId = "start";
    applyMutation(state, { kind: "engine/player_moved", toRoomId: "hall" });
    expect(state.rooms.hall!.visitedTurn).toBe(5);

    expectRejectedWithoutChange(state, { kind: "engine/player_moved", toRoomId: "missing" });
  });

  test("clamps player and NPC parameters and applies lifecycle thresholds", () => {
    const state = makeState();

    applyMutation(state, { kind: "engine/player_stat_changed", stat: "focus", delta: 99 });
    expect(state.player.stats.focus).toBe(5);
    applyMutation(state, { kind: "engine/player_stat_changed", stat: "focus", delta: -99 });
    expect(state.player.stats.focus).toBe(-2);

    applyMutation(state, { kind: "engine/player_stat_changed", stat: "hp", delta: -4 });
    expect(state.player.stats.hp).toBe(2);
    expect(state.player.lifecycle).toBe("incapacitated");
    applyMutation(state, { kind: "engine/player_stat_changed", stat: "hp", delta: 1 });
    expect(state.player.lifecycle).toBe("active");
    applyMutation(state, { kind: "engine/player_stat_changed", stat: "hp", delta: -99 });
    expect(state.player.stats.hp).toBe(0);
    expect(state.player.lifecycle).toBe("dead");
    applyMutation(state, { kind: "engine/player_stat_changed", stat: "hp", delta: 10 });
    expect(state.player.lifecycle).toBe("dead");

    applyMutation(state, { kind: "engine/npc_stat_changed", npcId: "dm_npc", stat: "hp", delta: 99 });
    expect(state.npcs.dm_npc!.stats.hp).toBe(10);
  });

  test("preserves engine NPC guards and DM controller permissions", () => {
    const state = makeState();

    applyMutation(state, { kind: "engine/npc_moved", npcId: "dm_npc", toRoomId: "hall" });
    expect(state.npcs.dm_npc!.roomId).toBe("hall");
    expectRejectedWithoutChange(state, { kind: "engine/npc_moved", npcId: "dead_npc", toRoomId: "hall" });
    expectRejectedWithoutChange(state, { kind: "engine/npc_moved", npcId: "legacy_npc", toRoomId: "missing" });

    applyMutations(state, [
      { kind: "dm/npc_moved", npcId: "legacy_npc", toRoomId: "hall" },
      { kind: "dm/npc_stat_changed", npcId: "legacy_npc", stat: "hp", delta: -2 },
      { kind: "dm/npc_killed", npcId: "legacy_npc" },
    ]);
    expect(state.npcs.legacy_npc).toMatchObject({ roomId: "hall", alive: false, stats: { hp: 4 } });

    for (const mutation of [
      { kind: "dm/npc_moved", npcId: "rule_npc", toRoomId: "hall" },
      { kind: "dm/npc_stat_changed", npcId: "rule_npc", stat: "hp", delta: -2 },
      { kind: "dm/npc_killed", npcId: "rule_npc" },
    ] satisfies AnyMutation[]) {
      expectRejectedWithoutChange(state, mutation);
    }
  });

  test("creates DM items only at valid locations and rejects duplicates", () => {
    const state = makeState();
    const roomItem = item("dm_room_item", { kind: "room", roomId: "hall" });
    delete roomItem.portable;
    delete roomItem.source;

    applyMutation(state, { kind: "dm/item_added", item: roomItem });
    expect(state.items.dm_room_item).toMatchObject({
      portable: true,
      source: "dm_generated",
      createdTurn: 4,
      location: { kind: "room", roomId: "hall" },
    });

    applyMutation(state, {
      kind: "dm/item_added",
      item: item("dm_inventory_item", { kind: "inventory", ownerId: "player" }),
    });
    expect(state.player.inventory).toEqual(["dm_inventory_item"]);

    expectRejectedWithoutChange(state, {
      kind: "dm/item_added",
      item: item("bad_owner", { kind: "inventory", ownerId: "someone_else" }),
    });
    expectRejectedWithoutChange(state, {
      kind: "dm/item_added",
      item: item("dm_room_item", { kind: "room", roomId: "start" }),
    });
  });

  test("preserves pickup, equip replacement, drop, and consume transitions", () => {
    const state = makeState();
    state.player.inventory = ["carried", "old_hat", "new_hat"];

    applyMutation(state, { kind: "engine/item_picked_up", itemId: "floor_item" });
    expect(state.player.inventory).toContain("floor_item");
    expect(state.items.floor_item!.location).toEqual({ kind: "inventory", ownerId: "player" });
    expectRejectedWithoutChange(state, { kind: "engine/item_picked_up", itemId: "remote_item" });

    applyMutation(state, { kind: "engine/item_equipped", itemId: "old_hat", slot: "head" });
    applyMutation(state, { kind: "engine/item_equipped", itemId: "new_hat", slot: "head" });
    expect(state.player.equipment.head).toBe("new_hat");
    expect(state.items.old_hat!.location).toEqual({ kind: "inventory", ownerId: "player" });
    expect(state.items.new_hat!.location).toEqual({ kind: "equipped", ownerId: "player", slot: "head" });

    applyMutation(state, { kind: "engine/item_dropped", itemId: "new_hat", roomId: "start" });
    expect(state.player.equipment.head).toBeUndefined();
    expect(state.player.inventory).not.toContain("new_hat");
    expect(state.items.new_hat!.location).toEqual({ kind: "room", roomId: "start" });
    expectRejectedWithoutChange(state, { kind: "engine/item_dropped", itemId: "remote_item", roomId: "start" });

    applyMutation(state, { kind: "engine/item_consumed", itemId: "carried" });
    expect(state.player.inventory).not.toContain("carried");
    expect(state.items.carried!.location).toEqual({ kind: "destroyed" });
  });

  test("materializes valid rewards and leaves state untouched for stale or invalid rewards", () => {
    const state = makeState();
    state.objectives.quest!.status = "completed";
    state.objectives.quest!.completedTurn = 4;

    applyMutation(state, {
      kind: "engine/item_reward_granted",
      grantorNpcId: "dm_npc",
      templateId: "tonic",
      objectiveId: "quest",
      itemId: "quest_tonic",
      name: "  Quest Tonic  ",
      desc: "  Restores resolve.  ",
      aliases: ["  tonic  ", ""],
      requestedAtTurn: 4,
    });
    expect(state.player.inventory).toEqual(["quest_tonic"]);
    expect(state.items.quest_tonic).toEqual({
      id: "quest_tonic",
      name: "Quest Tonic",
      desc: "Restores resolve.",
      aliases: ["tonic"],
      kind: "item",
      equipSlot: undefined,
      parameterModifiers: [],
      traits: [],
      effects: [{ code: "recover", parameterId: "hp", value: 2 }],
      consumable: true,
      portable: true,
      location: { kind: "inventory", ownerId: "player" },
      source: "dm_generated",
      createdTurn: 4,
      rewardTemplateId: "tonic",
      rewardObjectiveId: "quest",
      grantedByEntityId: "dm_npc",
    });

    expectRejectedWithoutChange(state, {
      kind: "dm/item_reward_granted",
      templateId: "badge",
      itemId: "stale_badge",
      name: "Badge",
      desc: "Too late",
      requestedAtTurn: 3,
    });
    expectRejectedWithoutChange(state, {
      kind: "engine/item_reward_granted",
      grantorNpcId: "dm_npc",
      templateId: "tonic",
      objectiveId: "quest",
      itemId: "second_tonic",
      name: "Second",
      desc: "Duplicate objective award",
      requestedAtTurn: 4,
    });
  });

  test("completes objectives once and accepts only a current, first outcome", () => {
    const state = makeState();
    applyMutation(state, { kind: "engine/objective_completed", objectiveId: "quest" });
    expect(state.objectives.quest).toMatchObject({ status: "completed", completedTurn: 5 });

    state.turn = 8;
    applyMutation(state, { kind: "engine/objective_completed", objectiveId: "quest" });
    expect(state.objectives.quest!.completedTurn).toBe(5);
    expectRejectedWithoutChange(state, { kind: "engine/objective_completed", objectiveId: "missing" });

    const outcome = {
      id: "escaped",
      type: "success" as const,
      title: "Escaped",
      summary: "The player escaped.",
      terminal: true,
      reachedTurn: 0,
    };
    expectRejectedWithoutChange(state, { kind: "dm/outcome_reached", outcome, requestedAtTurn: 7 });
    applyMutation(state, { kind: "dm/outcome_reached", outcome, requestedAtTurn: 8 });
    expect(state.outcome).toEqual({ ...outcome, reachedTurn: 9 });

    const settled = structuredClone(state);
    applyMutation(state, {
      kind: "dm/outcome_reached",
      outcome: { ...outcome, id: "other", title: "Other" },
      requestedAtTurn: 8,
    });
    expect(state).toEqual(settled);
  });

  test("deduplicates facts and creates then partially updates plot threads", () => {
    const state = makeState();
    applyMutations(state, [
      { kind: "dm/fact_added", text: "The bell is broken.", tile: "start" },
      { kind: "dm/fact_added", text: "The bell is broken.", tile: "hall" },
      { kind: "dm/plot_updated", id: "escape", title: "Escape", summary: "Find a way out." },
    ]);
    expect(state.worldFacts).toEqual([{ text: "The bell is broken.", tile: "start", createdTurn: 4 }]);
    expect(state.plotThreads.escape).toEqual({
      id: "escape",
      title: "Escape",
      status: "active",
      summary: "Find a way out.",
      updatedTurn: 4,
    });

    state.turn = 5;
    applyMutations(state, [
      { kind: "dm/plot_updated", id: "escape", status: "resolved" },
      { kind: "dm/fact_removed", text: "The bell is broken." },
    ]);
    expect(state.plotThreads.escape).toEqual({
      id: "escape",
      title: "Escape",
      status: "resolved",
      summary: "Find a way out.",
      updatedTurn: 5,
    });
    expect(state.worldFacts).toEqual([]);
  });
});

describe("applyMutations ordered batch characterization", () => {
  test("later mutations observe rooms and items created earlier in the batch", () => {
    const state = makeState();
    applyMutations(state, [
      { kind: "dm/room_added", room: room("vault") },
      { kind: "dm/room_exit_added", roomId: "start", direction: "east", toRoomId: "vault" },
      { kind: "engine/player_moved", toRoomId: "vault" },
      { kind: "dm/item_added", item: item("vault_key", { kind: "room", roomId: "vault" }) },
      { kind: "engine/item_picked_up", itemId: "vault_key" },
      { kind: "engine/turn_advanced" },
    ]);

    expect(state.rooms.start!.exits.east).toBe("vault");
    expect(state.player.roomId).toBe("vault");
    expect(state.rooms.vault).toMatchObject({ source: "dm_generated", createdTurn: 4, discovered: true, visitedTurn: 5 });
    expect(state.items.vault_key!.location).toEqual({ kind: "inventory", ownerId: "player" });
    expect(state.player.inventory).toEqual(["vault_key"]);
    expect(state.turn).toBe(5);
  });

  test("reversing dependent operations preserves rejection and does not stop later mutations", () => {
    const state = makeState();
    applyMutations(state, [
      { kind: "engine/player_moved", toRoomId: "late_room" },
      { kind: "engine/item_picked_up", itemId: "late_item" },
      { kind: "dm/room_added", room: room("late_room") },
      { kind: "dm/item_added", item: item("late_item", { kind: "room", roomId: "start" }) },
      { kind: "engine/turn_advanced" },
    ]);

    expect(state.player.roomId).toBe("start");
    expect(state.rooms.late_room).toBeDefined();
    expect(state.items.late_item!.location).toEqual({ kind: "room", roomId: "start" });
    expect(state.player.inventory).not.toContain("late_item");
    expect(state.turn).toBe(5);
  });
});
