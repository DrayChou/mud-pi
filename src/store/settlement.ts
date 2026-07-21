import type { Decider, DecisionContext } from "../engine/decide.ts";
import type {
  ProposalBatchEnvelope,
  ProposalEnvelope,
  SettlementRejection,
  SettlementWarning,
} from "../types/proposals.ts";
import type { CommittedWorldEvent } from "../types/world-events.ts";
import type { WorldState } from "../types/world.ts";
import { EventInvariantError, evolve } from "./evolve.ts";
import { appendJournalTransaction, journalEnabled, type JournalTransaction } from "./journal.ts";
import { enqueueOutbox } from "./outbox.ts";

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

export type BatchSettlement<TResult = unknown> =
  | {
      accepted: true;
      batchId: string;
      correlationId: string;
      revisionBefore: number;
      revisionAfter: number;
      settlements: Settlement<TResult>[];
      allAccepted: boolean;
    }
  | {
      accepted: false;
      batchId: string;
      correlationId: string;
      revisionBefore: number;
      revisionAfter: number;
      settlements: readonly [];
      rejection: SettlementRejection;
    };

const settlementsByState = new WeakMap<WorldState, Map<string, Settlement<unknown>>>();
const activeBatchStates = new WeakSet<WorldState>();

function transactionId(): string {
  return `txn-${crypto.randomUUID()}`;
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
  if (journalEnabled(liveState)) {
    try {
      const journalRecord = appendJournalTransaction(liveState, {
        transactionId: settlement.transactionId,
        revisionBefore: settlement.revisionBefore,
        revisionAfter: settlement.revisionAfter,
        turn: settlement.turn,
        source: settlement.proposal.source,
        correlationId: settlement.proposal.correlationId,
        causationId: settlement.proposal.causationId,
        proposalId: settlement.proposal.proposalId,
        proposal: structuredClone(settlement.proposal),
        result: structuredClone(settlement.result),
        warnings: structuredClone(settlement.warnings),
        events: settlement.committedEvents.map((committed) => committed.event),
      });
      for (const pending of journalRecord.outbox ?? []) {
        try {
          enqueueOutbox(liveState.worldId, pending.effect, pending.effectId);
        } catch {
          // The journal is authoritative and retains the pending effect for startup recovery.
        }
      }
    } catch (error) {
      return rejected(settlement.transactionId, liveState, settlement.proposal, {
        code: "commit_failed",
        safeMessage: "That action could not be recorded safely.",
        diagnostic: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }
  const replacement = structuredClone(settlement.nextState);
  for (const key of Object.keys(liveState) as Array<keyof WorldState>) delete liveState[key];
  Object.assign(liveState, replacement);
  return settlement;
}

export function restoreJournalSettlements(state: WorldState, records: readonly JournalTransaction[]): void {
  for (const record of records) {
    const committedEvents = record.events.map((event, index): CommittedWorldEvent => ({
      eventId: `${record.transactionId}:${index}`,
      transactionId: record.transactionId,
      index,
      revision: record.revisionAfter,
      turn: record.turn,
      source: structuredClone(record.source),
      correlationId: record.correlationId,
      causationId: record.causationId,
      event: structuredClone(event),
    }));
    rememberSettlement(state, record.proposalId, {
      accepted: true,
      transactionId: record.transactionId,
      proposal: structuredClone(record.proposal),
      result: structuredClone(record.result),
      revisionBefore: record.revisionBefore,
      revisionAfter: record.revisionAfter,
      turn: record.turn,
      committedEvents,
      warnings: structuredClone(record.warnings),
      nextState: structuredClone(state),
    });
  }
}

function rememberSettlement(state: WorldState, proposalId: string, settlement: Settlement<unknown>): void {
  let priorSettlements = settlementsByState.get(state);
  if (!priorSettlements) {
    priorSettlements = new Map();
    settlementsByState.set(state, priorSettlements);
  }
  priorSettlements.set(proposalId, settlement);
}

function settleInternal<TProposal, TResult>(
  state: WorldState,
  proposal: ProposalEnvelope<TProposal>,
  decider: Decider<TProposal, TResult>,
  context: Readonly<DecisionContext>,
  allowDuringBatch: boolean,
): Settlement<TResult> {
  const prior = settlementsByState.get(state)?.get(proposal.proposalId);
  if (prior) return prior as Settlement<TResult>;

  if (activeBatchStates.has(state) && !allowDuringBatch) {
    const blocked = rejected<TResult>(transactionId(), state, proposal, {
      code: "commit_failed",
      safeMessage: "That action could not be settled at the same time.",
      diagnostic: "An unrelated proposal attempted to interleave with an active batch.",
      retryable: true,
    });
    rememberSettlement(state, proposal.proposalId, blocked);
    return blocked;
  }

  const settlement = commitPreparedSettlement(state, prepareSettlement(state, proposal, decider, context));
  rememberSettlement(state, proposal.proposalId, settlement);
  return settlement;
}

export function settle<TProposal, TResult>(
  state: WorldState,
  proposal: ProposalEnvelope<TProposal>,
  decider: Decider<TProposal, TResult>,
  context: Readonly<DecisionContext>,
): Settlement<TResult> {
  return settleInternal(state, proposal, decider, context, false);
}

export function settleBatch<TProposal, TResult>(
  state: WorldState,
  batch: ProposalBatchEnvelope<TProposal>,
  decider: Decider<TProposal, TResult>,
  context: Readonly<DecisionContext>,
): BatchSettlement<TResult> {
  const priorSettlements = batch.proposals.map((proposal) => settlementsByState.get(state)?.get(proposal.proposalId));
  if (priorSettlements.length > 0 && priorSettlements.every((settlement) => settlement !== undefined)) {
    const settlements = priorSettlements as Settlement<TResult>[];
    return {
      accepted: true,
      batchId: batch.batchId,
      correlationId: batch.correlationId,
      revisionBefore: settlements[0]!.revisionBefore,
      revisionAfter: settlements.at(-1)!.revisionAfter,
      settlements,
      allAccepted: settlements.every((settlement) => settlement.accepted),
    };
  }

  const revisionBefore = currentRevision(state);
  if (batch.expectedRevision !== revisionBefore) {
    return {
      accepted: false,
      batchId: batch.batchId,
      correlationId: batch.correlationId,
      revisionBefore,
      revisionAfter: revisionBefore,
      settlements: [],
      rejection: {
        code: "stale_revision",
        safeMessage: "The world changed before those actions could be completed.",
        diagnostic: `Expected batch revision ${batch.expectedRevision}, current revision is ${revisionBefore}.`,
        details: { expectedRevision: batch.expectedRevision, currentRevision: revisionBefore },
        retryable: true,
      },
    };
  }
  if (activeBatchStates.has(state)) {
    return {
      accepted: false,
      batchId: batch.batchId,
      correlationId: batch.correlationId,
      revisionBefore,
      revisionAfter: revisionBefore,
      settlements: [],
      rejection: {
        code: "commit_failed",
        safeMessage: "Those actions could not be settled at the same time.",
        diagnostic: "A proposal batch is already active for this WorldState.",
        retryable: true,
      },
    };
  }

  activeBatchStates.add(state);
  const settlements: Settlement<TResult>[] = [];
  try {
    for (const child of batch.proposals) {
      const proposal: ProposalEnvelope<TProposal> = {
        proposalId: child.proposalId,
        correlationId: batch.correlationId,
        causationId: child.causationId,
        source: batch.source,
        expectedRevision: currentRevision(state),
        observedTurn: batch.observedTurn,
        payload: child.payload,
      };
      settlements.push(settleInternal(state, proposal, decider, context, true));
    }
  } finally {
    activeBatchStates.delete(state);
  }

  return {
    accepted: true,
    batchId: batch.batchId,
    correlationId: batch.correlationId,
    revisionBefore,
    revisionAfter: currentRevision(state),
    settlements,
    allAccepted: settlements.every((settlement) => settlement.accepted),
  };
}
