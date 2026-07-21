import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProposalSource } from "../types/proposals.ts";
import type { WorldEvent } from "../types/world-events.ts";
import type { WorldState } from "../types/world.ts";
import { evolve } from "./evolve.ts";
import type { OutboxEffect } from "./outbox.ts";

export interface JournalTransaction {
  schemaVersion: 1;
  transactionId: string;
  revisionBefore: number;
  revisionAfter: number;
  turn: number;
  source: ProposalSource;
  correlationId: string;
  causationId?: string;
  events: WorldEvent[];
  outbox?: Array<{ effectId: string; effect: OutboxEffect }>;
  checksum: string;
}

const durableStates = new WeakSet<WorldState>();
const stagedOutbox = new WeakMap<WorldState, Array<{ effectId: string; effect: OutboxEffect }>>();

function journalPath(worldId: string): string {
  return join(import.meta.dir, "../../saves", worldId, "world-events.jsonl");
}

export function enableJournal(state: WorldState): void {
  durableStates.add(state);
}

export function journalEnabled(state: WorldState): boolean {
  return durableStates.has(state);
}

export function stageJournalOutbox(state: WorldState, effects: OutboxEffect[]): string[] {
  const staged = effects.map((effect) => ({ effectId: `effect-${crypto.randomUUID()}`, effect: structuredClone(effect) }));
  stagedOutbox.set(state, staged);
  return staged.map((entry) => entry.effectId);
}

export function clearStagedJournalOutbox(state: WorldState): void {
  stagedOutbox.delete(state);
}

function checksumPayload(transaction: Omit<JournalTransaction, "checksum">): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(transaction));
  return hasher.digest("hex");
}

export function appendJournalTransaction(
  state: WorldState,
  transaction: Omit<JournalTransaction, "schemaVersion" | "checksum">,
): JournalTransaction {
  const outbox = stagedOutbox.get(state);
  const unsigned = {
    schemaVersion: 1 as const,
    ...structuredClone(transaction),
    ...(outbox?.length ? { outbox: structuredClone(outbox) } : {}),
  };
  const record: JournalTransaction = { ...unsigned, checksum: checksumPayload(unsigned) };
  const dir = join(import.meta.dir, "../../saves", state.worldId);
  appendFileSync(journalPath(state.worldId), JSON.stringify(record) + "\n", { flush: true });
  stagedOutbox.delete(state);
  return record;
}

export async function initializeJournal(worldId: string): Promise<void> {
  const dir = join(import.meta.dir, "../../saves", worldId);
  await mkdir(dir, { recursive: true });
  await Bun.write(journalPath(worldId), "");
}

export async function readJournal(worldId: string): Promise<JournalTransaction[]> {
  const file = Bun.file(journalPath(worldId));
  if (!(await file.exists())) return [];
  const text = await file.text();
  const lines = text.split("\n");
  const records: JournalTransaction[] = [];
  const transactionIds = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index]!.trim();
    if (!trimmed) continue;
    let record: JournalTransaction;
    try {
      record = JSON.parse(trimmed) as JournalTransaction;
    } catch {
      const hasLaterContent = lines.slice(index + 1).some((line) => line.trim().length > 0);
      if (!hasLaterContent) break;
      throw new Error(`Corrupt journal JSON at line ${index + 1}`);
    }
    const { checksum, ...unsigned } = record;
    if (
      record.schemaVersion !== 1
      || !record.transactionId?.trim()
      || !Number.isInteger(record.revisionBefore)
      || record.revisionBefore < 0
      || record.revisionAfter !== record.revisionBefore + 1
      || !Array.isArray(record.events)
      || record.events.length === 0
      || checksum !== checksumPayload(unsigned)
    ) {
      throw new Error(`Journal checksum mismatch at line ${index + 1}`);
    }
    if (transactionIds.has(record.transactionId)) throw new Error(`Duplicate journal transaction: ${record.transactionId}`);
    transactionIds.add(record.transactionId);
    records.push(record);
  }
  return records;
}

export function replayJournal(state: WorldState, records: readonly JournalTransaction[]): number {
  let applied = 0;
  for (const record of records) {
    if (record.revisionAfter <= state.revision) continue;
    if (record.revisionBefore !== state.revision || record.revisionAfter !== record.revisionBefore + 1) {
      throw new Error(`Journal revision gap at ${record.transactionId}: state=${state.revision}, record=${record.revisionBefore}->${record.revisionAfter}`);
    }
    const draft = structuredClone(state);
    for (const event of record.events) evolve(draft, event);
    draft.revision = record.revisionAfter;
    const replacement = structuredClone(draft);
    for (const key of Object.keys(state) as Array<keyof WorldState>) delete state[key];
    Object.assign(state, replacement);
    applied += 1;
  }
  return applied;
}
