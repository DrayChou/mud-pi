import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadWorldPack } from "../engine/world-loader.ts";
import { settleGmOperation } from "./gm-protocol.ts";
import { initSave, loadState, loadTurns } from "./persist.ts";
import { readJournal, stageJournalOutbox } from "./journal.ts";

const saveIds: string[] = [];
const saveDir = (id: string) => join(import.meta.dir, "../../saves", id);

afterEach(async () => {
  await Promise.all(saveIds.splice(0).map((id) => rm(saveDir(id), { recursive: true, force: true })));
});

async function durableState() {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  state.worldId = `journal-${Date.now()}-${crypto.randomUUID()}`;
  saveIds.push(state.worldId);
  await initSave(state);
  return state;
}

describe("world event journal", () => {
  test("replays committed transactions after an older snapshot", async () => {
    const state = await durableState();
    const settlement = settleGmOperation(state, {
      proposalId: "journal-fact", correlationId: "turn-1", source: { kind: "dm", id: "dm" },
      expectedRevision: state.revision, observedTurn: state.turn,
      payload: { kind: "record_fact", text: "The journal remembers." },
    }, []);
    expect(settlement.accepted).toBe(true);
    expect(state.revision).toBe(1);

    const loaded = await loadState(state.worldId);
    expect(loaded?.revision).toBe(1);
    expect(loaded?.worldFacts.some((fact) => fact.text === "The journal remembers.")).toBe(true);
    expect(await readJournal(state.worldId)).toHaveLength(1);
  });

  test("recovers from a corrupt snapshot using initial state and journal", async () => {
    const state = await durableState();
    settleGmOperation(state, {
      proposalId: "recovery-fact", correlationId: "turn-1", source: { kind: "dm", id: "dm" },
      expectedRevision: state.revision, observedTurn: state.turn,
      payload: { kind: "record_fact", text: "Recovered fact." },
    }, []);
    await Bun.write(join(saveDir(state.worldId), "state.json"), "{broken");

    const loaded = await loadState(state.worldId);
    expect(loaded?.revision).toBe(1);
    expect(loaded?.worldFacts.some((fact) => fact.text === "Recovered fact.")).toBe(true);
  });

  test("recovers journal-staged outbox effects when the outbox append was lost", async () => {
    const state = await durableState();
    stageJournalOutbox(state, [{
      kind: "turn_record",
      worldId: state.worldId,
      record: {
        turn: 0, ts: 1, playerInput: "look", parsed: { verb: "look", args: {}, confidence: 1 },
        engineMutations: [], dmMutations: [], narration: "Recovered projection.", dmModel: "test",
      },
    }]);
    settleGmOperation(state, {
      proposalId: "outbox-fact", correlationId: "turn-1", source: { kind: "dm", id: "dm" },
      expectedRevision: state.revision, observedTurn: state.turn,
      payload: { kind: "record_fact", text: "Outbox anchor." },
    }, []);
    await Bun.write(join(saveDir(state.worldId), "outbox.jsonl"), "");

    await loadState(state.worldId);
    const turns = await loadTurns(state.worldId);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.narration).toBe("Recovered projection.");
  });

  test("rejects checksum corruption but ignores a partial final line", async () => {
    const state = await durableState();
    settleGmOperation(state, {
      proposalId: "checksum-fact", correlationId: "turn-1", source: { kind: "dm", id: "dm" },
      expectedRevision: state.revision, observedTurn: state.turn,
      payload: { kind: "record_fact", text: "Checksummed fact." },
    }, []);
    const path = join(saveDir(state.worldId), "world-events.jsonl");
    await appendFile(path, "{partial");
    expect(await readJournal(state.worldId)).toHaveLength(1);

    const records = await readJournal(state.worldId);
    await Bun.write(path, JSON.stringify(records[0]) + "\n" + "THIS IS NOT JSON\n");
    expect(readJournal(state.worldId)).rejects.toThrow(/Corrupt journal JSON/);
    await Bun.write(path, JSON.stringify({ ...records[0], checksum: "bad" }) + "\n");
    expect(readJournal(state.worldId)).rejects.toThrow(/checksum mismatch/);
  });
});
