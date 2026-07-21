import type { DmMutation } from "./mutations.ts";
import type { GmTableProposal } from "./gm-proposals.ts";

export type TableOperationPhase = "materialize" | "topology" | "state" | "outcome";

export type CanonicalTableOperation =
  | {
      source: "legacy_world_update";
      phase: TableOperationPhase;
      operation: DmMutation;
      originalIndex: number;
    }
  | {
      source: "gm_operation";
      phase: TableOperationPhase;
      operation: GmTableProposal;
      originalIndex: number;
    };
