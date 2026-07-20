import type { WorldEvent } from "./world-events.ts";

export type ProposalSourceKind = "player" | "dm" | "npc" | "engine" | "world_script";

export interface ProposalSource {
  kind: ProposalSourceKind;
  id: string;
  sessionId?: string;
}

export interface ProposalEnvelope<TProposal> {
  proposalId: string;
  correlationId: string;
  causationId?: string;
  source: ProposalSource;
  expectedRevision: number;
  observedTurn: number;
  payload: TProposal;
}

export interface ProposalBatchEnvelope<TProposal> {
  batchId: string;
  correlationId: string;
  source: ProposalSource;
  expectedRevision: number;
  observedTurn: number;
  proposals: Array<{
    proposalId: string;
    causationId?: string;
    payload: TProposal;
  }>;
}

export type SettlementRejectionCode =
  | "stale_revision"
  | "invalid_proposal"
  | "entity_not_found"
  | "duplicate_entity"
  | "invalid_location"
  | "invalid_parameter"
  | "invalid_value"
  | "permission_denied"
  | "precondition_failed"
  | "already_applied"
  | "unsupported_operation"
  | "event_invariant_failed"
  | "commit_failed";

export interface SettlementRejection {
  code: SettlementRejectionCode;
  safeMessage: string;
  diagnostic: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export type SettlementWarningCode =
  | "value_clamped"
  | "mechanic_removed"
  | "kind_downgraded"
  | "legacy_normalized";

export interface SettlementWarning {
  code: SettlementWarningCode;
  message: string;
  details?: Record<string, unknown>;
  narrationRelevant: boolean;
}

export type Decision<TResult = unknown, TEvent extends WorldEvent = WorldEvent> =
  | {
      accepted: true;
      result: TResult;
      events: readonly [TEvent, ...TEvent[]];
      warnings: SettlementWarning[];
    }
  | {
      accepted: false;
      rejection: SettlementRejection;
      events: readonly [];
      warnings: readonly [];
    };
