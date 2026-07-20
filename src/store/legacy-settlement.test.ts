import { expect, test } from "bun:test";
import { loadWorldPack } from "../engine/world-loader.ts";
import { settleLegacyMutation } from "./legacy-settlement.ts";

function metadata(id: string) {
  return { proposalId: id, correlationId: "turn-1" };
}

test("legacy settlement commits a non-migrated mutation as exact events", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const before = state.player.stats.hp!;
  const result = settleLegacyMutation(state, { kind: "engine/player_stat_changed", stat: "hp", delta: -2 }, metadata("stat"));

  expect(result.accepted).toBe(true);
  expect(state.player.stats.hp).toBe(before - 2);
  expect(state.revision).toBe(1);
  if (result.accepted) expect(result.committedEvents.map(({ event }) => event.kind)).toEqual(["parameter_changed"]);
});

test("legacy settlement rejects invalid mutations without changing authoritative state", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const before = structuredClone(state);
  const result = settleLegacyMutation(state, { kind: "engine/npc_moved", npcId: "missing", toRoomId: state.player.roomId }, metadata("bad-npc"));

  expect(result.accepted).toBe(false);
  expect(state).toEqual(before);
});

test("legacy settlement refuses domains that have typed proposal deciders", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const destination = Object.values(state.rooms[state.player.roomId]!.exits)[0]!;
  const before = structuredClone(state);
  const result = settleLegacyMutation(state, { kind: "engine/player_moved", toRoomId: destination }, metadata("legacy-move"));

  expect(result.accepted).toBe(false);
  if (!result.accepted) expect(result.rejection.code).toBe("unsupported_operation");
  expect(state).toEqual(before);
});
