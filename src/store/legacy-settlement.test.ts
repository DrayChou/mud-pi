import { expect, test } from "bun:test";
import { loadWorldPack } from "../engine/world-loader.ts";
import { settleLegacyMutation } from "./legacy-settlement.ts";

function metadata(id: string) {
  return { proposalId: id, correlationId: "turn-1" };
}

test("legacy settlement commits accepted mutations as exact events", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const destination = Object.values(state.rooms[state.player.roomId]!.exits)[0]!;
  const result = settleLegacyMutation(state, { kind: "engine/player_moved", toRoomId: destination }, metadata("move"));

  expect(result.accepted).toBe(true);
  expect(state.player.roomId).toBe(destination);
  expect(state.revision).toBe(1);
  if (result.accepted) {
    expect(result.committedEvents.map(({ event }) => event.kind)).toEqual(["player_moved", "room_exploration_recorded"]);
  }
});

test("legacy settlement rejects invalid mutations without changing authoritative state", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const before = structuredClone(state);
  const result = settleLegacyMutation(state, { kind: "engine/player_moved", toRoomId: "missing" }, metadata("bad-move"));

  expect(result.accepted).toBe(false);
  expect(state).toEqual(before);
});

test("legacy settlement commits equipment replacement atomically", async () => {
  const state = await loadWorldPack("dnd", { fallbackPlayerName: "冒险者" });
  const first = Object.values(state.items).find((item) => item.equipSlot)!;
  const second = { ...structuredClone(first), id: "replacement-equipment", name: "Replacement Equipment" };
  state.items[second.id] = second;
  first.location = { kind: "inventory", ownerId: state.player.id };
  second.location = { kind: "inventory", ownerId: state.player.id };
  state.player.inventory = [first.id, second.id];

  const firstResult = settleLegacyMutation(state, { kind: "engine/item_equipped", itemId: first!.id, slot: first!.equipSlot! }, metadata("equip-1"));
  const secondResult = settleLegacyMutation(state, { kind: "engine/item_equipped", itemId: second!.id, slot: first!.equipSlot! }, metadata("equip-2"));

  expect(firstResult.accepted).toBe(true);
  expect(secondResult.accepted).toBe(true);
  expect(state.items[first!.id]!.location).toEqual({ kind: "inventory", ownerId: state.player.id });
  expect(state.items[second!.id]!.location).toEqual({ kind: "equipped", ownerId: state.player.id, slot: first!.equipSlot! });
});
