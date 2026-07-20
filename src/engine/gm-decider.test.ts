import { expect, test } from "bun:test";
import { loadWorldPack, loadStoryOutcomes } from "./world-loader.ts";
import { decideGmProposal } from "./gm-decider.ts";
import { projectPublicEvents } from "./public-events.ts";
import { settle } from "../store/settlement.ts";
import type { GmProposal } from "../types/gm-proposals.ts";
import type { ProposalEnvelope } from "../types/proposals.ts";

function envelope(state: { revision: number; turn: number }, payload: GmProposal, proposalId: string): ProposalEnvelope<GmProposal> {
  return { proposalId, correlationId: "gm-turn", source: { kind: "dm", id: "dm", sessionId: "persistent-dm" }, expectedRevision: state.revision, observedTurn: state.turn, payload };
}

test("GM protocol records facts, switches exits, and emits perceptible signals", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const rooms = Object.keys(state.rooms);
  const from = state.player.roomId;
  const to = rooms.find((id) => id !== from)!;
  const context = { storyOutcomes: await loadStoryOutcomes(state.worldPack) };

  const fact = settle(state, envelope(state, { kind: "record_fact", text: "The signal lamp is lit.", roomId: from }, "fact"), decideGmProposal, context);
  const exit = settle(state, envelope(state, { kind: "set_exit", roomId: from, direction: "secret", toRoomId: to }, "exit"), decideGmProposal, context);
  const signal = settle(state, envelope(state, { kind: "emit_signal", signalId: "lamp-lit", roomId: from, message: "The signal lamp flashes twice." }, "signal"), decideGmProposal, context);

  expect(fact.accepted).toBe(true);
  expect(exit.accepted).toBe(true);
  expect(signal.accepted).toBe(true);
  expect(state.worldFacts.at(-1)?.text).toBe("The signal lamp is lit.");
  expect(state.rooms[from]?.exits.secret).toBe(to);
  if (!signal.accepted) throw new Error("signal rejected");
  expect(projectPublicEvents(signal.committedEvents[0]!)).toEqual([{ kind: "perceptible_signal", turn: state.turn, signalId: "lamp-lit", roomId: from, message: "The signal lamp flashes twice.", targetId: undefined }]);
});

test("GM parameter adjustment clamps explicitly and changes lifecycle atomically", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const definition = state.schema.defs.find((candidate) => candidate.thresholds?.some((threshold) => threshold.effect.value !== "active"));
  expect(definition).toBeDefined();
  const parameterId = definition!.key;
  const before = state.player.stats[parameterId]!;
  const result = settle(state, envelope(state, { kind: "adjust_parameter", entityId: state.player.id, parameterId, delta: -100000, cause: "harm:gm_ruling" }, "parameter"), decideGmProposal, { storyOutcomes: [] });

  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error("parameter rejected");
  expect(result.committedEvents.map((event) => event.event.kind)).toEqual(["parameter_changed", "lifecycle_changed"]);
  expect(result.warnings[0]?.code).toBe("value_clamped");
  expect(state.player.stats[parameterId]).toBe(definition!.min);
  expect(state.player.stats[parameterId]).not.toBe(before);
});

test("GM protocol only completes allowed objectives and outcomes", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const storyOutcomes = await loadStoryOutcomes(state.worldPack);
  const objective = Object.values(state.objectives).find((candidate) => (candidate.requires ?? []).length === 0)!;
  const completed = settle(state, envelope(state, { kind: "complete_objective", objectiveId: objective.id, reason: "GM accepted a creative solution." }, "objective"), decideGmProposal, { storyOutcomes });
  expect(completed.accepted).toBe(true);

  const invalid = settle(state, envelope(state, { kind: "reach_outcome", outcome: { id: "invented", type: "success", title: "Invented", summary: "", terminal: true, reachedTurn: state.turn }, requestedAtTurn: state.turn }, "bad-outcome"), decideGmProposal, { storyOutcomes });
  expect(invalid.accepted).toBe(false);
  expect(state.outcome).toBeUndefined();

  const definition = storyOutcomes[0]!;
  const reached = settle(state, envelope(state, { kind: "reach_outcome", outcome: { ...definition, reachedTurn: state.turn }, requestedAtTurn: state.turn, reason: "GM adjudication" }, "outcome"), decideGmProposal, { storyOutcomes });
  expect(reached.accepted).toBe(true);
  expect(state.outcome).toMatchObject({ id: definition.id, reason: "GM adjudication", reachedTurn: state.turn + 1 });
});

test("GM protocol denies player sources and independently controlled NPC movement", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const playerEnvelope = envelope(state, { kind: "record_fact", text: "Forged fact" }, "forged");
  playerEnvelope.source = { kind: "player", id: state.player.id };
  expect(settle(state, playerEnvelope, decideGmProposal, { storyOutcomes: [] }).accepted).toBe(false);

  const npc = Object.values(state.npcs).find((candidate) => candidate.controller && candidate.controller !== "dm");
  if (npc) {
    const destination = Object.keys(state.rooms).find((id) => id !== npc.roomId)!;
    expect(settle(state, envelope(state, { kind: "move_npc", npcId: npc.id, toRoomId: destination }, "npc-move"), decideGmProposal, { storyOutcomes: [] }).accepted).toBe(false);
  }
});
