// ─────────────────────────────────────────────────────────────
// world-loader.ts — load a world pack into initial WorldState
// ─────────────────────────────────────────────────────────────

import { join } from "node:path";
import type { WorldState, NpcDef, RoomDef, ItemDef, StatsSchema, Stats } from "../types/world.ts";

interface WorldPackNpc {
  id: string;
  name: string;
  roomId: string;
  personality: string;
  hostile?: boolean;
  stats?: Record<string, number>;
}

interface WorldPackJson {
  name: string;
  bornPoint: string;
  schema: StatsSchema;
  playerStats?: Record<string, number>; // overrides schema defaults
  rooms: Array<{ id: string; title: string; desc: string; exits: Record<string, string>; tags?: string[] }>;
  npcs: WorldPackNpc[];
  items: Array<{ id: string; name: string; desc: string; inRoom?: string; inInventory?: boolean }>;
}

export async function loadWorldPack(packName: string, playerName: string): Promise<WorldState> {
  const packDir = join(import.meta.dir, "../../worlds", packName);
  const f = Bun.file(join(packDir, "world.json"));
  if (!(await f.exists())) throw new Error(`World pack not found: worlds/${packName}/world.json`);

  const pack = (await f.json()) as WorldPackJson;
  const schema: StatsSchema = pack.schema;

  // Build default stats from schema
  function buildDefaultStats(overrides?: Record<string, number>): Stats {
    const s: Stats = {};
    for (const def of schema.defs) s[def.key] = overrides?.[def.key] ?? def.default;
    return s;
  }
  function buildMaxStats(overrides?: Record<string, number>): Stats {
    const s: Stats = {};
    for (const def of schema.defs) s[`${def.key}Max`] = overrides?.[`${def.key}Max`] ?? def.max;
    return s;
  }

  const rooms: Record<string, RoomDef> = {};
  for (const r of pack.rooms) rooms[r.id] = { ...r, source: "static" };

  const npcs: Record<string, NpcDef> = {};
  for (const n of pack.npcs) {
    npcs[n.id] = {
      id: n.id,
      name: n.name,
      roomId: n.roomId,
      alive: true,
      personality: n.personality,
      source: "static",
      hostile: n.hostile ?? false,
      stats: buildDefaultStats(n.stats),
      maxStats: buildMaxStats(n.stats),
    };
  }

  const items: Record<string, ItemDef> = {};
  const startingInventory: string[] = [];
  for (const i of pack.items) {
    items[i.id] = { id: i.id, name: i.name, desc: i.desc };
    if (i.inInventory) startingInventory.push(i.id);
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
      stats: buildDefaultStats(pack.playerStats),
      maxStats: buildMaxStats(pack.playerStats),
      inventory: startingInventory,
      equipment: {},
    },
    rooms,
    npcs,
    items,
    plotThreads: {},
    worldFacts: [],
  };
}
