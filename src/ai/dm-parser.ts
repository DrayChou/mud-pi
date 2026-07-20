// ─────────────────────────────────────────────────────────────
// dm-parser.ts — parse raw DM response into DmMutation[]
// ─────────────────────────────────────────────────────────────

import type { GmTableProposal } from "../types/gm-proposals.ts";
import type { DmMutation } from "../types/mutations.ts";
import type {
  DataTrait,
  ItemDef,
  ItemEffect,
  ItemKind,
  NpcDef,
  ParameterModifier,
  PlotStatus,
  RoomDef,
  StatsSchema,
  StoryOutcomeDef,
} from "../types/world.ts";

export interface DmResponse {
  narration: string;
  mutations: DmMutation[];
  gmOperations: GmTableProposal[];
  raw: string;
}

function extractTag(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = text.match(re);
  return m ? (m[1] ?? "").trim() : null;
}

interface RawWorldUpdate {
  gmOperations?: unknown[];
  worldFacts?: Array<{ text: string; tile?: string | null }>;
  factsRemoved?: string[];
  plotThreads?: Array<{ id: string; title?: string; status?: string; summary?: string }>;
  roomsAdded?: Array<{ id: string; title: string; desc: string; exits?: Record<string, string>; tags?: string[] }>;
  exitsAdded?: Array<{ roomId: string; direction: string; toRoomId: string }>;
  roomDescUpdates?: Array<{ roomId: string; descAppend: string }>;
  itemsAdded?: Array<{
    id: string;
    name: string;
    desc: string;
    aliases?: string[];
    placement?: "room" | "inventory";
    roomId?: string;
    rewardTemplateId?: string;
    grantedByNpcId?: string;
    rewardObjectiveId?: string;
    portable?: boolean;
    kind?: ItemKind;
    equipSlot?: string;
    parameterModifiers?: ParameterModifier[];
    traits?: DataTrait[];
    effects?: ItemEffect[];
    consumable?: boolean;
  }>;
  npcsAdded?: Array<{ id: string; name: string; roomId: string; personality: string; stats?: Record<string, number>; hostile?: boolean }>;
  npcsMoved?: Array<{ id: string; toRoomId: string }>;
  npcsKilled?: string[];
  outcomeReached?: { id: string; reason?: string } | null;
}

export function parseDmResponse(
  raw: string,
  schema: StatsSchema,
  currentRoomId?: string,
  outcomes: StoryOutcomeDef[] = [],
  requestedAtTurn = 0,
  playerId = "player"
): DmResponse {
  const narration = extractTag(raw, "NARRATION") ?? raw.trim();
  const updateStr = extractTag(raw, "WORLD_UPDATE");
  const mutations: DmMutation[] = [];
  let gmOperations: GmTableProposal[] = [];

  if (updateStr) {
    try {
      const update = JSON.parse(updateStr) as RawWorldUpdate;
      gmOperations = parseGmOperations(update.gmOperations);
      buildMutations(
        update,
        mutations,
        schema,
        currentRoomId,
        outcomes,
        requestedAtTurn,
        playerId
      );
    } catch (e) {
      console.warn("[dm-parser] failed to parse WORLD_UPDATE:", e);
    }
  }

  return { narration, mutations, gmOperations, raw };
}

const gmOperationKinds = new Set<GmTableProposal["kind"]>([
  "record_fact", "remove_fact", "set_exit", "adjust_parameter", "move_npc",
  "transfer_card", "consume_card", "emit_signal", "complete_objective", "reach_outcome",
  "move_player", "create_item", "grant_item_reward", "pick_up_item", "drop_item", "equip_item", "consume_item",
]);

function parseGmOperations(value: unknown): GmTableProposal[] {
  if (!Array.isArray(value)) return [];
  return value.filter((operation): operation is GmTableProposal => {
    if (!operation || typeof operation !== "object") return false;
    return gmOperationKinds.has((operation as { kind?: GmTableProposal["kind"] }).kind as GmTableProposal["kind"]);
  }).slice(0, 16).map((operation) => structuredClone(operation));
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

function buildMutations(
  u: RawWorldUpdate,
  out: DmMutation[],
  schema: StatsSchema,
  currentRoomId?: string,
  outcomes: StoryOutcomeDef[] = [],
  requestedAtTurn = 0,
  playerId = "player"
): void {
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
    const room: RoomDef = {
      id: r.id,
      title: r.title,
      desc: r.desc,
      exits: r.exits ?? {},
      source: "dm_generated",
      tags: r.tags,
      discovered: false,
    };
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

  const parameterDefs = new Map(schema.defs.map((def) => [def.key, def]));
  const parameterIds = new Set(parameterDefs.keys());
  const proposedItemIds = new Set<string>();
  for (const i of (u.itemsAdded ?? []).slice(0, 8)) {
    const roomId = i.roomId || currentRoomId;
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(i.id ?? "") ||
      proposedItemIds.has(i.id) ||
      !i.name?.trim() ||
      !i.desc?.trim()
    ) continue;
    proposedItemIds.add(i.id);

    if (i.placement === "inventory") {
      if (!i.rewardTemplateId?.trim()) continue;
      out.push({
        kind: "dm/item_reward_granted",
        grantorNpcId: i.grantedByNpcId?.trim() || undefined,
        templateId: i.rewardTemplateId.trim().slice(0, 64),
        itemId: i.id,
        name: i.name.trim().slice(0, 80),
        desc: i.desc.trim().slice(0, 600),
        aliases: Array.isArray(i.aliases)
          ? i.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
            .slice(0, 12).map((alias) => alias.trim().slice(0, 80))
          : undefined,
        objectiveId: i.rewardObjectiveId?.trim().slice(0, 64) || undefined,
        requestedAtTurn,
      });
      continue;
    }

    const kind: ItemKind = ["item", "equipment", "key", "scenery"].includes(i.kind ?? "")
      ? i.kind!
      : "item";
    const parameterModifiers = (i.parameterModifiers ?? []).filter((modifier) =>
      parameterIds.has(modifier.parameterId) &&
      (modifier.operation === "add" || modifier.operation === "rate") &&
      Number.isFinite(modifier.value) &&
      (modifier.operation === "add"
        ? Math.abs(modifier.value) <= (parameterDefs.get(modifier.parameterId)!.max - parameterDefs.get(modifier.parameterId)!.min)
        : modifier.value > 0 && modifier.value <= 4)
    ).slice(0, 16);
    const traits = (i.traits ?? []).filter((trait) =>
      typeof trait.code === "string" && trait.code.trim().length > 0 &&
      Number.isFinite(trait.value) && Math.abs(trait.value) <= 100
    ).slice(0, 16);
    const effects = (i.effects ?? []).filter((effect) =>
      typeof effect.code === "string" && effect.code.trim().length > 0 &&
      (!effect.parameterId || parameterIds.has(effect.parameterId)) &&
      (effect.value === undefined || (
        Number.isFinite(effect.value) &&
        (!effect.parameterId || Math.abs(effect.value) <= 2 * (parameterDefs.get(effect.parameterId)!.max - parameterDefs.get(effect.parameterId)!.min))
      )) &&
      (effect.rate === undefined || (Number.isFinite(effect.rate) && effect.rate >= 0 && effect.rate <= 4)) &&
      (!effect.dice || (
        Number.isInteger(effect.dice.count) && effect.dice.count >= 1 && effect.dice.count <= 10 &&
        Number.isInteger(effect.dice.sides) && effect.dice.sides >= 2 && effect.dice.sides <= 100 &&
        (!effect.parameterId || effect.dice.count * effect.dice.sides <= 4 * (parameterDefs.get(effect.parameterId)!.max - parameterDefs.get(effect.parameterId)!.min))
      ))
    ).slice(0, 16);
    const normalizedKind = kind === "equipment" && !i.equipSlot?.trim() ? "item" : kind;
    if (!roomId) continue;
    const item: ItemDef = {
      id: i.id,
      name: i.name.trim().slice(0, 80),
      desc: i.desc.trim().slice(0, 600),
      aliases: Array.isArray(i.aliases)
        ? i.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
          .slice(0, 12).map((alias) => alias.trim().slice(0, 80))
        : undefined,
      kind: normalizedKind,
      equipSlot: normalizedKind === "equipment" ? i.equipSlot!.trim().slice(0, 40) : undefined,
      parameterModifiers,
      traits,
      effects,
      consumable: i.consumable === true,
      location: { kind: "room", roomId },
      portable: normalizedKind === "scenery" ? false : (i.portable ?? true),
      source: "dm_generated",
    };
    out.push({ kind: "dm/item_added", item });
  }

  for (const n of u.npcsAdded ?? []) {
    if (!n.id || !n.name || !n.roomId) continue;
    const { stats, maxStats } = buildDefaultStats(schema, n.stats);
    const npc: NpcDef = {
      id: n.id, name: n.name, roomId: n.roomId, alive: true,
      personality: n.personality ?? "", controller: "dm", source: "dm_generated",
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

  if (u.outcomeReached?.id) {
    const definition = outcomes.find((outcome) => outcome.id === u.outcomeReached!.id);
    if (!definition) {
      console.warn(`[dm-parser] DM proposed unknown outcome: ${u.outcomeReached.id}`);
    } else {
      out.push({
        kind: "dm/outcome_reached",
        outcome: {
          id: definition.id,
          type: definition.type,
          title: definition.title,
          summary: definition.summary,
          terminal: definition.terminal,
          reachedTurn: 0,
          reason: typeof u.outcomeReached.reason === "string" ? u.outcomeReached.reason : undefined,
        },
        requestedAtTurn,
      });
    }
  }
}
