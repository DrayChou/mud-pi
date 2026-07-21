import { expect, test } from "bun:test";
import { loadStoryOutcomes, loadWorldPack } from "../engine/world-loader.ts";
import { settleGmBatch } from "./gm-protocol.ts";
import type { GmTableProposal } from "../types/gm-proposals.ts";
import type { ProposalBatchEnvelope } from "../types/proposals.ts";

test("Pi GM batch settles ordered independent table operations without rolling back siblings", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const outcomes = await loadStoryOutcomes(state.worldPack);
  const batch: ProposalBatchEnvelope<GmTableProposal> = {
    batchId: "dm-response-1",
    correlationId: "turn-1",
    source: { kind: "dm", id: "dm", sessionId: "persistent-dm" },
    expectedRevision: state.revision,
    observedTurn: state.turn,
    proposals: [
      { proposalId: "fact-1", payload: { kind: "record_fact", text: "The old clock has stopped.", roomId: state.player.roomId } },
      { proposalId: "bad-card", payload: { kind: "create_item", item: { id: "invalid-scenery", name: "Invalid", desc: "Invalid", kind: "scenery", portable: true, location: { kind: "inventory", ownerId: state.player.id } } } },
      { proposalId: "signal-1", payload: { kind: "emit_signal", signalId: "clock-stop", roomId: state.player.roomId, message: "The clock gives one final click." } },
    ],
  };

  const result = settleGmBatch(state, batch, outcomes);
  expect(result.accepted).toBe(true);
  expect(result.settlements.map((settlement) => settlement.accepted)).toEqual([true, false, true]);
  expect(state.revision).toBe(2);
  expect(state.worldFacts.some((fact) => fact.text === "The old clock has stopped.")).toBe(true);
  expect(state.items["invalid-scenery"]).toBeUndefined();
});

test("Pi GM batch requires the DM source for privileged operations", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const batch: ProposalBatchEnvelope<GmTableProposal> = {
    batchId: "forged-response",
    correlationId: "turn-1",
    source: { kind: "player", id: state.player.id },
    expectedRevision: state.revision,
    observedTurn: state.turn,
    proposals: [{ proposalId: "forged-fact", payload: { kind: "record_fact", text: "Forged" } }],
  };

  const result = settleGmBatch(state, batch, []);
  expect(result.accepted).toBe(true);
  expect(result.settlements[0]?.accepted).toBe(false);
  expect(state.revision).toBe(0);

  const scriptBatch: ProposalBatchEnvelope<GmTableProposal> = {
    ...batch,
    batchId: "script-response",
    source: { kind: "world_script", id: "direct-script" },
    proposals: [{ proposalId: "script-card", payload: { kind: "create_item", item: { id: "script-card", name: "Script Card", desc: "Denied", location: { kind: "room", roomId: state.player.roomId } } } }],
  };
  const scriptResult = settleGmBatch(state, scriptBatch, []);
  expect(scriptResult.settlements[0]?.accepted).toBe(false);
  expect(state.items["script-card"]).toBeUndefined();
});
