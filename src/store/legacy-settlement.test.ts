import { expect, test } from "bun:test";
import { loadWorldPack } from "../engine/world-loader.ts";
import { nextLegacyProposalId, settleLegacyMutation } from "./legacy-settlement.ts";

function metadata(id: string) {
  return { proposalId: id, correlationId: "turn-1" };
}

test("runtime-generated proposal ids use UUIDs instead of restartable counters", () => {
  const first = nextLegacyProposalId("turn");
  const second = nextLegacyProposalId("turn");
  expect(first).not.toBe(second);
  expect(first).toMatch(/^turn-[0-9a-f-]{36}$/);
  expect(second).toMatch(/^turn-[0-9a-f-]{36}$/);
});

test("legacy settlement commits a non-migrated mutation as exact events", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const before = state.turn;
  const result = settleLegacyMutation(state, { kind: "engine/turn_advanced" }, metadata("turn"));

  expect(result.accepted).toBe(true);
  expect(state.turn).toBe(before + 1);
  expect(state.revision).toBe(1);
  if (result.accepted) expect(result.committedEvents.map(({ event }) => event.kind)).toEqual(["turn_advanced"]);
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
