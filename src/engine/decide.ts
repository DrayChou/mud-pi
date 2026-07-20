import type { GameEvent } from "../types/events.ts";
import type { Decision, ProposalEnvelope } from "../types/proposals.ts";
import type { CommittedWorldEvent } from "../types/world-events.ts";
import type { StoryOutcomeDef, WorldState } from "../types/world.ts";

export interface ConflictResolver {
  readonly id?: string;
}

export interface DecisionContext {
  storyOutcomes: readonly StoryOutcomeDef[];
  conflictResolver?: ConflictResolver;
}

export type Decider<TProposal, TResult = unknown> = (
  state: Readonly<WorldState>,
  proposal: ProposalEnvelope<TProposal>,
  context: Readonly<DecisionContext>,
) => Decision<TResult>;

export interface PublicProjectionContext {
  playerId?: string;
  playerRoomId?: string;
  criticalNpcs?: Readonly<Record<string, { deathPolicy?: "continue" | "ai_evaluate" | "immediate_outcome"; notes?: string }>>;
}

export function projectPublicEvents(
  committed: CommittedWorldEvent,
  context: PublicProjectionContext = {},
): GameEvent[] {
  const event = committed.event;
  const turn = committed.turn;
  switch (event.kind) {
    case "player_moved":
      return [{ kind: "player_moved", turn, actorId: event.playerId, fromRoomId: event.fromRoomId, toRoomId: event.toRoomId, roomId: event.toRoomId }];
    case "player_spoke":
      return [{ kind: "player_spoke", turn, actorId: event.playerId, roomId: event.roomId, message: event.message, targetId: event.targetId }];
    case "item_created": {
      const location = event.item.location;
      const roomId = location.kind === "room" ? location.roomId : context.playerRoomId;
      if (!roomId) return [];
      const projected: GameEvent[] = [{ kind: "item_created", turn, itemId: event.item.id, roomId }];
      if (location.kind === "inventory" && (!context.playerId || location.ownerId === context.playerId)) {
        projected.push({ kind: "item_granted", turn, actorId: location.ownerId, itemId: event.item.id, roomId });
      }
      return projected;
    }
    case "item_transferred": {
      const { from, to } = event;
      if (from.kind === "room" && (to.kind === "inventory" || to.kind === "equipped")) {
        return [{ kind: "item_picked_up", turn, actorId: to.ownerId, itemId: event.itemId, roomId: from.roomId }];
      }
      if ((from.kind === "inventory" || from.kind === "equipped") && to.kind === "room") {
        return [{ kind: "item_dropped", turn, actorId: from.ownerId, itemId: event.itemId, roomId: to.roomId }];
      }
      if (from.kind === "inventory" && to.kind === "destroyed") {
        const roomId = context.playerRoomId;
        return roomId ? [{ kind: "item_consumed", turn, actorId: from.ownerId, itemId: event.itemId, roomId }] : [];
      }
      return [];
    }
    case "parameter_changed": {
      if (event.after >= event.before || !event.cause.startsWith("harm")) return [];
      const roomId = context.playerRoomId;
      return roomId ? [{ kind: "entity_attacked", turn, targetId: event.entityId, roomId, stat: event.parameterId, amount: event.before - event.after }] : [];
    }
    case "lifecycle_changed": {
      if (event.entityId !== context.playerId || (event.after !== "dead" && event.after !== "incapacitated") || !context.playerRoomId) return [];
      return [{ kind: event.after === "dead" ? "player_died" : "player_incapacitated", turn, actorId: event.entityId, roomId: context.playerRoomId }];
    }
    case "npc_moved":
      return [{ kind: "npc_moved", turn, npcId: event.npcId, fromRoomId: event.fromRoomId, toRoomId: event.toRoomId, roomId: event.toRoomId }];
    case "npc_defeated": {
      const projected: GameEvent[] = [{ kind: "entity_defeated", turn, entityId: event.npcId, roomId: event.roomId }];
      const critical = context.criticalNpcs?.[event.npcId];
      if (critical) projected.push({ kind: "critical_npc_died", turn, npcId: event.npcId, roomId: event.roomId, deathPolicy: critical.deathPolicy ?? "ai_evaluate", notes: critical.notes });
      return projected;
    }
    case "objective_completed": {
      if (!context.playerId || !context.playerRoomId) return [];
      return [{ kind: "objective_completed", turn, objectiveId: event.objectiveId, actorId: context.playerId, roomId: context.playerRoomId }];
    }
    default:
      return [];
  }
}
