import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { GameEvent } from "../types/events.ts";
import type { TurnRecord } from "../types/mutations.ts";
import type { WorldState } from "../types/world.ts";
import type { JournalTransaction } from "./journal.ts";

export type OutboxEffect =
  | { kind: "snapshot"; worldId: string; revision: number }
  | { kind: "turn_record"; worldId: string; record: TurnRecord }
  | { kind: "npc_perception"; worldId: string; events: GameEvent[]; maxWakeups: number; correlationId: string; phase: "pre_dm" | "post_dm" | "recovery" };

export interface PendingRecord {
  kind: "pending";
  effectId: string;
  createdAt: number;
  effect: OutboxEffect;
}

interface CompletedRecord {
  kind: "completed";
  effectId: string;
  completedAt: number;
}

type OutboxRecord = PendingRecord | CompletedRecord;

function outboxPath(worldId: string): string {
  return join(import.meta.dir, "../../saves", worldId, "outbox.jsonl");
}

export async function initializeOutbox(worldId: string): Promise<void> {
  const dir = join(import.meta.dir, "../../saves", worldId);
  await mkdir(dir, { recursive: true });
  await Bun.write(outboxPath(worldId), "");
}

export function enqueueOutbox(worldId: string, effect: OutboxEffect, effectId = `effect-${crypto.randomUUID()}`): string {
  const record: PendingRecord = { kind: "pending", effectId, createdAt: Date.now(), effect: structuredClone(effect) };
  appendFileSync(outboxPath(worldId), JSON.stringify(record) + "\n", { flush: true });
  return effectId;
}

export function completeOutbox(worldId: string, effectId: string): void {
  const record: CompletedRecord = { kind: "completed", effectId, completedAt: Date.now() };
  appendFileSync(outboxPath(worldId), JSON.stringify(record) + "\n", { flush: true });
}

export async function recoverJournalOutbox(worldId: string, transactions: readonly JournalTransaction[]): Promise<number> {
  const existing = new Set((await pendingOutbox(worldId)).map((record) => record.effectId));
  const completed = await completedEffectIds(worldId);
  let recovered = 0;
  for (const transaction of transactions) {
    for (const pending of transaction.outbox ?? []) {
      if (existing.has(pending.effectId) || completed.has(pending.effectId)) continue;
      enqueueOutbox(worldId, pending.effect, pending.effectId);
      existing.add(pending.effectId);
      recovered += 1;
    }
  }
  return recovered;
}

async function completedEffectIds(worldId: string): Promise<Set<string>> {
  const file = Bun.file(outboxPath(worldId));
  if (!(await file.exists())) return new Set();
  const completed = new Set<string>();
  for (const line of (await file.text()).split("\n")) {
    try {
      const record = JSON.parse(line) as OutboxRecord;
      if (record.kind === "completed") completed.add(record.effectId);
    } catch {}
  }
  return completed;
}

export async function pendingOutbox(worldId: string): Promise<PendingRecord[]> {
  const file = Bun.file(outboxPath(worldId));
  if (!(await file.exists())) return [];
  const lines = (await file.text()).split("\n");
  const pending = new Map<string, PendingRecord>();
  const completed = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index]!.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as OutboxRecord;
      if (record.kind === "pending" && !completed.has(record.effectId)) pending.set(record.effectId, record);
      if (record.kind === "completed") {
        completed.add(record.effectId);
        pending.delete(record.effectId);
      }
    } catch {
      const hasLaterContent = lines.slice(index + 1).some((line) => line.trim().length > 0);
      if (!hasLaterContent) break;
      throw new Error(`Corrupt outbox JSON at line ${index + 1}`);
    }
  }
  return [...pending.values()];
}

export async function drainPersistenceOutbox(
  worldId: string,
  currentState: WorldState,
  handlers: {
    saveSnapshot(state: WorldState): Promise<void>;
    appendTurn(record: TurnRecord): Promise<void>;
  },
): Promise<number> {
  const pending = await pendingOutbox(worldId);
  let completed = 0;
  for (const record of pending) {
    if (record.effect.worldId !== worldId) throw new Error(`Outbox world mismatch: ${record.effect.worldId} != ${worldId}`);
    if (record.effect.kind === "snapshot") {
      await handlers.saveSnapshot(currentState);
    } else if (record.effect.kind === "turn_record") {
      await handlers.appendTurn({ ...record.effect.record, outboxEffectId: record.effectId });
    } else {
      continue;
    }
    completeOutbox(worldId, record.effectId);
    completed += 1;
  }
  return completed;
}
