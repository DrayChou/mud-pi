import { decideItem, decideMovement } from "../engine/table-deciders.ts";
import type { GmProposal, GmTableProposal } from "../types/gm-proposals.ts";
import type { AnyMutation } from "../types/mutations.ts";
import type { ItemProposal, MovementProposal } from "../types/table-proposals.ts";
import type { StoryOutcomeDef, WorldState } from "../types/world.ts";
import { settleGmOperation } from "./gm-protocol.ts";
import { settleLegacyMutation, type LegacyProposalMetadata } from "./legacy-settlement.ts";
import { settle, type Settlement } from "./settlement.ts";

export function isMigratedTableMutation(mutation: AnyMutation): boolean {
  return mutation.kind === "engine/player_moved"
    || mutation.kind === "dm/item_added"
    || mutation.kind === "engine/item_reward_granted"
    || mutation.kind === "dm/item_reward_granted"
    || mutation.kind === "engine/item_picked_up"
    || mutation.kind === "engine/item_dropped"
    || mutation.kind === "engine/item_equipped"
    || mutation.kind === "engine/item_consumed"
    || mutation.kind === "dm/room_exit_added"
    || mutation.kind === "dm/npc_moved"
    || mutation.kind === "engine/npc_moved"
    || mutation.kind === "engine/player_stat_changed"
    || mutation.kind === "engine/npc_stat_changed"
    || mutation.kind === "dm/npc_stat_changed"
    || mutation.kind === "dm/fact_added"
    || mutation.kind === "dm/fact_removed"
    || mutation.kind === "engine/objective_completed"
    || mutation.kind === "dm/outcome_reached";
}

function settleTyped<TProposal>(
  state: WorldState,
  payload: TProposal,
  metadata: LegacyProposalMetadata,
  decider: Parameters<typeof settle<TProposal, TProposal>>[2],
  storyOutcomes: readonly StoryOutcomeDef[] = [],
): Settlement<TProposal> {
  return settle(
    state,
    {
      proposalId: metadata.proposalId,
      correlationId: metadata.correlationId,
      causationId: metadata.causationId,
      source: {
        kind: metadata.sourceKind ?? (metadata.sourceId === "dm" || metadata.sourceId === "opening-dm" ? "dm" : "engine"),
        id: metadata.sourceId ?? "runtime",
        sessionId: metadata.sessionId,
      },
      expectedRevision: state.revision,
      observedTurn: state.turn,
      payload,
    },
    decider,
    { storyOutcomes },
  );
}

function settleTypedGm(
  state: WorldState,
  payload: GmProposal,
  metadata: LegacyProposalMetadata,
  storyOutcomes: readonly StoryOutcomeDef[],
): Settlement<GmTableProposal> {
  return settleGmOperation(state, {
    proposalId: metadata.proposalId,
    correlationId: metadata.correlationId,
    causationId: metadata.causationId,
    source: {
      kind: metadata.sourceKind ?? (metadata.sourceId === "dm" || metadata.sourceId === "opening-dm" ? "dm" : "engine"),
      id: metadata.sourceId ?? "runtime",
      sessionId: metadata.sessionId,
    },
    expectedRevision: state.revision,
    observedTurn: state.turn,
    payload,
  }, storyOutcomes);
}

export function settleRuntimeMutation(
  state: WorldState,
  mutation: AnyMutation,
  metadata: LegacyProposalMetadata,
  storyOutcomes: readonly StoryOutcomeDef[] = [],
): Settlement<unknown> {
  switch (mutation.kind) {
    case "engine/player_moved":
      return settleTyped<MovementProposal>(state, { kind: "move_player", toRoomId: mutation.toRoomId }, metadata, decideMovement);
    case "dm/item_added":
      return settleTyped<ItemProposal>(state, { kind: "create_item", item: mutation.item }, metadata, decideItem);
    case "engine/item_reward_granted":
    case "dm/item_reward_granted":
      return settleTyped<ItemProposal>(state, { kind: "grant_item_reward", request: mutation }, metadata, decideItem);
    case "engine/item_picked_up":
      return settleTyped<ItemProposal>(state, { kind: "pick_up_item", itemId: mutation.itemId }, metadata, decideItem);
    case "engine/item_dropped":
      return settleTyped<ItemProposal>(state, { kind: "drop_item", itemId: mutation.itemId, roomId: mutation.roomId }, metadata, decideItem);
    case "engine/item_equipped":
      return settleTyped<ItemProposal>(state, { kind: "equip_item", itemId: mutation.itemId, slot: mutation.slot }, metadata, decideItem);
    case "engine/item_consumed":
      return settleTyped<ItemProposal>(state, { kind: "consume_item", itemId: mutation.itemId }, metadata, decideItem);
    case "dm/room_exit_added":
      return settleTypedGm(state, { kind: "set_exit", roomId: mutation.roomId, direction: mutation.direction, toRoomId: mutation.toRoomId }, metadata, storyOutcomes);
    case "engine/player_stat_changed":
      return settleTypedGm(state, { kind: "adjust_parameter", entityId: state.player.id, parameterId: mutation.stat, delta: mutation.delta, cause: mutation.delta < 0 ? `harm:${mutation.kind}` : mutation.kind }, metadata, storyOutcomes);
    case "engine/npc_stat_changed":
    case "dm/npc_stat_changed":
      return settleTypedGm(state, { kind: "adjust_parameter", entityId: mutation.npcId, parameterId: mutation.stat, delta: mutation.delta, cause: mutation.delta < 0 ? `harm:${mutation.kind}` : mutation.kind }, metadata, storyOutcomes);
    case "engine/npc_moved":
    case "dm/npc_moved":
      return settleTypedGm(state, { kind: "move_npc", npcId: mutation.npcId, toRoomId: mutation.toRoomId }, metadata, storyOutcomes);
    case "dm/fact_added":
      return settleTypedGm(state, { kind: "record_fact", text: mutation.text, roomId: mutation.tile ?? undefined }, metadata, storyOutcomes);
    case "dm/fact_removed":
      return settleTypedGm(state, { kind: "remove_fact", text: mutation.text }, metadata, storyOutcomes);
    case "engine/objective_completed":
      return settleTypedGm(state, { kind: "complete_objective", objectiveId: mutation.objectiveId }, metadata, storyOutcomes);
    case "dm/outcome_reached":
      return settleTypedGm(state, { kind: "reach_outcome", outcome: mutation.outcome, requestedAtTurn: mutation.requestedAtTurn, reason: mutation.outcome.reason }, metadata, storyOutcomes);
    default:
      return settleLegacyMutation(state, mutation, metadata);
  }
}
