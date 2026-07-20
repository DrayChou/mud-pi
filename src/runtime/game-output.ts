import type { ReachedOutcome } from "../types/world.ts";

export type GameOutput =
  | { kind: "direct_reply"; text: string }
  | { kind: "narration"; text: string }
  | { kind: "objective_completed"; objectiveId: string; title: string }
  | { kind: "story_outcome"; outcome: ReachedOutcome }
  | { kind: "room_changed"; roomId: string };

export interface GameTurnResult {
  outputs: GameOutput[];
  quit: boolean;
  turnAdvanced: boolean;
}
