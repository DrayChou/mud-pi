import { applyMutation } from "./apply.ts";
import { settle, type Settlement } from "./settlement.ts";
import type { AnyMutation } from "../types/mutations.ts";
import type { ProposalSource } from "../types/proposals.ts";
import type { WorldEvent } from "../types/world-events.ts";
import type { ItemLocation, WorldState } from "../types/world.ts";

export interface LegacyProposalMetadata {
  proposalId: string;
  correlationId: string;
  causationId?: string;
  sourceId?: string;
  sessionId?: string;
}

let nextLegacyProposal = 0;

export function nextLegacyProposalId(prefix = "legacy"): string {
  nextLegacyProposal += 1;
  return `${prefix}-${nextLegacyProposal}`;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sourceFor(mutation: AnyMutation, metadata: LegacyProposalMetadata): ProposalSource {
  return {
    kind: mutation.kind.startsWith("dm/") ? "dm" : "engine",
    id: metadata.sourceId ?? (mutation.kind.startsWith("dm/") ? "dm" : "legacy_engine"),
    sessionId: metadata.sessionId,
  };
}

function lifecycleAfterThresholds(state: WorldState): WorldState["player"]["lifecycle"] {
  return state.player.lifecycle;
}

function changedLocation(before: ItemLocation, after: ItemLocation): boolean {
  return !same(before, after);
}

function deriveExactEvents(before: WorldState, after: WorldState, mutation: AnyMutation): WorldEvent[] {
  if (mutation.kind === "engine/combat_started") {
    const npc = before.npcs[mutation.npcId];
    if (!npc) return [];
    return [{ kind: "conflict_started", actorId: before.player.id, targetId: npc.id, roomId: before.player.roomId }];
  }

  const events: WorldEvent[] = [];

  if (before.player.roomId !== after.player.roomId) {
    events.push({
      kind: "player_moved",
      playerId: before.player.id,
      fromRoomId: before.player.roomId,
      toRoomId: after.player.roomId,
    });
  }

  for (const [roomId, room] of Object.entries(after.rooms)) {
    const previous = before.rooms[roomId];
    if (!previous) {
      events.push({ kind: "room_created", room: structuredClone(room) });
      continue;
    }
    for (const [direction, afterToRoomId] of Object.entries(room.exits)) {
      if (previous.exits[direction] !== afterToRoomId) {
        events.push({
          kind: "room_exit_set",
          roomId,
          direction,
          beforeToRoomId: previous.exits[direction],
          afterToRoomId,
        });
      }
    }
    if (previous.desc !== room.desc) {
      events.push({ kind: "room_description_changed", roomId, before: previous.desc, after: room.desc });
    }
    if (previous.discovered !== room.discovered || previous.visitedTurn !== room.visitedTurn) {
      events.push({
        kind: "room_exploration_recorded",
        roomId,
        discoveredBefore: previous.discovered ?? false,
        discoveredAfter: true,
        visitedTurnBefore: previous.visitedTurn,
        visitedTurnAfter: room.visitedTurn!,
      });
    }
  }

  for (const [itemId, item] of Object.entries(after.items)) {
    const previous = before.items[itemId];
    if (!previous) events.push({ kind: "item_created", item: structuredClone(item) });
  }
  const transfers = Object.entries(after.items)
    .flatMap(([itemId, item]) => {
      const previous = before.items[itemId];
      return previous && changedLocation(previous.location, item.location)
        ? [{ kind: "item_transferred" as const, itemId, from: structuredClone(previous.location), to: structuredClone(item.location) }]
        : [];
    })
    .sort((a, b) => Number(a.to.kind === "equipped") - Number(b.to.kind === "equipped"));
  events.push(...transfers);

  for (const [parameterId, afterValue] of Object.entries(after.player.stats)) {
    const beforeValue = before.player.stats[parameterId];
    if (beforeValue !== afterValue) {
      events.push({
        kind: "parameter_changed",
        entityId: before.player.id,
        parameterId,
        before: beforeValue ?? 0,
        after: afterValue,
        cause: afterValue < (beforeValue ?? 0) ? `harm:${mutation.kind}` : mutation.kind,
      });
    }
  }
  if (before.player.lifecycle !== lifecycleAfterThresholds(after)) {
    events.push({
      kind: "lifecycle_changed",
      entityId: before.player.id,
      before: before.player.lifecycle,
      after: after.player.lifecycle,
      cause: mutation.kind,
    });
  }

  for (const [npcId, npc] of Object.entries(after.npcs)) {
    const previous = before.npcs[npcId];
    if (!previous) {
      events.push({ kind: "npc_created", npc: structuredClone(npc) });
      continue;
    }
    for (const [parameterId, afterValue] of Object.entries(npc.stats)) {
      const beforeValue = previous.stats[parameterId];
      if (beforeValue !== afterValue) {
        events.push({
          kind: "parameter_changed",
          entityId: npcId,
          parameterId,
          before: beforeValue ?? 0,
          after: afterValue,
          cause: afterValue < (beforeValue ?? 0) ? `harm:${mutation.kind}` : mutation.kind,
        });
      }
    }
    if (previous.roomId !== npc.roomId) {
      events.push({ kind: "npc_moved", npcId, fromRoomId: previous.roomId, toRoomId: npc.roomId });
    }
    if (previous.alive && !npc.alive) {
      events.push({ kind: "npc_defeated", npcId, roomId: previous.roomId });
    }
  }

  for (const fact of after.worldFacts) {
    if (!before.worldFacts.some((previous) => same(previous, fact))) {
      events.push({ kind: "world_fact_added", fact: structuredClone(fact) });
    }
  }
  for (const fact of before.worldFacts) {
    if (!after.worldFacts.some((current) => same(current, fact))) {
      events.push({ kind: "world_fact_removed", fact: structuredClone(fact) });
    }
  }

  for (const [plotId, plot] of Object.entries(after.plotThreads)) {
    if (!same(before.plotThreads[plotId], plot)) {
      events.push({
        kind: "plot_thread_changed",
        plotId,
        before: before.plotThreads[plotId] ? structuredClone(before.plotThreads[plotId]) : undefined,
        after: structuredClone(plot),
      });
    }
  }

  for (const [objectiveId, objective] of Object.entries(after.objectives)) {
    const previous = before.objectives[objectiveId];
    if (previous?.status !== "completed" && objective.status === "completed") {
      events.push({ kind: "objective_completed", objectiveId, completedTurn: objective.completedTurn! });
    }
  }

  if (!before.outcome && after.outcome) {
    events.push({ kind: "story_outcome_reached", outcome: structuredClone(after.outcome) });
  }
  if (before.turn !== after.turn) {
    events.push({ kind: "turn_advanced", before: before.turn, after: after.turn });
  }

  return events;
}

export function settleLegacyMutation(
  state: WorldState,
  mutation: AnyMutation,
  metadata: LegacyProposalMetadata,
): Settlement<AnyMutation> {
  return settle(
    state,
    {
      proposalId: metadata.proposalId,
      correlationId: metadata.correlationId,
      causationId: metadata.causationId,
      source: sourceFor(mutation, metadata),
      expectedRevision: state.revision,
      observedTurn: state.turn,
      payload: mutation,
    },
    (snapshot, proposal) => {
      const candidate = structuredClone(snapshot);
      applyMutation(candidate, proposal.payload);
      const events = deriveExactEvents(snapshot, candidate, proposal.payload);
      if (events.length === 0) {
        return {
          accepted: false,
          rejection: {
            code: same(snapshot, candidate) ? "precondition_failed" : "unsupported_operation",
            safeMessage: "That table operation could not be applied.",
            diagnostic: `Legacy mutation ${proposal.payload.kind} produced no replayable event.`,
            retryable: false,
          },
          events: [],
          warnings: [],
        };
      }
      return { accepted: true, result: proposal.payload, events: events as [WorldEvent, ...WorldEvent[]], warnings: [] };
    },
    { storyOutcomes: [] },
  );
}
