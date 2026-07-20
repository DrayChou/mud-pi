import type { CombatSimulationResult } from "../engine/combat.ts";
import type { ReachedOutcome } from "../types/world.ts";

export type GameOutput =
  | { kind: "direct_reply"; text: string }
  | { kind: "narration"; text: string }
  | { kind: "objective_completed"; objectiveId: string; title: string }
  | { kind: "story_outcome"; outcome: ReachedOutcome }
  | { kind: "room_changed"; roomId: string }
  | { kind: "combat_warning"; risk: "dangerous" | "likely_failure"; text: string }
  | { kind: "combat_result"; result: CombatSimulationResult };

export interface GameTurnResult {
  outputs: GameOutput[];
  quit: boolean;
  turnAdvanced: boolean;
}
