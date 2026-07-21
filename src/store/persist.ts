// ─────────────────────────────────────────────────────────────
// persist.ts — read/write state.json and turns.jsonl
// Every save/load goes through here.
// ─────────────────────────────────────────────────────────────

import { join } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import type {
  ConditionDefinition,
  ConflictRules,
  ItemLocation,
  ItemRewardRules,
  ObjectiveDef,
  ReachedOutcome,
  WorldState,
} from "../types/world.ts";
import type { TurnRecord } from "../types/mutations.ts";
import { enableJournal, initializeJournal, readJournal, replayJournal } from "./journal.ts";
import { drainPersistenceOutbox, initializeOutbox, recoverJournalOutbox } from "./outbox.ts";

function savesDir(worldId: string): string {
  return join(import.meta.dir, "../../saves", worldId);
}

function stateFile(worldId: string): string {
  return join(savesDir(worldId), "state.json");
}

function turnsFile(worldId: string): string {
  return join(savesDir(worldId), "turns.jsonl");
}

function initialStateFile(worldId: string): string {
  return join(savesDir(worldId), "initial-state.json");
}

// ── State ──────────────────────────────────────────────────────────────────

export async function loadState(worldId: string): Promise<WorldState | null> {
  const snapshot = Bun.file(stateFile(worldId));
  const initial = Bun.file(initialStateFile(worldId));
  if (!(await snapshot.exists()) && !(await initial.exists())) return null;

  let state: WorldState | null = null;
  if (await snapshot.exists()) {
    try {
      state = await snapshot.json() as WorldState;
    } catch {
      console.warn(`[persist] corrupt state.json for ${worldId}; attempting journal recovery`);
    }
  }
  if (!state && await initial.exists()) {
    try {
      state = await initial.json() as WorldState;
    } catch {
      throw new Error(`Both snapshot and initial state are corrupt for ${worldId}`);
    }
  }
  if (!state) throw new Error(`Snapshot is corrupt and no initial recovery state exists for ${worldId}`);

  await normalizeLoadedState(state);
  if (!(await initial.exists())) await Bun.write(initialStateFile(worldId), JSON.stringify(state, null, 2));
  const journal = await readJournal(worldId);
  const replayed = replayJournal(state, journal);
  enableJournal(state);
  await recoverJournalOutbox(worldId, journal);
  await drainPersistenceOutbox(worldId, state, {
    saveSnapshot: saveState,
    appendTurn: (record) => appendTurn(worldId, record),
  });
  if (replayed > 0) await saveState(state);
  return state;
}

async function normalizeLoadedState(state: WorldState): Promise<void> {
  normalizeRevision(state);
  normalizePlayerLifecycle(state);
  normalizeParameterSchema(state);
  await normalizeConflictRules(state);
  normalizeRoomDiscovery(state);
  await normalizeItemLocations(state);
  await normalizeProgressState(state);
}

function normalizeRevision(state: WorldState): void {
  if (!Number.isInteger(state.revision) || (state.revision ?? -1) < 0) state.revision = 0;
}

function normalizePlayerLifecycle(state: WorldState): void {
  if (!state.player.lifecycle) state.player.lifecycle = "active";
}

function normalizeParameterSchema(state: WorldState): void {
  for (const def of state.schema.defs) {
    const legacy = def as typeof def & { onDeplete?: string; role?: string };
    if (!def.thresholds && (legacy.onDeplete === "death" || legacy.onDeplete === "incapacitate")) {
      def.thresholds = [{
        operator: "lte",
        value: def.min,
        effect: {
          kind: "set_lifecycle",
          value: legacy.onDeplete === "death" ? "dead" : "incapacitated",
        },
      }];
    }
    delete legacy.onDeplete;
    delete legacy.role;
  }
}

async function normalizeConflictRules(state: WorldState): Promise<void> {
  const worldFile = Bun.file(join(import.meta.dir, "../../worlds", state.worldPack, "world.json"));
  const pack = await worldFile.exists()
    ? await worldFile.json() as {
        conflictRules?: ConflictRules;
        conflictScript?: string;
        conflictOptions?: Record<string, unknown>;
        itemRewardRules?: ItemRewardRules;
        conditions?: ConditionDefinition[];
      }
    : {};
  if (!state.conflictRules) {
    state.conflictRules = structuredClone(pack.conflictRules ?? {
      mode: "auto_combat",
      algorithm: "gauge-random-v1",
    });
  } else if (
    state.conflictRules.mode === "auto_combat" &&
    !state.conflictRules.parameters &&
    pack.conflictRules?.mode === "auto_combat"
  ) {
    state.conflictRules.parameters = structuredClone(pack.conflictRules.parameters);
  }
  state.conflictScript ??= pack.conflictScript;
  state.conflictOptions ??= structuredClone(pack.conflictOptions ?? {});
  state.itemRewardRules ??= structuredClone(pack.itemRewardRules ?? { templates: [] });
  state.conditionDefinitions ??= Object.fromEntries((pack.conditions ?? []).map((condition) => [condition.id, structuredClone(condition)]));
  state.conditions ??= {};
}

function normalizeRoomDiscovery(state: WorldState): void {
  for (const room of Object.values(state.rooms)) {
    if (typeof room.discovered !== "boolean") room.discovered = room.id === state.player.roomId;
  }
  const currentRoom = state.rooms[state.player.roomId];
  if (currentRoom) {
    currentRoom.discovered = true;
    currentRoom.visitedTurn ??= state.turn;
  }
}

async function normalizeItemLocations(state: WorldState): Promise<void> {
  const packLocations = new Map<string, ItemLocation>();
  const worldFile = Bun.file(join(import.meta.dir, "../../worlds", state.worldPack, "world.json"));
  if (await worldFile.exists()) {
    const pack = await worldFile.json() as {
      items?: Array<{ id: string; inRoom?: string; inInventory?: boolean }>;
    };
    for (const item of pack.items ?? []) {
      if (item.inRoom) packLocations.set(item.id, { kind: "room", roomId: item.inRoom });
      else if (item.inInventory) packLocations.set(item.id, { kind: "inventory", ownerId: state.player.id });
    }
  }

  const equippedSlots = new Map(
    Object.entries(state.player.equipment).map(([slot, itemId]) => [itemId, slot])
  );
  for (const item of Object.values(state.items)) {
    if (isItemLocation(item.location)) continue;
    const equippedSlot = equippedSlots.get(item.id);
    if (equippedSlot) {
      item.location = { kind: "equipped", ownerId: state.player.id, slot: equippedSlot };
    } else if (state.player.inventory.includes(item.id)) {
      item.location = { kind: "inventory", ownerId: state.player.id };
    } else {
      item.location = packLocations.get(item.id) ?? { kind: "destroyed" };
    }
  }
}

async function normalizeProgressState(state: WorldState): Promise<void> {
  const legacy = state as WorldState & {
    ending?: Omit<ReachedOutcome, "type" | "terminal">;
    endingRules?: unknown;
  };
  if (!state.outcome && legacy.ending) {
    state.outcome = {
      ...legacy.ending,
      type: "custom",
      terminal: true,
    };
  }
  delete legacy.ending;
  delete legacy.endingRules;

  if (state.objectives) return;
  const worldFile = Bun.file(join(import.meta.dir, "../../worlds", state.worldPack, "world.json"));
  const pack = await worldFile.exists()
    ? await worldFile.json() as { objectives?: ObjectiveDef[] }
    : {};
  state.objectives = Object.fromEntries(
    (pack.objectives ?? []).map((objective) => [
      objective.id,
      { ...structuredClone(objective), status: "active" as const },
    ])
  );
}

function isItemLocation(value: unknown): value is ItemLocation {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "room" || kind === "inventory" || kind === "equipped" || kind === "destroyed";
}

export async function saveState(state: WorldState): Promise<void> {
  state.revision ??= 0;
  const dir = savesDir(state.worldId);
  await mkdir(dir, { recursive: true });
  const target = stateFile(state.worldId);
  const temporary = `${target}.tmp-${crypto.randomUUID()}`;
  await Bun.write(temporary, JSON.stringify(state, null, 2));
  await rename(temporary, target);
}

// ── Turns (append-only) ────────────────────────────────────────────────────

export async function appendTurn(worldId: string, record: TurnRecord): Promise<void> {
  const dir = savesDir(worldId);
  await mkdir(dir, { recursive: true });
  if (record.outboxEffectId) {
    const existing = await loadTurns(worldId);
    if (existing.some((candidate) => candidate.outboxEffectId === record.outboxEffectId)) return;
  }
  appendFileSync(turnsFile(worldId), JSON.stringify(record) + "\n", { flush: true });
}

export async function loadTurns(worldId: string): Promise<TurnRecord[]> {
  const f = Bun.file(turnsFile(worldId));
  if (!(await f.exists())) return [];
  const text = await f.text();
  const records: TurnRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as TurnRecord);
    } catch {
      console.warn(`[persist] skipping corrupt turns line: ${trimmed.slice(0, 80)}`);
    }
  }
  return records;
}

// ── New save from world pack ───────────────────────────────────────────────

export async function initSave(state: WorldState): Promise<void> {
  const snapshot = Bun.file(stateFile(state.worldId));
  const initial = Bun.file(initialStateFile(state.worldId));
  if (await snapshot.exists() || await initial.exists()) throw new Error(`Save already exists: ${state.worldId}`);
  const dir = savesDir(state.worldId);
  await mkdir(dir, { recursive: true });
  await Bun.write(initialStateFile(state.worldId), JSON.stringify(state, null, 2));
  await initializeJournal(state.worldId);
  await initializeOutbox(state.worldId);
  await saveState(state);
  enableJournal(state);
}
