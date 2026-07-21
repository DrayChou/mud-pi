import type { DmMutation } from "../types/mutations.ts";
import type { GmTableProposal } from "../types/gm-proposals.ts";
import type { CanonicalTableOperation, TableOperationPhase } from "../types/table-operations.ts";

function legacyPhase(operation: DmMutation): TableOperationPhase {
  switch (operation.kind) {
    case "dm/room_added":
    case "dm/item_added":
    case "dm/item_reward_granted":
    case "dm/npc_added":
      return "materialize";
    case "dm/room_exit_added":
    case "dm/room_desc_updated":
      return "topology";
    case "dm/outcome_reached":
      return "outcome";
    default:
      return "state";
  }
}

function gmPhase(operation: GmTableProposal): TableOperationPhase {
  switch (operation.kind) {
    case "create_item":
    case "grant_item_reward":
      return "materialize";
    case "set_exit":
      return "topology";
    case "reach_outcome":
      return "outcome";
    default:
      return "state";
  }
}

const PHASE_ORDER: Record<TableOperationPhase, number> = {
  materialize: 0,
  topology: 1,
  state: 2,
  outcome: 3,
};

/**
 * Normalizes the two accepted DM wire formats into one ordered internal plan.
 * Legacy arrays remain readable, but Runtime no longer decides their ordering separately.
 */
export function normalizeTableOperations(
  legacyMutations: readonly DmMutation[],
  gmOperations: readonly GmTableProposal[],
): CanonicalTableOperation[] {
  const operations: CanonicalTableOperation[] = [
    ...legacyMutations.map((operation, originalIndex): CanonicalTableOperation => ({
      source: "legacy_world_update",
      phase: legacyPhase(operation),
      operation,
      originalIndex,
    })),
    ...gmOperations.map((operation, originalIndex): CanonicalTableOperation => ({
      source: "gm_operation",
      phase: gmPhase(operation),
      operation,
      originalIndex,
    })),
  ];
  return operations.sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]
    || (a.source === b.source ? a.originalIndex - b.originalIndex : a.source === "legacy_world_update" ? -1 : 1));
}
