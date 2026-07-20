import type { Decider, DecisionContext } from "../engine/decide.ts";
import type { ProposalEnvelope, SettlementRejection, SettlementWarning } from "../types/proposals.ts";
import type { CommittedWorldEvent } from "../types/world-events.ts";
import type { WorldState } from "../types/world.ts";
import { EventInvariantError, evolve } from "./evolve.ts";

export type Settlement<TResult = unknown> =
  | {
      accepted: true;
      transactionId: string;
      proposal: ProposalEnvelope<unknown>;
      result: TResult;
      revisionBefore: number;
      revisionAfter: number;
      turn: number;
      committedEvents: readonly CommittedWorldEvent[];
      warnings: SettlementWarning[];
      nextState: WorldState;
    }
  | {
      accepted: false;
      transactionId: string;
      proposal: ProposalEnvelope<unknown>;
      revisionBefore: number;
      revisionAfter: number;
      turn: number;
      committedEvents: readonly [];
      rejection: SettlementRejection;
      warnings: readonly [];
    };

let nextTransactionSequence = 0;

function transactionId(): string {
  nextTransactionSequence += 1;
  return `txn-${nextTransactionSequence}`;
}

function currentRevision(state: WorldState): number {
  return state.revision ?? 0;
}

function rejected<TResult>(
  id: string,
  state: WorldState,
  proposal: ProposalEnvelope<unknown>,
  rejection: SettlementRejection,
): Settlement<TResult> {
  const revision = currentRevision(state);
  return {
    accepted: false,
    transactionId: id,
    proposal,
    revisionBefore: revision,
    revisionAfter: revision,
    turn: state.turn,
    committedEvents: [],
    rejection,
    warnings: [],
  };
}

export function prepareSettlement<TProposal, TResult>(
  state: WorldState,
  proposal: ProposalEnvelope<TProposal>,
  decider: Decider<TProposal, TResult>,
  context: Readonly<DecisionContext>,
): Settlement<TResult> {
  const id = transactionId();
  const revisionBefore = currentRevision(state);
  if (proposal.expectedRevision !== revisionBefore) {
    return rejected(id, state, proposal, {
      code: "stale_revision",
      safeMessage: "The world changed before that action could be completed.",
      diagnostic: `Expected revision ${proposal.expectedRevision}, current revision is ${revisionBefore}.`,
      details: { expectedRevision: proposal.expectedRevision, currentRevision: revisionBefore },
      retryable: true,
    });
  }

  const decision = decider(structuredClone(state), proposal, context);
  if (!decision.accepted) return rejected(id, state, proposal, decision.rejection);

  const nextState = structuredClone(state);
  try {
    for (const event of decision.events) evolve(nextState, event);
  } catch (error) {
    if (!(error instanceof EventInvariantError)) throw error;
    return rejected(id, state, proposal, {
      code: "event_invariant_failed",
      safeMessage: "That action could not be completed safely.",
      diagnostic: error.message,
      details: { eventKind: error.event.kind },
      retryable: false,
    });
  }

  const revisionAfter = revisionBefore + 1;
  nextState.revision = revisionAfter;
  const committedEvents = decision.events.map((event, index): CommittedWorldEvent => ({
    eventId: `${id}:${index}`,
    transactionId: id,
    index,
    revision: revisionAfter,
    turn: nextState.turn,
    source: structuredClone(proposal.source),
    correlationId: proposal.correlationId,
    causationId: proposal.causationId,
    event: structuredClone(event),
  }));

  return {
    accepted: true,
    transactionId: id,
    proposal,
    result: decision.result,
    revisionBefore,
    revisionAfter,
    turn: nextState.turn,
    committedEvents,
    warnings: structuredClone(decision.warnings),
    nextState,
  };
}

export function commitPreparedSettlement<TResult>(
  liveState: WorldState,
  settlement: Settlement<TResult>,
): Settlement<TResult> {
  if (!settlement.accepted) return settlement;
  if (currentRevision(liveState) !== settlement.revisionBefore) {
    return rejected(settlement.transactionId, liveState, settlement.proposal, {
      code: "commit_failed",
      safeMessage: "The world changed before that action could be committed.",
      diagnostic: `Prepared revision ${settlement.revisionBefore}, current revision is ${currentRevision(liveState)}.`,
      retryable: true,
    });
  }
  const replacement = structuredClone(settlement.nextState);
  for (const key of Object.keys(liveState) as Array<keyof WorldState>) delete liveState[key];
  Object.assign(liveState, replacement);
  return settlement;
}

export function settle<TProposal, TResult>(
  state: WorldState,
  proposal: ProposalEnvelope<TProposal>,
  decider: Decider<TProposal, TResult>,
  context: Readonly<DecisionContext>,
): Settlement<TResult> {
  return commitPreparedSettlement(state, prepareSettlement(state, proposal, decider, context));
}
