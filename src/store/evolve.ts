import type { ItemLocation, WorldState } from "../types/world.ts";
import type { WorldEvent } from "../types/world-events.ts";

export class EventInvariantError extends Error {
  constructor(message: string, readonly event: WorldEvent) {
    super(message);
    this.name = "EventInvariantError";
  }
}

function invariant(condition: unknown, message: string, event: WorldEvent): asserts condition {
  if (!condition) throw new EventInvariantError(message, event);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlayerOwned(state: WorldState, location: ItemLocation): boolean {
  return (location.kind === "inventory" || location.kind === "equipped") && location.ownerId === state.player.id;
}

function removeEquipmentIndex(state: WorldState, itemId: string, location: ItemLocation, event: WorldEvent): void {
  if (location.kind !== "equipped") return;
  invariant(location.ownerId === state.player.id, `unsupported item owner: ${location.ownerId}`, event);
  invariant(state.player.equipment[location.slot] === itemId, `equipment slot ${location.slot} does not contain ${itemId}`, event);
  delete state.player.equipment[location.slot];
}

function addEquipmentIndex(state: WorldState, itemId: string, location: ItemLocation, event: WorldEvent): void {
  if (location.kind !== "equipped") return;
  invariant(location.ownerId === state.player.id, `unsupported item owner: ${location.ownerId}`, event);
  invariant(state.player.equipment[location.slot] === undefined, `equipment slot ${location.slot} is occupied`, event);
  state.player.equipment[location.slot] = itemId;
}

function transferOwnershipIndex(
  state: WorldState,
  itemId: string,
  from: ItemLocation | undefined,
  to: ItemLocation,
  event: WorldEvent,
): void {
  const wasOwned = from ? isPlayerOwned(state, from) : false;
  const isOwned = isPlayerOwned(state, to);
  if (wasOwned) invariant(state.player.inventory.includes(itemId), `inventory does not contain owned item ${itemId}`, event);
  if (wasOwned && !isOwned) state.player.inventory = state.player.inventory.filter((id) => id !== itemId);
  if (!wasOwned && isOwned) {
    invariant(!state.player.inventory.includes(itemId), `inventory already contains ${itemId}`, event);
    state.player.inventory.push(itemId);
  }
}

export function evolve(state: WorldState, event: WorldEvent): void {
  switch (event.kind) {
    case "player_moved":
      invariant(state.player.id === event.playerId, `player not found: ${event.playerId}`, event);
      invariant(state.player.roomId === event.fromRoomId, `player room mismatch: expected ${event.fromRoomId}, got ${state.player.roomId}`, event);
      invariant(Boolean(state.rooms[event.toRoomId]), `room not found: ${event.toRoomId}`, event);
      state.player.roomId = event.toRoomId;
      return;
    case "player_spoke":
    case "conflict_started":
    case "perceptible_signal_emitted":
      return;
    case "room_created":
      invariant(!state.rooms[event.room.id], `room already exists: ${event.room.id}`, event);
      state.rooms[event.room.id] = structuredClone(event.room);
      return;
    case "room_exit_set": {
      const room = state.rooms[event.roomId];
      invariant(room, `room not found: ${event.roomId}`, event);
      invariant(room.exits[event.direction] === event.beforeToRoomId, `room exit before mismatch: ${event.roomId}/${event.direction}`, event);
      room.exits[event.direction] = event.afterToRoomId;
      return;
    }
    case "room_description_changed": {
      const room = state.rooms[event.roomId];
      invariant(room, `room not found: ${event.roomId}`, event);
      invariant(room.desc === event.before, `room description before mismatch: ${event.roomId}`, event);
      room.desc = event.after;
      return;
    }
    case "room_exploration_recorded": {
      const room = state.rooms[event.roomId];
      invariant(room, `room not found: ${event.roomId}`, event);
      invariant(room.discovered === event.discoveredBefore && room.visitedTurn === event.visitedTurnBefore, `room exploration before mismatch: ${event.roomId}`, event);
      room.discovered = event.discoveredAfter;
      room.visitedTurn = event.visitedTurnAfter;
      return;
    }
    case "item_created":
      invariant(!state.items[event.item.id], `item already exists: ${event.item.id}`, event);
      transferOwnershipIndex(state, event.item.id, undefined, event.item.location, event);
      addEquipmentIndex(state, event.item.id, event.item.location, event);
      state.items[event.item.id] = structuredClone(event.item);
      return;
    case "item_transferred": {
      const item = state.items[event.itemId];
      invariant(item, `item not found: ${event.itemId}`, event);
      invariant(same(item.location, event.from), `item location before mismatch: ${event.itemId}`, event);
      removeEquipmentIndex(state, event.itemId, event.from, event);
      transferOwnershipIndex(state, event.itemId, event.from, event.to, event);
      addEquipmentIndex(state, event.itemId, event.to, event);
      item.location = structuredClone(event.to);
      return;
    }
    case "parameter_changed": {
      const stats = event.entityId === state.player.id ? state.player.stats : state.npcs[event.entityId]?.stats;
      invariant(stats, `entity not found: ${event.entityId}`, event);
      invariant(stats[event.parameterId] === event.before, `parameter before mismatch: ${event.entityId}/${event.parameterId}`, event);
      stats[event.parameterId] = event.after;
      return;
    }
    case "lifecycle_changed":
      invariant(event.entityId === state.player.id, `lifecycle entity not found: ${event.entityId}`, event);
      invariant(state.player.lifecycle === event.before, `lifecycle before mismatch: ${event.entityId}`, event);
      state.player.lifecycle = event.after;
      return;
    case "npc_created":
      invariant(!state.npcs[event.npc.id], `npc already exists: ${event.npc.id}`, event);
      state.npcs[event.npc.id] = structuredClone(event.npc);
      return;
    case "npc_moved": {
      const npc = state.npcs[event.npcId];
      invariant(npc, `npc not found: ${event.npcId}`, event);
      invariant(npc.roomId === event.fromRoomId, `npc room before mismatch: ${event.npcId}`, event);
      invariant(Boolean(state.rooms[event.toRoomId]), `room not found: ${event.toRoomId}`, event);
      npc.roomId = event.toRoomId;
      return;
    }
    case "npc_defeated": {
      const npc = state.npcs[event.npcId];
      invariant(npc, `npc not found: ${event.npcId}`, event);
      invariant(npc.alive && npc.roomId === event.roomId, `npc defeat invariant failed: ${event.npcId}`, event);
      npc.alive = false;
      return;
    }
    case "world_fact_added":
      invariant(!state.worldFacts.some((fact) => same(fact, event.fact)), "world fact already exists", event);
      state.worldFacts.push(structuredClone(event.fact));
      return;
    case "world_fact_removed": {
      const index = state.worldFacts.findIndex((fact) => same(fact, event.fact));
      invariant(index >= 0, "world fact not found", event);
      state.worldFacts.splice(index, 1);
      return;
    }
    case "plot_thread_changed":
      invariant(same(state.plotThreads[event.plotId], event.before), `plot thread before mismatch: ${event.plotId}`, event);
      state.plotThreads[event.plotId] = structuredClone(event.after);
      return;
    case "condition_applied": {
      const key = `${event.condition.targetEntityId}:${event.condition.conditionId}`;
      invariant(!state.conditions[key], `condition already applied: ${key}`, event);
      invariant(Boolean(state.conditionDefinitions[event.condition.conditionId]), `condition definition not found: ${event.condition.conditionId}`, event);
      invariant(event.condition.targetEntityId === state.player.id || Boolean(state.npcs[event.condition.targetEntityId]), `condition target not found: ${event.condition.targetEntityId}`, event);
      state.conditions[key] = structuredClone(event.condition);
      return;
    }
    case "condition_refreshed":
    case "condition_stack_changed":
      invariant(same(state.conditions[event.key], event.before), `condition before mismatch: ${event.key}`, event);
      state.conditions[event.key] = structuredClone(event.after);
      return;
    case "condition_removed":
    case "condition_expired":
      invariant(same(state.conditions[event.key], event.condition), `condition removal mismatch: ${event.key}`, event);
      delete state.conditions[event.key];
      return;
    case "objective_completed": {
      const objective = state.objectives[event.objectiveId];
      invariant(objective, `objective not found: ${event.objectiveId}`, event);
      invariant(objective.status !== "completed", `objective already completed: ${event.objectiveId}`, event);
      objective.status = "completed";
      objective.completedTurn = event.completedTurn;
      return;
    }
    case "story_outcome_reached":
      invariant(!state.outcome, "story outcome already reached", event);
      state.outcome = structuredClone(event.outcome);
      return;
    case "turn_advanced":
      invariant(state.turn === event.before, `turn before mismatch: expected ${event.before}, got ${state.turn}`, event);
      invariant(event.after === event.before + 1, "turn must advance exactly once", event);
      state.turn = event.after;
      return;
  }
}
