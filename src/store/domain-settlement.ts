import { decideItem, decideMovement } from "../engine/table-deciders.ts";
import type { AnyMutation } from "../types/mutations.ts";
import type { ItemProposal, MovementProposal } from "../types/table-proposals.ts";
import type { WorldState } from "../types/world.ts";
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
    || mutation.kind === "engine/item_consumed";
}

function settleTyped<TProposal>(
  state: WorldState,
  payload: TProposal,
  metadata: LegacyProposalMetadata,
  decider: Parameters<typeof settle<TProposal, TProposal>>[2],
): Settlement<TProposal> {
  return settle(
    state,
    {
      proposalId: metadata.proposalId,
      correlationId: metadata.correlationId,
      causationId: metadata.causationId,
      source: {
        kind: metadata.sourceId === "dm" || metadata.sourceId === "opening-dm" ? "dm" : "engine",
        id: metadata.sourceId ?? "runtime",
        sessionId: metadata.sessionId,
      },
      expectedRevision: state.revision,
      observedTurn: state.turn,
      payload,
    },
    decider,
    { storyOutcomes: [] },
  );
}

export function settleRuntimeMutation(
  state: WorldState,
  mutation: AnyMutation,
  metadata: LegacyProposalMetadata,
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
    default:
      return settleLegacyMutation(state, mutation, metadata);
  }
}
