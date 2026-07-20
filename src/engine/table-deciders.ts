import type { Decider } from "./decide.ts";
import { decideItemRewardGrant } from "./item-rewards.ts";
import type { ItemProposal, MovementProposal } from "../types/table-proposals.ts";
import type { ItemDef, ItemLocation } from "../types/world.ts";
import type { WorldEvent } from "../types/world-events.ts";

function reject(code: "entity_not_found" | "duplicate_entity" | "invalid_location" | "precondition_failed" | "permission_denied", diagnostic: string) {
  return {
    accepted: false as const,
    rejection: {
      code,
      safeMessage: "That table operation could not be completed.",
      diagnostic,
      retryable: false,
    },
    events: [] as const,
    warnings: [] as const,
  };
}

export const decideMovement: Decider<MovementProposal, MovementProposal> = (state, envelope) => {
  const proposal = envelope.payload;
  if (envelope.source.kind !== "player" && envelope.source.kind !== "engine" && envelope.source.kind !== "dm") {
    return reject("permission_denied", `${envelope.source.kind} cannot move the player.`);
  }
  const fromRoom = state.rooms[state.player.roomId];
  if (!fromRoom) return reject("entity_not_found", `Player room not found: ${state.player.roomId}`);
  const destination = state.rooms[proposal.toRoomId];
  if (!destination) return reject("entity_not_found", `Destination room not found: ${proposal.toRoomId}`);
  if (!Object.values(fromRoom.exits).includes(proposal.toRoomId)) {
    return reject("invalid_location", `No exit from ${fromRoom.id} to ${proposal.toRoomId}`);
  }
  if (state.player.roomId === proposal.toRoomId) return reject("precondition_failed", "Player is already in the destination room.");

  const events: [WorldEvent, ...WorldEvent[]] = [{
    kind: "player_moved",
    playerId: state.player.id,
    fromRoomId: state.player.roomId,
    toRoomId: proposal.toRoomId,
  }];
  if (!destination.discovered || destination.visitedTurn === undefined) {
    events.push({
      kind: "room_exploration_recorded",
      roomId: destination.id,
      discoveredBefore: destination.discovered ?? false,
      discoveredAfter: true,
      visitedTurnBefore: destination.visitedTurn,
      visitedTurnAfter: destination.visitedTurn ?? state.turn + 1,
    });
  }
  return { accepted: true, result: proposal, events, warnings: [] };
};

function ownedByPlayer(location: ItemLocation, playerId: string): boolean {
  return (location.kind === "inventory" || location.kind === "equipped") && location.ownerId === playerId;
}

function normalizedCreatedItem(item: ItemDef, turn: number): ItemDef {
  return {
    ...structuredClone(item),
    portable: item.portable ?? true,
    source: item.source ?? "dm_generated",
    createdTurn: item.createdTurn ?? turn,
  };
}

export const decideItem: Decider<ItemProposal, ItemProposal> = (state, envelope) => {
  const proposal = envelope.payload;
  const player = state.player;
  const sourceKind = envelope.source.kind;
  const playerOperation = proposal.kind === "pick_up_item"
    || proposal.kind === "drop_item"
    || proposal.kind === "equip_item"
    || proposal.kind === "consume_item";
  if (proposal.kind === "create_item" && sourceKind !== "dm" && sourceKind !== "engine" && sourceKind !== "world_script") {
    return reject("permission_denied", `${sourceKind} cannot create item entities.`);
  }
  if (proposal.kind === "grant_item_reward" && sourceKind !== "dm" && sourceKind !== "engine" && sourceKind !== "npc") {
    return reject("permission_denied", `${sourceKind} cannot grant item rewards.`);
  }
  if (playerOperation && sourceKind !== "player" && sourceKind !== "engine" && sourceKind !== "dm" && sourceKind !== "world_script") {
    return reject("permission_denied", `${sourceKind} cannot perform player inventory operations.`);
  }

  switch (proposal.kind) {
    case "create_item": {
      if (state.items[proposal.item.id]) return reject("duplicate_entity", `Item already exists: ${proposal.item.id}`);
      const item = normalizedCreatedItem(proposal.item, state.turn);
      if (item.kind === "equipment" && !item.equipSlot) {
        return reject("precondition_failed", `Equipment requires an equip slot: ${item.id}`);
      }
      if (item.kind !== "equipment" && item.equipSlot) {
        return reject("precondition_failed", `Only equipment can declare an equip slot: ${item.id}`);
      }
      if (item.kind === "scenery" && (item.portable !== false || item.location.kind !== "room")) {
        return reject("precondition_failed", `Scenery must be non-portable and remain in a room: ${item.id}`);
      }
      const validRoom = item.location.kind === "room" && Boolean(state.rooms[item.location.roomId]);
      const validInventory = item.location.kind === "inventory" && item.location.ownerId === player.id;
      if (!validRoom && !validInventory) return reject("invalid_location", `Invalid item location: ${item.id}`);
      if (item.portable === false && item.location.kind !== "room") {
        return reject("permission_denied", `Non-portable item cannot be granted: ${item.id}`);
      }
      return { accepted: true, result: proposal, events: [{ kind: "item_created", item }], warnings: [] };
    }

    case "grant_item_reward": {
      const decision = decideItemRewardGrant(state as Parameters<typeof decideItemRewardGrant>[0], proposal.request);
      if (!decision.accepted) return reject("precondition_failed", decision.reason);
      return {
        accepted: true,
        result: proposal,
        events: [{ kind: "item_created", item: structuredClone(decision.item) }],
        warnings: [],
      };
    }

    case "pick_up_item": {
      const item = state.items[proposal.itemId];
      if (!item) return reject("entity_not_found", `Item not found: ${proposal.itemId}`);
      if (item.portable === false) return reject("permission_denied", `Item is not portable: ${proposal.itemId}`);
      if (item.location.kind !== "room" || item.location.roomId !== player.roomId) {
        return reject("invalid_location", `Item is not in the player's room: ${proposal.itemId}`);
      }
      return {
        accepted: true,
        result: proposal,
        events: [{ kind: "item_transferred", itemId: item.id, from: structuredClone(item.location), to: { kind: "inventory", ownerId: player.id } }],
        warnings: [],
      };
    }

    case "drop_item": {
      const item = state.items[proposal.itemId];
      if (!item) return reject("entity_not_found", `Item not found: ${proposal.itemId}`);
      if (!ownedByPlayer(item.location, player.id) || proposal.roomId !== player.roomId || !state.rooms[proposal.roomId]) {
        return reject("invalid_location", `Item cannot be dropped here: ${proposal.itemId}`);
      }
      return {
        accepted: true,
        result: proposal,
        events: [{ kind: "item_transferred", itemId: item.id, from: structuredClone(item.location), to: { kind: "room", roomId: proposal.roomId } }],
        warnings: [],
      };
    }

    case "equip_item": {
      const item = state.items[proposal.itemId];
      if (!item) return reject("entity_not_found", `Item not found: ${proposal.itemId}`);
      if (item.kind !== "equipment" || item.equipSlot !== proposal.slot) {
        return reject("precondition_failed", `Item cannot use equipment slot ${proposal.slot}: ${proposal.itemId}`);
      }
      if (item.location.kind !== "inventory" || item.location.ownerId !== player.id) {
        return reject("invalid_location", `Item is not in inventory: ${proposal.itemId}`);
      }
      const equipEvent: WorldEvent = {
        kind: "item_transferred",
        itemId: item.id,
        from: structuredClone(item.location),
        to: { kind: "equipped", ownerId: player.id, slot: proposal.slot },
      };
      const events: [WorldEvent, ...WorldEvent[]] = [equipEvent];
      const previousId = player.equipment[proposal.slot];
      if (previousId && previousId !== item.id) {
        const previous = state.items[previousId];
        if (!previous || previous.location.kind !== "equipped" || previous.location.slot !== proposal.slot) {
          return reject("precondition_failed", `Equipment index is inconsistent for slot ${proposal.slot}`);
        }
        events.unshift({
          kind: "item_transferred",
          itemId: previous.id,
          from: structuredClone(previous.location),
          to: { kind: "inventory", ownerId: player.id },
        });
      }
      return { accepted: true, result: proposal, events, warnings: [] };
    }

    case "consume_item": {
      const item = state.items[proposal.itemId];
      if (!item) return reject("entity_not_found", `Item not found: ${proposal.itemId}`);
      if (item.location.kind !== "inventory" || item.location.ownerId !== player.id) {
        return reject("invalid_location", `Item is not consumable from inventory: ${proposal.itemId}`);
      }
      if (item.consumable !== true) {
        return reject("precondition_failed", `Item is not marked consumable: ${proposal.itemId}`);
      }
      return {
        accepted: true,
        result: proposal,
        events: [{ kind: "item_transferred", itemId: item.id, from: structuredClone(item.location), to: { kind: "destroyed" } }],
        warnings: [],
      };
    }
  }
};
