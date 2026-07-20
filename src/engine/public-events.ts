import type { GameEvent } from "../types/events.ts";
import type { CommittedWorldEvent } from "../types/world-events.ts";

export interface CriticalNpcProjectionMetadata {
  deathPolicy?: "continue" | "ai_evaluate" | "immediate_outcome";
  notes?: string;
}

/** Public facts needed to render event payloads that intentionally contain only IDs. */
export interface PublicProjectionContext {
  playerId?: string;
  playerRoomId?: string;
  entityRoomIds?: Readonly<Record<string, string>>;
  criticalNpcs?: Readonly<Record<string, CriticalNpcProjectionMetadata>>;
}

/**
 * Project one committed world fact into zero or more public events.
 *
 * This function is deliberately stateless: callers supply only public lookup data for fields
 * that are not present in the committed fact. Commit/source metadata is never copied.
 */
export function projectPublicEvents(
  committed: CommittedWorldEvent,
  context: PublicProjectionContext = {},
): GameEvent[] {
  const event = committed.event;
  const turn = committed.turn;

  switch (event.kind) {
    case "player_moved":
      return [{
        kind: "player_moved",
        turn,
        actorId: event.playerId,
        fromRoomId: event.fromRoomId,
        toRoomId: event.toRoomId,
        roomId: event.toRoomId,
      }];

    case "player_spoke":
      return [{
        kind: "player_spoke",
        turn,
        actorId: event.playerId,
        roomId: event.roomId,
        message: event.message,
        targetId: event.targetId,
      }];

    case "item_created": {
      const location = event.item.location;
      const roomId = location.kind === "room" ? location.roomId : context.playerRoomId;
      if (!roomId) return [];

      const events: GameEvent[] = [{ kind: "item_created", turn, itemId: event.item.id, roomId }];
      if (
        location.kind === "inventory"
        && (!context.playerId || location.ownerId === context.playerId)
      ) {
        events.push({
          kind: "item_granted",
          turn,
          actorId: location.ownerId,
          itemId: event.item.id,
          roomId,
        });
      }
      return events;
    }

    case "item_transferred": {
      const { from, to } = event;
      if (from.kind === "room" && (to.kind === "inventory" || to.kind === "equipped")) {
        return [{
          kind: "item_picked_up",
          turn,
          actorId: to.ownerId,
          itemId: event.itemId,
          roomId: from.roomId,
        }];
      }
      if ((from.kind === "inventory" || from.kind === "equipped") && to.kind === "room") {
        return [{
          kind: "item_dropped",
          turn,
          actorId: from.ownerId,
          itemId: event.itemId,
          roomId: to.roomId,
        }];
      }
      if ((from.kind === "inventory" || from.kind === "equipped") && to.kind === "destroyed") {
        const roomId = context.entityRoomIds?.[from.ownerId]
          ?? (from.ownerId === context.playerId ? context.playerRoomId : undefined);
        return roomId ? [{
          kind: "item_consumed",
          turn,
          actorId: from.ownerId,
          itemId: event.itemId,
          roomId,
        }] : [];
      }
      return [];
    }

    case "parameter_changed": {
      if (event.after >= event.before || !event.cause.startsWith("harm:")) return [];
      const roomId = context.entityRoomIds?.[event.entityId]
        ?? (event.entityId === context.playerId ? context.playerRoomId : undefined);
      return roomId ? [{
        kind: "entity_attacked",
        turn,
        targetId: event.entityId,
        roomId,
        stat: event.parameterId,
        amount: event.before - event.after,
      }] : [];
    }

    case "lifecycle_changed": {
      if (
        event.entityId !== context.playerId
        || (event.after !== "dead" && event.after !== "incapacitated")
      ) return [];
      const roomId = context.entityRoomIds?.[event.entityId] ?? context.playerRoomId;
      return roomId ? [{
        kind: event.after === "dead" ? "player_died" : "player_incapacitated",
        turn,
        actorId: event.entityId,
        roomId,
      }] : [];
    }

    case "npc_defeated": {
      const events: GameEvent[] = [{
        kind: "entity_defeated",
        turn,
        entityId: event.npcId,
        roomId: event.roomId,
      }];
      const critical = context.criticalNpcs?.[event.npcId];
      if (critical) {
        events.push({
          kind: "critical_npc_died",
          turn,
          npcId: event.npcId,
          roomId: event.roomId,
          deathPolicy: critical.deathPolicy ?? "ai_evaluate",
          notes: critical.notes,
        });
      }
      return events;
    }

    case "npc_moved":
      return [{
        kind: "npc_moved",
        turn,
        npcId: event.npcId,
        fromRoomId: event.fromRoomId,
        toRoomId: event.toRoomId,
        roomId: event.toRoomId,
      }];

    case "perceptible_signal_emitted":
      return [{
        kind: "perceptible_signal",
        turn,
        signalId: event.signalId,
        roomId: event.roomId,
        message: event.message,
        targetId: event.targetId,
      }];

    case "objective_completed": {
      if (!context.playerId || !context.playerRoomId) return [];
      return [{
        kind: "objective_completed",
        turn,
        objectiveId: event.objectiveId,
        actorId: context.playerId,
        roomId: context.playerRoomId,
      }];
    }

    default:
      return [];
  }
}
