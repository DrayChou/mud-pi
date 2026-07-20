// ─────────────────────────────────────────────────────────────
// world-loader.ts — load a world pack into initial WorldState
// ─────────────────────────────────────────────────────────────

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ItemDef,
  NpcController,
  NpcDef,
  NpcPersona,
  NpcStoryRole,
  ObjectiveDef,
  ObjectiveState,
  ProtagonistProfile,
  RoomDef,
  Stats,
  StatsSchema,
  StoryOutcomeDef,
  WorldState,
} from "../types/world.ts";
import { validateWorldPack } from "./world-validator.ts";
import {
  generateProceduralMap,
  type ProceduralMapConfig,
} from "./procedural-map.ts";

interface WorldPackNpc {
  id: string;
  name: string;
  roomId: string;
  personality: string;
  hostile?: boolean;
  controller?: NpcController;
  persona?: NpcPersona;
  storyRole?: NpcStoryRole;
  stats?: Record<string, number>;
}

interface WorldPackJson {
  name: string;
  bornPoint: string;
  schema: StatsSchema;
  playerStats?: Record<string, number>; // overrides schema defaults
  defaultProtagonistId?: string;
  protagonists?: ProtagonistProfile[];
  rooms: Array<{ id: string; title: string; desc: string; exits: Record<string, string>; tags?: string[] }>;
  npcs: WorldPackNpc[];
  items: Array<{ id: string; name: string; desc: string; inRoom?: string; inInventory?: boolean }>;
  objectives?: ObjectiveDef[];
  outcomes?: StoryOutcomeDef[];
  proceduralMap?: ProceduralMapConfig;
}

export interface WorldPackSummary {
  id: string;
  name: string;
  bornPoint: string;
  defaultProtagonistId: string | undefined;
  protagonists: ProtagonistProfile[];
}

export interface LoadWorldPackOptions {
  playerName?: string;
  fallbackPlayerName: string;
  protagonistId?: string;
  protagonistProfile?: ProtagonistProfile;
  seed?: string;
}

async function readWorldPack(packName: string): Promise<WorldPackJson> {
  const packDir = join(import.meta.dir, "../../worlds", packName);
  const f = Bun.file(join(packDir, "world.json"));
  if (!(await f.exists())) throw new Error(`World pack not found: worlds/${packName}/world.json`);
  const pack = (await f.json()) as WorldPackJson;
  validateWorldPack(pack, packName);
  return pack;
}

export async function listWorldPacks(): Promise<WorldPackSummary[]> {
  const worldsDir = join(import.meta.dir, "../../worlds");
  const entries = await readdir(worldsDir, { withFileTypes: true });
  const summaries: WorldPackSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worldFile = Bun.file(join(worldsDir, entry.name, "world.json"));
    if (!(await worldFile.exists())) continue;
    summaries.push(await loadWorldPackSummary(entry.name));
  }

  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadStoryOutcomes(packName: string): Promise<StoryOutcomeDef[]> {
  const pack = await readWorldPack(packName);
  return structuredClone(pack.outcomes ?? []);
}

export async function loadWorldPackSummary(packName: string): Promise<WorldPackSummary> {
  const pack = await readWorldPack(packName);
  return {
    id: packName,
    name: pack.name,
    bornPoint: pack.bornPoint,
    defaultProtagonistId: pack.defaultProtagonistId,
    protagonists: pack.protagonists ?? [],
  };
}

export async function loadWorldPack(
  packName: string,
  options: LoadWorldPackOptions
): Promise<WorldState> {
  const pack = await readWorldPack(packName);
  const schema: StatsSchema = pack.schema;
  const protagonist = options.protagonistProfile ?? resolveProtagonist(pack, options.protagonistId);
  const playerName = options.playerName?.trim() || protagonist?.name || options.fallbackPlayerName;

  // Build default stats from schema
  function buildDefaultStats(...overrides: Array<Record<string, number> | undefined>): Stats {
    const s: Stats = {};
    for (const def of schema.defs) {
      s[def.key] = firstNumber(overrides, def.key) ?? def.default;
    }
    return s;
  }
  function buildMaxStats(...overrides: Array<Record<string, number> | undefined>): Stats {
    const s: Stats = {};
    for (const def of schema.defs) {
      s[`${def.key}Max`] = firstNumber(overrides, `${def.key}Max`) ?? def.max;
    }
    return s;
  }

  const rooms: Record<string, RoomDef> = {};
  for (const r of pack.rooms) {
    rooms[r.id] = {
      ...r,
      source: "static",
      discovered: r.id === pack.bornPoint,
      visitedTurn: r.id === pack.bornPoint ? 0 : undefined,
    };
  }

  const generated = pack.proceduralMap
    ? generateProceduralMap({
        seed: options.seed?.trim() || `${packName}-${Date.now().toString(36)}`,
        config: pack.proceduralMap,
        staticRooms: rooms,
      })
    : undefined;
  const finalRooms = generated?.rooms ?? rooms;

  const npcs: Record<string, NpcDef> = {};
  for (const n of pack.npcs) {
    npcs[n.id] = {
      id: n.id,
      name: n.name,
      roomId: n.roomId,
      alive: true,
      personality: n.personality,
      controller: n.controller ?? "dm",
      persona: n.persona,
      storyRole: n.storyRole,
      source: "static",
      hostile: n.hostile ?? false,
      stats: buildDefaultStats(n.stats),
      maxStats: buildMaxStats(n.stats),
    };
  }

  const items: Record<string, ItemDef> = {};
  const startingInventory = new Set<string>();
  for (const i of pack.items) {
    if (i.inInventory) startingInventory.add(i.id);
    items[i.id] = {
      id: i.id,
      name: i.name,
      desc: i.desc,
      location: i.inRoom
        ? { kind: "room", roomId: i.inRoom }
        : i.inInventory
          ? { kind: "inventory", ownerId: "player1" }
          : { kind: "destroyed" },
      portable: true,
      source: "static",
    };
  }
  if (protagonist) {
    for (const itemId of protagonist.initialInventory ?? []) {
      startingInventory.add(itemId);
    }
  }
  // A selected protagonist's inventory takes precedence over static room placement.
  for (const itemId of startingInventory) {
    const item = items[itemId];
    if (item) item.location = { kind: "inventory", ownerId: "player1" };
  }

  const objectives: Record<string, ObjectiveState> = {};
  for (const objective of pack.objectives ?? []) {
    objectives[objective.id] = { ...structuredClone(objective), status: "active" };
  }

  return {
    worldId: `${packName}-${Date.now()}`,
    worldPack: packName,
    turn: 0,
    schema,
    player: {
      id: "player1",
      name: playerName,
      roomId: pack.bornPoint,
      lifecycle: "active",
      stats: buildDefaultStats(pack.playerStats, protagonist?.initialStats),
      maxStats: buildMaxStats(pack.playerStats, protagonist?.initialStats),
      profile: protagonist ? structuredClone(protagonist) : undefined,
      inventory: [...startingInventory],
      equipment: {},
    },
    rooms: finalRooms,
    npcs,
    items,
    plotThreads: {},
    worldFacts: [],
    objectives,
    generation: generated?.generation,
  };
}

function resolveProtagonist(
  pack: WorldPackJson,
  explicitId: string | undefined
): ProtagonistProfile | undefined {
  const protagonists = pack.protagonists ?? [];
  if (protagonists.length === 0) {
    if (explicitId) throw new Error(`World pack has no protagonists: ${explicitId}`);
    return undefined;
  }

  const id = explicitId || pack.defaultProtagonistId || protagonists[0]?.id;
  const protagonist = protagonists.find((p) => p.id === id);
  if (!protagonist) {
    const available = protagonists.map((p) => p.id).join(", ");
    throw new Error(`Protagonist not found: ${id}. Available: ${available}`);
  }
  return protagonist;
}

function firstNumber(overrides: Array<Record<string, number> | undefined>, key: string): number | undefined {
  for (let i = overrides.length - 1; i >= 0; i--) {
    const value = overrides[i]?.[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}
