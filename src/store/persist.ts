// ─────────────────────────────────────────────────────────────
// persist.ts — read/write state.json and turns.jsonl
// Every save/load goes through here.
// ─────────────────────────────────────────────────────────────

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import type { ItemLocation, WorldState } from "../types/world.ts";
import type { TurnRecord } from "../types/mutations.ts";

function savesDir(worldId: string): string {
  return join(import.meta.dir, "../../saves", worldId);
}

function stateFile(worldId: string): string {
  return join(savesDir(worldId), "state.json");
}

function turnsFile(worldId: string): string {
  return join(savesDir(worldId), "turns.jsonl");
}

// ── State ──────────────────────────────────────────────────────────────────

export async function loadState(worldId: string): Promise<WorldState | null> {
  const f = Bun.file(stateFile(worldId));
  if (!(await f.exists())) return null;
  try {
    const state = await f.json() as WorldState;
    await normalizeItemLocations(state);
    return state;
  } catch {
    console.error(`[persist] corrupt state.json for ${worldId}`);
    return null;
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

function isItemLocation(value: unknown): value is ItemLocation {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "room" || kind === "inventory" || kind === "equipped" || kind === "destroyed";
}

export async function saveState(state: WorldState): Promise<void> {
  const dir = savesDir(state.worldId);
  await mkdir(dir, { recursive: true });
  await Bun.write(stateFile(state.worldId), JSON.stringify(state, null, 2));
}

// ── Turns (append-only) ────────────────────────────────────────────────────

export async function appendTurn(worldId: string, record: TurnRecord): Promise<void> {
  const dir = savesDir(worldId);
  await mkdir(dir, { recursive: true });
  // appendFileSync keeps this atomic per-line — no partial writes mid-record
  appendFileSync(turnsFile(worldId), JSON.stringify(record) + "\n");
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
  const existing = await loadState(state.worldId);
  if (existing) throw new Error(`Save already exists: ${state.worldId}`);
  await saveState(state);
}
