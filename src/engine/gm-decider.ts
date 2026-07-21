import type { Decider } from "./decide.ts";
import type { GmProposal } from "../types/gm-proposals.ts";
import type { Decision, SettlementRejectionCode, SettlementWarning } from "../types/proposals.ts";
import type { PlayerLifecycle, WorldState } from "../types/world.ts";
import type { WorldEvent } from "../types/world-events.ts";

function reject(code: SettlementRejectionCode, diagnostic: string): Decision<GmProposal> {
  return {
    accepted: false,
    rejection: { code, safeMessage: "That GM table operation could not be completed.", diagnostic, retryable: false },
    events: [],
    warnings: [],
  };
}

function lifecycleAfter(state: Readonly<WorldState>, parameterId: string, after: number): PlayerLifecycle {
  const matched = state.schema.defs.flatMap((definition) => {
    const value = definition.key === parameterId ? after : (state.player.stats[definition.key] ?? definition.default);
    return (definition.thresholds ?? []).filter((threshold) =>
      threshold.operator === "lte" ? value <= threshold.value : value >= threshold.value
    );
  });
  if (matched.some((threshold) => threshold.effect.value === "dead")) return "dead";
  if (matched.some((threshold) => threshold.effect.value === "incapacitated")) {
    return state.player.lifecycle === "dead" ? "dead" : "incapacitated";
  }
  return state.player.lifecycle === "incapacitated" ? "active" : state.player.lifecycle;
}

export const decideGmProposal: Decider<GmProposal, GmProposal> = (state, envelope, context) => {
  const proposal = envelope.payload;
  if (
    envelope.source.kind !== "dm"
    && envelope.source.kind !== "engine"
    && !(envelope.source.kind === "npc" && proposal.kind === "move_npc" && envelope.source.id === proposal.npcId)
  ) {
    return reject("permission_denied", `${envelope.source.kind} cannot use the GM table protocol.`);
  }

  switch (proposal.kind) {
    case "record_fact": {
      if (envelope.source.kind !== "dm") return reject("permission_denied", `${envelope.source.kind} cannot record GM facts.`);
      const text = proposal.text.trim();
      if (!text) return reject("invalid_value", "A world fact requires non-empty text.");
      if (state.worldFacts.some((fact) => fact.text === text)) return reject("already_applied", `World fact already recorded: ${text}`);
      if (proposal.roomId && !state.rooms[proposal.roomId]) return reject("entity_not_found", `Fact room not found: ${proposal.roomId}`);
      return { accepted: true, result: proposal, events: [{ kind: "world_fact_added", fact: { text, tile: proposal.roomId ?? null, createdTurn: state.turn } }], warnings: [] };
    }

    case "remove_fact": {
      if (envelope.source.kind !== "dm") return reject("permission_denied", `${envelope.source.kind} cannot remove GM facts.`);
      const fact = state.worldFacts.find((candidate) => candidate.text === proposal.text);
      if (!fact) return reject("entity_not_found", `World fact not found: ${proposal.text}`);
      return { accepted: true, result: proposal, events: [{ kind: "world_fact_removed", fact: structuredClone(fact) }], warnings: [] };
    }

    case "set_exit": {
      if (envelope.source.kind !== "dm") return reject("permission_denied", `${envelope.source.kind} cannot rewrite room exits.`);
      const room = state.rooms[proposal.roomId];
      if (!room) return reject("entity_not_found", `Room not found: ${proposal.roomId}`);
      if (!state.rooms[proposal.toRoomId]) return reject("entity_not_found", `Exit destination not found: ${proposal.toRoomId}`);
      const direction = proposal.direction.trim();
      if (!direction) return reject("invalid_value", "Exit direction cannot be empty.");
      if (room.exits[direction] === proposal.toRoomId) return reject("already_applied", `Exit already points to ${proposal.toRoomId}.`);
      return { accepted: true, result: proposal, events: [{ kind: "room_exit_set", roomId: room.id, direction, beforeToRoomId: room.exits[direction], afterToRoomId: proposal.toRoomId }], warnings: [] };
    }

    case "adjust_parameter": {
      if (!Number.isFinite(proposal.delta) || proposal.delta === 0) return reject("invalid_value", `Invalid parameter delta: ${proposal.delta}`);
      const definition = state.schema.defs.find((candidate) => candidate.key === proposal.parameterId);
      if (!definition) return reject("invalid_parameter", `Unknown parameter: ${proposal.parameterId}`);
      const entity = proposal.entityId === state.player.id ? state.player : state.npcs[proposal.entityId];
      if (!entity) return reject("entity_not_found", `Entity not found: ${proposal.entityId}`);
      if (proposal.entityId !== state.player.id && envelope.source.kind === "dm" && state.npcs[proposal.entityId]?.controller && state.npcs[proposal.entityId]?.controller !== "dm") {
        return reject("permission_denied", `DM cannot adjust an independently controlled NPC: ${proposal.entityId}`);
      }
      const before = entity.stats[proposal.parameterId];
      if (before === undefined) return reject("invalid_parameter", `Entity does not have parameter ${proposal.parameterId}: ${proposal.entityId}`);
      const requested = before + proposal.delta;
      const after = Math.max(definition.min, Math.min(definition.max, requested));
      if (after === before) return reject("already_applied", `Parameter is already at its allowed boundary: ${proposal.entityId}/${proposal.parameterId}`);
      const warnings: SettlementWarning[] = after === requested ? [] : [{ code: "value_clamped", message: `${proposal.parameterId} was clamped to ${after}.`, details: { requested, accepted: after }, narrationRelevant: true }];
      const events: [WorldEvent, ...WorldEvent[]] = [{ kind: "parameter_changed", entityId: proposal.entityId, parameterId: proposal.parameterId, before, after, cause: proposal.cause }];
      if (proposal.entityId === state.player.id) {
        const lifecycle = lifecycleAfter(state, proposal.parameterId, after);
        if (lifecycle !== state.player.lifecycle) events.push({ kind: "lifecycle_changed", entityId: state.player.id, before: state.player.lifecycle, after: lifecycle, cause: proposal.cause });
      }
      return { accepted: true, result: proposal, events, warnings };
    }

    case "move_npc": {
      const npc = state.npcs[proposal.npcId];
      if (!npc) return reject("entity_not_found", `NPC not found: ${proposal.npcId}`);
      if (!npc.alive) return reject("precondition_failed", `NPC is not active: ${proposal.npcId}`);
      if (!state.rooms[proposal.toRoomId]) return reject("entity_not_found", `Destination room not found: ${proposal.toRoomId}`);
      if (npc.roomId === proposal.toRoomId) return reject("already_applied", `NPC is already in ${proposal.toRoomId}.`);
      if (envelope.source.kind === "dm" && npc.controller && npc.controller !== "dm") return reject("permission_denied", `DM cannot move an independently controlled NPC: ${proposal.npcId}`);
      return { accepted: true, result: proposal, events: [{ kind: "npc_moved", npcId: npc.id, fromRoomId: npc.roomId, toRoomId: proposal.toRoomId }], warnings: [] };
    }

    case "transfer_card": {
      const item = state.items[proposal.itemId];
      if (!item) return reject("entity_not_found", `Card not found: ${proposal.itemId}`);
      if (item.location.kind === "destroyed") return reject("precondition_failed", `Card has been consumed: ${proposal.itemId}`);
      if (item.portable === false || item.kind === "scenery") return reject("permission_denied", `Scenery cannot be transferred as a card: ${proposal.itemId}`);
      if (proposal.to.kind !== "room" && proposal.to.kind !== "inventory") return reject("invalid_location", `Unsupported card destination: ${proposal.itemId}`);
      if (proposal.to.kind === "room" && (!proposal.to.roomId || !state.rooms[proposal.to.roomId])) return reject("invalid_location", `Card destination room not found: ${proposal.to.roomId}`);
      if (proposal.to.kind === "inventory" && (!proposal.to.ownerId || proposal.to.ownerId !== state.player.id)) return reject("invalid_location", `Unsupported card owner: ${proposal.to.ownerId}`);
      if (JSON.stringify(item.location) === JSON.stringify(proposal.to)) return reject("already_applied", `Card is already at the requested location: ${proposal.itemId}`);
      return { accepted: true, result: proposal, events: [{ kind: "item_transferred", itemId: item.id, from: structuredClone(item.location), to: structuredClone(proposal.to) }], warnings: [] };
    }

    case "consume_card": {
      const item = state.items[proposal.itemId];
      if (!item) return reject("entity_not_found", `Card not found: ${proposal.itemId}`);
      if (item.location.kind === "destroyed") return reject("already_applied", `Card already consumed: ${proposal.itemId}`);
      if (item.consumable !== true) return reject("precondition_failed", `Card is not marked consumable: ${proposal.itemId}`);
      return { accepted: true, result: proposal, events: [{ kind: "item_transferred", itemId: item.id, from: structuredClone(item.location), to: { kind: "destroyed" } }], warnings: [] };
    }

    case "emit_signal": {
      if (!proposal.signalId.trim() || !proposal.message.trim()) return reject("invalid_value", "A perceptible signal requires an id and message.");
      if (!state.rooms[proposal.roomId]) return reject("entity_not_found", `Signal room not found: ${proposal.roomId}`);
      return { accepted: true, result: proposal, events: [{ kind: "perceptible_signal_emitted", signalId: proposal.signalId, roomId: proposal.roomId, message: proposal.message, targetId: proposal.targetId }], warnings: [] };
    }

    case "complete_objective": {
      const objective = state.objectives[proposal.objectiveId];
      if (!objective) return reject("entity_not_found", `Objective not found: ${proposal.objectiveId}`);
      if (objective.status === "completed") return reject("already_applied", `Objective already completed: ${proposal.objectiveId}`);
      if (envelope.source.kind === "dm" && objective.gmCompletionAllowed !== true) return reject("permission_denied", `Objective does not allow semantic GM completion: ${proposal.objectiveId}`);
      if (!(objective.requires ?? []).every((id) => state.objectives[id]?.status === "completed")) return reject("precondition_failed", `Objective prerequisites are incomplete: ${proposal.objectiveId}`);
      return { accepted: true, result: proposal, events: [{ kind: "objective_completed", objectiveId: objective.id, completedTurn: state.turn + 1, reason: proposal.reason }], warnings: [] };
    }

    case "reach_outcome": {
      if (envelope.source.kind !== "dm") return reject("permission_denied", `${envelope.source.kind} cannot declare story outcomes.`);
      if (state.outcome) return reject("already_applied", `Story outcome already reached: ${state.outcome.id}`);
      if (proposal.requestedAtTurn !== state.turn) return reject("precondition_failed", `Outcome was proposed for turn ${proposal.requestedAtTurn}, current turn is ${state.turn}.`);
      const definition = context.storyOutcomes.find((candidate) => candidate.id === proposal.outcome.id);
      if (!definition) return reject("precondition_failed", `Outcome is not allowed by this world pack: ${proposal.outcome.id}`);
      const outcome = { id: definition.id, type: definition.type, title: definition.title, summary: definition.summary, terminal: definition.terminal, reachedTurn: state.turn + 1, reason: proposal.reason ?? proposal.outcome.reason };
      return { accepted: true, result: proposal, events: [{ kind: "story_outcome_reached", outcome }], warnings: [] };
    }
  }
};
