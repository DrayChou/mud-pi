import { expect, test } from "bun:test";
import { validateNarrativeClaims } from "./narrative-claims.ts";
import { loadWorldPack } from "./world-loader.ts";

test("validates authoritative narration claims against committed state", async () => {
  const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
  const roomId = state.player.roomId;
  const destination = state.rooms[roomId]!.exits.east!;
  state.outcome = {
    id: "arkham_tide_averted",
    type: "success",
    title: "退去的黑潮",
    summary: "危机解除",
    terminal: true,
    reachedTurn: 2,
  };

  const valid = validateNarrativeClaims(state, [
    { kind: "player_location", roomId },
    { kind: "entity_present", entityId: state.player.id, roomId },
    { kind: "exit_available", roomId, direction: "east", toRoomId: destination },
    { kind: "outcome", outcomeId: "arkham_tide_averted" },
  ]);
  const invalid = validateNarrativeClaims(state, [
    { kind: "player_location", roomId: "missing" },
    { kind: "npc_lifecycle", npcId: "librarian", alive: false },
  ]);

  expect(valid).toEqual([]);
  expect(invalid).toHaveLength(2);
});
