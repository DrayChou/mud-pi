import type {
  AppliedCondition,
  ItemDef,
  ItemLocation,
  NpcDef,
  PlotThread,
  ReachedOutcome,
  RoomDef,
  WorldFact,
} from "./world.ts";
import type { ProposalSource } from "./proposals.ts";

export interface PlayerMoved { kind: "player_moved"; playerId: string; fromRoomId: string; toRoomId: string }
export interface PlayerSpoke { kind: "player_spoke"; playerId: string; roomId: string; message: string; targetId?: string }
export interface RoomCreated { kind: "room_created"; room: RoomDef }
export interface RoomExitSet { kind: "room_exit_set"; roomId: string; direction: string; beforeToRoomId?: string; afterToRoomId: string }
export interface RoomDescriptionChanged { kind: "room_description_changed"; roomId: string; before: string; after: string }
export interface RoomExplorationRecorded { kind: "room_exploration_recorded"; roomId: string; discoveredBefore: boolean; discoveredAfter: true; visitedTurnBefore?: number; visitedTurnAfter: number }
export interface ItemCreated { kind: "item_created"; item: ItemDef }
export interface ItemTransferred { kind: "item_transferred"; itemId: string; from: ItemLocation; to: ItemLocation }
export interface ParameterChanged { kind: "parameter_changed"; entityId: string; parameterId: string; before: number; after: number; cause: string }
export interface LifecycleChanged { kind: "lifecycle_changed"; entityId: string; before: "active" | "incapacitated" | "dead"; after: "active" | "incapacitated" | "dead"; cause: string }
export interface NpcCreated { kind: "npc_created"; npc: NpcDef }
export interface NpcMoved { kind: "npc_moved"; npcId: string; fromRoomId: string; toRoomId: string }
export interface NpcDefeated { kind: "npc_defeated"; npcId: string; roomId: string }
export interface WorldFactAdded { kind: "world_fact_added"; fact: WorldFact }
export interface WorldFactRemoved { kind: "world_fact_removed"; fact: WorldFact }
export interface PlotThreadChanged { kind: "plot_thread_changed"; plotId: string; before?: PlotThread; after: PlotThread }
export interface ConflictStarted { kind: "conflict_started"; actorId: string; targetId: string; roomId: string }
export interface PerceptibleSignalEmitted { kind: "perceptible_signal_emitted"; signalId: string; roomId: string; message: string; targetId?: string }
export interface ConditionApplied { kind: "condition_applied"; condition: AppliedCondition }
export interface ConditionRefreshed { kind: "condition_refreshed"; key: string; before: AppliedCondition; after: AppliedCondition }
export interface ConditionStackChanged { kind: "condition_stack_changed"; key: string; before: AppliedCondition; after: AppliedCondition }
export interface ConditionRemoved { kind: "condition_removed"; key: string; condition: AppliedCondition; reason?: string }
export interface ConditionExpired { kind: "condition_expired"; key: string; condition: AppliedCondition; expiredAtTurn: number }
export interface ObjectiveCompleted { kind: "objective_completed"; objectiveId: string; completedTurn: number; reason?: string }
export interface StoryOutcomeReached { kind: "story_outcome_reached"; outcome: ReachedOutcome }
export interface TurnAdvanced { kind: "turn_advanced"; before: number; after: number }

export type WorldEvent =
  | PlayerMoved | PlayerSpoke | RoomCreated | RoomExitSet | RoomDescriptionChanged
  | RoomExplorationRecorded | ItemCreated | ItemTransferred | ParameterChanged
  | LifecycleChanged | NpcCreated | NpcMoved | NpcDefeated | WorldFactAdded
  | WorldFactRemoved | PlotThreadChanged | ConflictStarted | PerceptibleSignalEmitted
  | ConditionApplied | ConditionRefreshed | ConditionStackChanged | ConditionRemoved | ConditionExpired
  | ObjectiveCompleted | StoryOutcomeReached | TurnAdvanced;

export interface CommittedWorldEvent<TEvent extends WorldEvent = WorldEvent> {
  eventId: string;
  transactionId: string;
  index: number;
  revision: number;
  turn: number;
  source: ProposalSource;
  correlationId: string;
  causationId?: string;
  event: TEvent;
}
