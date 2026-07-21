import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadWorldPack } from "../engine/world-loader.ts";
import type { TurnRecord } from "../types/mutations.ts";
import { appendTurn, initSave, loadTurns } from "./persist.ts";
import { completeOutbox, drainPersistenceOutbox, enqueueOutbox, pendingOutbox } from "./outbox.ts";

const saveIds: string[] = [];
afterEach(async () => {
  await Promise.all(saveIds.splice(0).map((id) => rm(join(import.meta.dir, "../../saves", id), { recursive: true, force: true })));
});

function turnRecord(): TurnRecord {
  return {
    turn: 1, ts: 1, playerInput: "look", parsed: { verb: "look", args: {}, confidence: 1 },
    engineMutations: [], dmMutations: [], narration: "Nothing changes.", dmModel: "test",
  };
}

test("persistence outbox retries pending effects and deduplicates turn projections", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  state.worldId = `outbox-${Date.now()}-${crypto.randomUUID()}`;
  saveIds.push(state.worldId);
  await initSave(state);

  const turnEffectId = enqueueOutbox(state.worldId, { kind: "turn_record", worldId: state.worldId, record: turnRecord() }, "turn-effect");
  enqueueOutbox(state.worldId, { kind: "snapshot", worldId: state.worldId, revision: state.revision }, "snapshot-effect");
  expect(await pendingOutbox(state.worldId)).toHaveLength(2);

  await appendTurn(state.worldId, { ...turnRecord(), outboxEffectId: turnEffectId });
  let snapshots = 0;
  await drainPersistenceOutbox(state.worldId, state, {
    saveSnapshot: async () => { snapshots += 1; },
    appendTurn: (record) => appendTurn(state.worldId, record),
  });

  expect(await pendingOutbox(state.worldId)).toHaveLength(0);
  expect(await loadTurns(state.worldId)).toHaveLength(1);
  expect(snapshots).toBe(1);

  const completedId = enqueueOutbox(state.worldId, { kind: "turn_record", worldId: state.worldId, record: turnRecord() }, "already-complete");
  completeOutbox(state.worldId, completedId);
  expect(await pendingOutbox(state.worldId)).toHaveLength(0);
});
