import { expect, test } from "bun:test";
import { loadWorldPack } from "./world-loader.ts";
import { settle } from "../store/settlement.ts";
import { decideItem, decideMovement } from "./table-deciders.ts";
import type { ItemProposal, MovementProposal } from "../types/table-proposals.ts";

function envelope<T>(stateRevision: number, payload: T, id: string) {
  return {
    proposalId: id,
    correlationId: "typed-domain-test",
    source: { kind: "engine" as const, id: "test" },
    expectedRevision: stateRevision,
    observedTurn: 0,
    payload,
  };
}

const context = { storyOutcomes: [] };

test("typed movement commits movement and first exploration as one transaction", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const from = state.player.roomId;
  const to = Object.values(state.rooms[from]!.exits)[0]!;
  const result = settle(state, envelope<MovementProposal>(state.revision, { kind: "move_player", toRoomId: to }, "move"), decideMovement, context);

  expect(result.accepted).toBe(true);
  expect(state.player.roomId).toBe(to);
  expect(state.rooms[to]!.discovered).toBe(true);
  expect(state.revision).toBe(1);
  if (result.accepted) expect(result.committedEvents.map(({ event }) => event.kind)).toEqual(["player_moved", "room_exploration_recorded"]);
});

test("typed movement rejects destinations that are not connected", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const destination = Object.keys(state.rooms).find((id) => !Object.values(state.rooms[state.player.roomId]!.exits).includes(id))!;
  const before = structuredClone(state);
  const result = settle(state, envelope<MovementProposal>(state.revision, { kind: "move_player", toRoomId: destination }, "bad-move"), decideMovement, context);

  expect(result.accepted).toBe(false);
  expect(state).toEqual(before);
});

test("typed item equipment replacement replays atomically", async () => {
  const state = await loadWorldPack("dnd", { fallbackPlayerName: "冒险者" });
  const first = Object.values(state.items).find((item) => item.equipSlot)!;
  const second = { ...structuredClone(first), id: "typed-replacement", name: "Typed Replacement" };
  state.items[second.id] = second;
  first.location = { kind: "inventory", ownerId: state.player.id };
  second.location = { kind: "inventory", ownerId: state.player.id };
  state.player.inventory = [first.id, second.id];

  const equip = (payload: ItemProposal, id: string) => settle(state, envelope(state.revision, payload, id), decideItem, context);
  expect(equip({ kind: "equip_item", itemId: first.id, slot: first.equipSlot! }, "equip-first").accepted).toBe(true);
  const replacement = equip({ kind: "equip_item", itemId: second.id, slot: second.equipSlot! }, "equip-second");

  expect(replacement.accepted).toBe(true);
  expect(state.items[first.id]!.location).toEqual({ kind: "inventory", ownerId: state.player.id });
  expect(state.items[second.id]!.location).toEqual({ kind: "equipped", ownerId: state.player.id, slot: second.equipSlot! });
  if (replacement.accepted) expect(replacement.committedEvents).toHaveLength(2);
});

test("typed deciders enforce proposal source permissions", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const destination = Object.values(state.rooms[state.player.roomId]!.exits)[0]!;
  const npcMove = settle(state, {
    ...envelope<MovementProposal>(state.revision, { kind: "move_player", toRoomId: destination }, "npc-move"),
    source: { kind: "npc" as const, id: "ticket_clerk" },
  }, decideMovement, context);
  const playerCreate = settle(state, {
    ...envelope<ItemProposal>(state.revision, { kind: "create_item", item: { id: "forged", name: "Forged", desc: "Invalid", location: { kind: "room", roomId: state.player.roomId } } }, "player-create"),
    source: { kind: "player" as const, id: state.player.id },
  }, decideItem, context);

  expect(npcMove.accepted).toBe(false);
  expect(playerCreate.accepted).toBe(false);
  const consumableId = state.player.inventory.find((id) => state.items[id]?.consumable === true);
  if (consumableId) {
    const dmConsume = settle(state, {
      ...envelope<ItemProposal>(state.revision, { kind: "consume_item", itemId: consumableId }, "dm-consume"),
      source: { kind: "dm" as const, id: "dm" },
    }, decideItem, context);
    expect(dmConsume.accepted).toBe(false);
  }
  expect(state.revision).toBe(0);
});

test("typed item creation and consumption enforce item invariants", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const settleItem = (payload: ItemProposal, id: string) => settle(state, envelope(state.revision, payload, id), decideItem, context);

  expect(settleItem({ kind: "create_item", item: { id: "bad-equipment", name: "Bad", desc: "Bad", kind: "equipment", location: { kind: "room", roomId: state.player.roomId } } }, "bad-equipment").accepted).toBe(false);
  expect(settleItem({ kind: "create_item", item: { id: "bad-scenery", name: "Bad Scenery", desc: "Bad", kind: "scenery", portable: true, location: { kind: "room", roomId: state.player.roomId } } }, "bad-scenery").accepted).toBe(false);
  expect(settleItem({ kind: "create_item", item: { id: "mundane", name: "Mundane", desc: "Not consumable", location: { kind: "inventory", ownerId: state.player.id } } }, "mundane").accepted).toBe(true);
  expect(settleItem({ kind: "consume_item", itemId: "mundane" }, "consume-mundane").accepted).toBe(false);
  expect(state.items.mundane?.location).toEqual({ kind: "inventory", ownerId: state.player.id });
});

test("typed item lifecycle handles create, pickup, drop and consume", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const itemId = "typed-token";
  const settleItem = (payload: ItemProposal, id: string) => settle(state, envelope(state.revision, payload, id), decideItem, context);

  expect(settleItem({ kind: "create_item", item: { id: itemId, name: "Token", desc: "A token", consumable: true, location: { kind: "room", roomId: state.player.roomId } } }, "create").accepted).toBe(true);
  expect(settleItem({ kind: "pick_up_item", itemId }, "pickup").accepted).toBe(true);
  expect(settleItem({ kind: "drop_item", itemId, roomId: state.player.roomId }, "drop").accepted).toBe(true);
  expect(settleItem({ kind: "pick_up_item", itemId }, "pickup-again").accepted).toBe(true);
  expect(settleItem({ kind: "consume_item", itemId }, "consume").accepted).toBe(true);

  expect(state.items[itemId]!.location).toEqual({ kind: "destroyed" });
  expect(state.player.inventory).not.toContain(itemId);
  expect(state.revision).toBe(5);
});
