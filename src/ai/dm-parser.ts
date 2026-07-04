// ─────────────────────────────────────────────────────────────
// dm-parser.ts — parse raw DM response into DmMutation[]
// ─────────────────────────────────────────────────────────────

import type { DmMutation } from "../types/mutations.ts";
import type { RoomDef, NpcDef, PlotStatus, StatsSchema } from "../types/world.ts";

export interface DmResponse {
  narration: string;
  mutations: DmMutation[];
  raw: string;
}

function extractTag(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = text.match(re);
  return m ? (m[1] ?? "").trim() : null;
}

interface RawWorldUpdate {
  worldFacts?: Array<{ text: string; tile?: string | null }>;
  factsRemoved?: string[];
  plotThreads?: Array<{ id: string; title?: string; status?: string; summary?: string }>;
  roomsAdded?: Array<{ id: string; title: string; desc: string; exits?: Record<string, string>; tags?: string[] }>;
  exitsAdded?: Array<{ roomId: string; direction: string; toRoomId: string }>;
  roomDescUpdates?: Array<{ roomId: string; descAppend: string }>;
  npcsAdded?: Array<{ id: string; name: string; roomId: string; personality: string; stats?: Record<string, number>; hostile?: boolean }>;
  npcsMoved?: Array<{ id: string; toRoomId: string }>;
  npcsKilled?: string[];
}

export function parseDmResponse(raw: string, schema: StatsSchema): DmResponse {
  const narration = extractTag(raw, "NARRATION") ?? raw.trim();
  const updateStr = extractTag(raw, "WORLD_UPDATE");
  const mutations: DmMutation[] = [];

  if (updateStr) {
    try {
      buildMutations(JSON.parse(updateStr) as RawWorldUpdate, mutations, schema);
    } catch (e) {
      console.warn("[dm-parser] failed to parse WORLD_UPDATE:", e);
    }
  }

  return { narration, mutations, raw };
}

function buildDefaultStats(schema: StatsSchema, overrides?: Record<string, number>) {
  const stats: Record<string, number> = {};
  const maxStats: Record<string, number> = {};
  for (const def of schema.defs) {
    stats[def.key] = overrides?.[def.key] ?? def.default;
    maxStats[`${def.key}Max`] = overrides?.[`${def.key}Max`] ?? def.max;
  }
  return { stats, maxStats };
}

function buildMutations(u: RawWorldUpdate, out: DmMutation[], schema: StatsSchema): void {
  for (const f of u.worldFacts ?? []) {
    if (typeof f.text === "string" && f.text.trim())
      out.push({ kind: "dm/fact_added", text: f.text.trim(), tile: f.tile ?? null });
  }

  for (const text of u.factsRemoved ?? []) {
    if (typeof text === "string") out.push({ kind: "dm/fact_removed", text: text.trim() });
  }

  for (const p of u.plotThreads ?? []) {
    if (typeof p.id !== "string") continue;
    out.push({ kind: "dm/plot_updated", id: p.id, title: p.title, status: p.status as PlotStatus | undefined, summary: p.summary });
  }

  for (const r of u.roomsAdded ?? []) {
    if (!r.id || !r.title || !r.desc) continue;
    const room: RoomDef = { id: r.id, title: r.title, desc: r.desc, exits: r.exits ?? {}, source: "dm_generated", tags: r.tags };
    out.push({ kind: "dm/room_added", room });
  }

  for (const e of u.exitsAdded ?? []) {
    if (e.roomId && e.direction && e.toRoomId)
      out.push({ kind: "dm/room_exit_added", roomId: e.roomId, direction: e.direction, toRoomId: e.toRoomId });
  }

  for (const d of u.roomDescUpdates ?? []) {
    if (d.roomId && d.descAppend)
      out.push({ kind: "dm/room_desc_updated", roomId: d.roomId, descAppend: d.descAppend });
  }

  for (const n of u.npcsAdded ?? []) {
    if (!n.id || !n.name || !n.roomId) continue;
    const { stats, maxStats } = buildDefaultStats(schema, n.stats);
    const npc: NpcDef = {
      id: n.id, name: n.name, roomId: n.roomId, alive: true,
      personality: n.personality ?? "", source: "dm_generated",
      hostile: n.hostile ?? false, stats, maxStats,
    };
    out.push({ kind: "dm/npc_added", npc });
  }

  for (const m of u.npcsMoved ?? []) {
    if (m.id && m.toRoomId) out.push({ kind: "dm/npc_moved", npcId: m.id, toRoomId: m.toRoomId });
  }

  for (const id of u.npcsKilled ?? []) {
    if (typeof id === "string") out.push({ kind: "dm/npc_killed", npcId: id });
  }
}
