import { decideGmTableProposal } from "../engine/gm-table-decider.ts";
import type { ProposalBatchEnvelope, ProposalEnvelope } from "../types/proposals.ts";
import type { GmTableProposal } from "../types/gm-proposals.ts";
import type { StoryOutcomeDef, WorldState } from "../types/world.ts";
import { settle, settleBatch, type BatchSettlement, type Settlement } from "./settlement.ts";

/** Settle one operation proposed by the persistent Pi GM. */
export function settleGmOperation(
  state: WorldState,
  proposal: ProposalEnvelope<GmTableProposal>,
  storyOutcomes: readonly StoryOutcomeDef[],
): Settlement<GmTableProposal> {
  return settle(state, proposal, decideGmTableProposal, { storyOutcomes });
}

/** Settle one ordered Pi response as independent, non-interleaving table transactions. */
export function settleGmBatch(
  state: WorldState,
  batch: ProposalBatchEnvelope<GmTableProposal>,
  storyOutcomes: readonly StoryOutcomeDef[],
): BatchSettlement<GmTableProposal> {
  return settleBatch(state, batch, decideGmTableProposal, { storyOutcomes });
}
