import type { ItemProposal, MovementProposal } from "./table-proposals.ts";
import type { ReachedOutcome } from "./world.ts";

/** Stable authoritative table operations available to the persistent Pi GM. */
export type GmProposal =
  | { kind: "record_fact"; text: string; roomId?: string }
  | { kind: "remove_fact"; text: string }
  | { kind: "set_exit"; roomId: string; direction: string; toRoomId: string }
  | { kind: "adjust_parameter"; entityId: string; parameterId: string; delta: number; cause: string }
  | { kind: "move_npc"; npcId: string; toRoomId: string }
  | { kind: "emit_signal"; signalId: string; roomId: string; message: string; targetId?: string }
  | { kind: "complete_objective"; objectiveId: string; reason?: string }
  | { kind: "reach_outcome"; outcome: ReachedOutcome; requestedAtTurn: number; reason?: string };

/** Complete bounded operation vocabulary exposed to Pi: GM rulings plus table cards/tokens. */
export type GmTableProposal = GmProposal | MovementProposal | ItemProposal;
