// ─────────────────────────────────────────────────────────────
// apply.ts — the single entry point for all world state changes
// ─────────────────────────────────────────────────────────────

import type { WorldState, StatDef } from "../types/world.ts";
import type { AnyMutation, EngineMutation, DmMutation } from "../types/mutations.ts";

export function applyMutation(state: WorldState, mut: AnyMutation): void {
  if (mut.kind.startsWith("engine/")) applyEngine(state, mut as EngineMutation);
  else applyDm(state, mut as DmMutation);
}

export function applyMutations(state: WorldState, muts: AnyMutation[]): void {
  for (const m of muts) applyMutation(state, m);
}

// ── Stat helpers ───────────────────────────────────────────────────────────

function getStatDef(state: WorldState, key: string): StatDef | undefined {
  return state.schema.defs.find((d) => d.key === key);
}

function clampStat(state: WorldState, key: string, value: number): number {
  const def = getStatDef(state, key);
  const min = def?.min ?? 0;
  const max = def?.max ?? Infinity;
  return Math.max(min, Math.min(max, value));
}

// Check if any "death" or "incapacitate" pool stat hit 0
function checkDepletion(
  state: WorldState,
  stats: Record<string, number>,
  entityLabel: string
): void {
  for (const def of state.schema.defs) {
    if (def.role !== "pool") continue;
    if (def.onDeplete === "narrative") continue;
    const val = stats[def.key] ?? def.default;
    if (val <= 0) {
      console.log(
        `[apply] ${entityLabel} stat ${def.key} depleted (${def.onDeplete})`
      );
    }
  }
}

// ── Engine mutations ───────────────────────────────────────────────────────

function applyEngine(state: WorldState, mut: EngineMutation): void {
  const p = state.player;

  switch (mut.kind) {
    case "engine/player_moved": {
      if (!state.rooms[mut.toRoomId]) {
        console.warn(`[apply] room not found: ${mut.toRoomId}`);
        return;
      }
      p.roomId = mut.toRoomId;
      break;
    }

    case "engine/player_stat_changed": {
      const cur = p.stats[mut.stat] ?? 0;
      p.stats[mut.stat] = clampStat(state, mut.stat, cur + mut.delta);
      checkDepletion(state, p.stats, "player");
      break;
    }

    case "engine/npc_moved": {
      const npc = state.npcs[mut.npcId];
      if (!npc || !npc.alive || !state.rooms[mut.toRoomId]) return;
      npc.roomId = mut.toRoomId;
      break;
    }

    case "engine/npc_stat_changed": {
      const npc = state.npcs[mut.npcId];
      if (!npc) return;
      const cur = npc.stats[mut.stat] ?? 0;
      npc.stats[mut.stat] = clampStat(state, mut.stat, cur + mut.delta);
      break;
    }

    case "engine/npc_killed": {
      const npc = state.npcs[mut.npcId];
      if (npc) {
        npc.alive = false;
        // Zero out all pool stats
        for (const def of state.schema.defs) {
          if (def.role === "pool") npc.stats[def.key] = 0;
        }
      }
      break;
    }

    case "engine/combat_started": break; // informational only

    case "engine/item_picked_up": {
      const item = state.items[mut.itemId];
      if (!item || item.location.kind !== "room" || item.location.roomId !== p.roomId) {
        console.warn(`[apply] cannot pick up unavailable item: ${mut.itemId}`);
        return;
      }
      if (!p.inventory.includes(mut.itemId)) p.inventory.push(mut.itemId);
      item.location = { kind: "inventory", ownerId: p.id };
      break;
    }

    case "engine/item_dropped": {
      const item = state.items[mut.itemId];
      const owned = item &&
        (item.location.kind === "inventory" || item.location.kind === "equipped") &&
        item.location.ownerId === p.id;
      if (!owned || mut.roomId !== p.roomId || !state.rooms[mut.roomId]) {
        console.warn(`[apply] cannot drop unavailable item: ${mut.itemId}`);
        return;
      }
      p.inventory = p.inventory.filter((id) => id !== mut.itemId);
      for (const [slot, id] of Object.entries(p.equipment)) {
        if (id === mut.itemId) delete p.equipment[slot];
      }
      item.location = { kind: "room", roomId: mut.roomId };
      break;
    }

    case "engine/item_equipped": {
      const item = state.items[mut.itemId];
      if (
        !item ||
        !p.inventory.includes(mut.itemId) ||
        item.location.kind !== "inventory" ||
        item.location.ownerId !== p.id
      ) {
        console.warn(`[apply] cannot equip: ${mut.itemId} not in inventory`);
        return;
      }
      const previouslyEquipped = p.equipment[mut.slot];
      if (previouslyEquipped && previouslyEquipped !== mut.itemId) {
        const previousItem = state.items[previouslyEquipped];
        if (previousItem?.location.kind === "equipped") {
          previousItem.location = { kind: "inventory", ownerId: p.id };
        }
      }
      p.equipment[mut.slot] = mut.itemId;
      item.location = { kind: "equipped", ownerId: p.id, slot: mut.slot };
      break;
    }

    case "engine/objective_completed": {
      const objective = state.objectives[mut.objectiveId];
      if (!objective || objective.status === "completed") return;
      objective.status = "completed";
      objective.completedTurn = state.turn + 1;
      break;
    }

    case "engine/ending_reached": {
      if (state.ending) return;
      const ending = state.endingRules.find((rule) => rule.id === mut.endingId);
      if (!ending) return;
      state.ending = {
        id: ending.id,
        title: ending.title,
        summary: ending.summary,
        reachedTurn: state.turn + 1,
      };
      break;
    }

    case "engine/turn_advanced": {
      state.turn += 1;
      break;
    }
  }
}

// ── DM mutations ───────────────────────────────────────────────────────────

function applyDm(state: WorldState, mut: DmMutation): void {
  switch (mut.kind) {
    case "dm/room_added": {
      if (state.rooms[mut.room.id]) {
        console.warn(`[apply] dm tried to add existing room: ${mut.room.id}`);
        return;
      }
      state.rooms[mut.room.id] = { ...mut.room, source: "dm_generated", createdTurn: state.turn };
      break;
    }

    case "dm/item_added": {
      if (state.items[mut.item.id]) {
        console.warn(`[apply] dm tried to add existing item: ${mut.item.id}`);
        return;
      }
      if (mut.item.location.kind !== "room" || !state.rooms[mut.item.location.roomId]) {
        console.warn(`[apply] dm tried to add item at invalid location: ${mut.item.id}`);
        return;
      }
      state.items[mut.item.id] = {
        ...mut.item,
        portable: mut.item.portable ?? true,
        source: "dm_generated",
        createdTurn: state.turn,
      };
      break;
    }

    case "dm/room_exit_added": {
      const room = state.rooms[mut.roomId];
      if (!room) { console.warn(`[apply] room not found: ${mut.roomId}`); return; }
      room.exits[mut.direction] = mut.toRoomId;
      break;
    }

    case "dm/room_desc_updated": {
      const room = state.rooms[mut.roomId];
      if (room) room.desc = room.desc + "\n" + mut.descAppend;
      break;
    }

    case "dm/npc_added": {
      if (state.npcs[mut.npc.id]) {
        console.warn(`[apply] dm tried to add existing npc: ${mut.npc.id}`);
        return;
      }
      state.npcs[mut.npc.id] = { ...mut.npc, source: "dm_generated" };
      break;
    }

    case "dm/npc_moved": {
      const npc = state.npcs[mut.npcId];
      if (npc?.controller === "pi_session") {
        console.warn(`[apply] DM cannot move independently controlled NPC: ${mut.npcId}`);
        return;
      }
      if (npc) npc.roomId = mut.toRoomId;
      break;
    }

    case "dm/npc_killed": {
      const npc = state.npcs[mut.npcId];
      if (npc?.controller === "pi_session") {
        console.warn(`[apply] DM cannot kill independently controlled NPC: ${mut.npcId}`);
        return;
      }
      if (npc) {
        npc.alive = false;
        for (const def of state.schema.defs) {
          if (def.role === "pool") npc.stats[def.key] = 0;
        }
      }
      break;
    }

    case "dm/npc_stat_changed": {
      const npc = state.npcs[mut.npcId];
      if (npc?.controller === "pi_session") {
        console.warn(`[apply] DM cannot change independently controlled NPC stats: ${mut.npcId}`);
        return;
      }
      if (!npc) return;
      const cur = npc.stats[mut.stat] ?? 0;
      npc.stats[mut.stat] = clampStat(state, mut.stat, cur + mut.delta);
      break;
    }

    case "dm/fact_added": {
      if (!state.worldFacts.some((f) => f.text === mut.text)) {
        state.worldFacts.push({ text: mut.text, tile: mut.tile, createdTurn: state.turn });
      }
      break;
    }

    case "dm/fact_removed": {
      state.worldFacts = state.worldFacts.filter((f) => f.text !== mut.text);
      break;
    }

    case "dm/plot_updated": {
      const existing = state.plotThreads[mut.id];
      if (existing) {
        if (mut.title !== undefined) existing.title = mut.title;
        if (mut.status !== undefined) existing.status = mut.status;
        if (mut.summary !== undefined) existing.summary = mut.summary;
        existing.updatedTurn = state.turn;
      } else {
        state.plotThreads[mut.id] = {
          id: mut.id,
          title: mut.title ?? mut.id,
          status: mut.status ?? "active",
          summary: mut.summary ?? "",
          updatedTurn: state.turn,
        };
      }
      break;
    }
  }
}
