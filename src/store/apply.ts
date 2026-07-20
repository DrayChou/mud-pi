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

function updatePlayerLifecycleFromThresholds(state: WorldState): void {
  const matched = state.schema.defs.flatMap((def) => {
    const value = state.player.stats[def.key] ?? def.default;
    return (def.thresholds ?? []).filter((threshold) =>
      threshold.operator === "lte" ? value <= threshold.value : value >= threshold.value
    );
  });
  if (matched.some((threshold) => threshold.effect.value === "dead")) {
    state.player.lifecycle = "dead";
  } else if (matched.some((threshold) => threshold.effect.value === "incapacitated")) {
    if (state.player.lifecycle !== "dead") state.player.lifecycle = "incapacitated";
  } else if (state.player.lifecycle === "incapacitated") {
    state.player.lifecycle = "active";
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
      state.rooms[mut.toRoomId]!.discovered = true;
      state.rooms[mut.toRoomId]!.visitedTurn ??= state.turn + 1;
      break;
    }

    case "engine/player_stat_changed": {
      const cur = p.stats[mut.stat] ?? 0;
      p.stats[mut.stat] = clampStat(state, mut.stat, cur + mut.delta);
      updatePlayerLifecycleFromThresholds(state);
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
      }
      break;
    }

    case "engine/combat_started": break; // simulation boundary marker

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

    case "engine/item_consumed": {
      const item = state.items[mut.itemId];
      if (!item || !p.inventory.includes(mut.itemId)) return;
      p.inventory = p.inventory.filter((id) => id !== mut.itemId);
      item.location = { kind: "destroyed" };
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
      state.rooms[mut.room.id] = {
        ...mut.room,
        source: "dm_generated",
        createdTurn: state.turn,
        discovered: mut.room.discovered ?? false,
      };
      break;
    }

    case "dm/outcome_reached": {
      if (state.outcome) return;
      if (mut.requestedAtTurn !== state.turn) {
        console.warn(`[apply] stale story outcome proposal for turn ${mut.requestedAtTurn}; current turn is ${state.turn}`);
        return;
      }
      state.outcome = { ...mut.outcome, reachedTurn: state.turn + 1 };
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
      if (npc?.controller && npc.controller !== "dm") {
        console.warn(`[apply] DM cannot move independently controlled NPC: ${mut.npcId}`);
        return;
      }
      if (npc) npc.roomId = mut.toRoomId;
      break;
    }

    case "dm/npc_killed": {
      const npc = state.npcs[mut.npcId];
      if (npc?.controller && npc.controller !== "dm") {
        console.warn(`[apply] DM cannot kill independently controlled NPC: ${mut.npcId}`);
        return;
      }
      if (npc) npc.alive = false;
      break;
    }

    case "dm/npc_stat_changed": {
      const npc = state.npcs[mut.npcId];
      if (npc?.controller && npc.controller !== "dm") {
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
