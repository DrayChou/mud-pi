// ─────────────────────────────────────────────────────────────
// mutations.ts — all state changes must be one of these
// ─────────────────────────────────────────────────────────────

import type { ItemDef, PlotStatus, ReachedOutcome, RoomDef, NpcDef } from "./world.ts";
import type { GameEvent } from "./events.ts";

// ── Engine Mutations ───────────────────────────────────────────────────────

export type EngineMutation =
  | { kind: "engine/player_moved"; toRoomId: string }
  | { kind: "engine/player_stat_changed"; stat: string; delta: number }
  | { kind: "engine/npc_moved"; npcId: string; toRoomId: string }
  | { kind: "engine/npc_stat_changed"; npcId: string; stat: string; delta: number }
  | { kind: "engine/npc_killed"; npcId: string }
  | { kind: "engine/combat_started"; npcId: string }
  | { kind: "engine/item_picked_up"; itemId: string }
  | { kind: "engine/item_dropped"; itemId: string; roomId: string }
  | { kind: "engine/item_equipped"; itemId: string; slot: string }
  | { kind: "engine/item_consumed"; itemId: string }
  | {
      kind: "engine/item_reward_granted";
      grantorNpcId: string;
      templateId: string;
      itemId: string;
      name: string;
      desc: string;
      aliases?: string[];
      requestedAtTurn: number;
    }
  | { kind: "engine/objective_completed"; objectiveId: string }
  | { kind: "engine/turn_advanced" };

// ── DM Mutations ───────────────────────────────────────────────────────────

export type DmMutation =
  | { kind: "dm/room_added"; room: RoomDef }
  | { kind: "dm/item_added"; item: ItemDef }
  | {
      kind: "dm/item_reward_granted";
      grantorNpcId?: string;
      templateId: string;
      itemId: string;
      name: string;
      desc: string;
      aliases?: string[];
      requestedAtTurn: number;
    }
  | { kind: "dm/outcome_reached"; outcome: ReachedOutcome; requestedAtTurn: number }
  | { kind: "dm/room_exit_added"; roomId: string; direction: string; toRoomId: string }
  | { kind: "dm/room_desc_updated"; roomId: string; descAppend: string }
  | { kind: "dm/npc_added"; npc: NpcDef }
  | { kind: "dm/npc_moved"; npcId: string; toRoomId: string }
  | { kind: "dm/npc_killed"; npcId: string }
  | { kind: "dm/npc_stat_changed"; npcId: string; stat: string; delta: number }
  | { kind: "dm/fact_added"; text: string; tile: string | null }
  | { kind: "dm/fact_removed"; text: string }
  | {
      kind: "dm/plot_updated";
      id: string;
      title?: string;
      status?: PlotStatus;
      summary?: string;
    };

export type AnyMutation = EngineMutation | DmMutation;

// ── Turn Record ────────────────────────────────────────────────────────────

export interface TurnRecord {
  turn: number;
  ts: number;
  playerInput: string;
  parsed: { verb: string; args: Record<string, string>; confidence: number };
  engineMutations: EngineMutation[];
  dmMutations: DmMutation[];
  gameEvents?: GameEvent[];
  npcActions?: Array<{
    npcId: string;
    npcName: string;
    verb: "say" | "move" | "give_item" | "wait";
    content?: string;
    direction?: string;
    fromRoomId?: string;
    toRoomId?: string;
    succeeded: boolean;
    reason?: string;
    itemId?: string;
    itemName?: string;
  }>;
  narration: string;
  dmModel: string;
}
