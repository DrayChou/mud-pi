import { describe, expect, test } from "bun:test";
import { loadWorldPack } from "./world-loader.ts";
import { evaluateProgress } from "./progress.ts";
import { applyMutations } from "../store/apply.ts";
import type { GameEvent } from "../types/events.ts";

describe("objective progress", () => {
  test("completes objectives in dependency order", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const speech: GameEvent[] = [{
      kind: "player_spoke",
      turn: 1,
      actorId: "player1",
      roomId: "StationHall",
      message: "这张票去哪？",
      targetId: "ticket_clerk",
    }];

    const first = evaluateProgress(state, speech);
    expect(first).toEqual([{ kind: "engine/objective_completed", objectiveId: "ask_ticket_clerk" }]);
    applyMutations(state, first);

    state.player.roomId = "Compartment1";
    const second = evaluateProgress(state, [{
      kind: "player_moved",
      turn: 2,
      actorId: "player1",
      fromRoomId: "Platform",
      toRoomId: "Compartment1",
      roomId: "Compartment1",
    }]);
    expect(second).toEqual([{ kind: "engine/objective_completed", objectiveId: "board_train" }]);
  });

  test("does not decide story outcomes in deterministic objective code", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.objectives.ask_ticket_clerk!.status = "completed";
    state.objectives.board_train!.status = "completed";
    state.objectives.cross_echo_gate!.status = "completed";
    state.npcs.shadow!.alive = false;

    const mutations = evaluateProgress(state, [{
      kind: "entity_defeated",
      turn: 3,
      entityId: "shadow",
      roomId: "Compartment3",
    }]);

    expect(mutations).toEqual([
      { kind: "engine/objective_completed", objectiveId: "face_shadow" },
    ]);
    expect(state.outcome).toBeUndefined();
  });
});
