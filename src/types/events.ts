// Public, objective events derived from validated world mutations.
// Events describe what happened; they never mutate WorldState themselves.

export type GameEvent =
  | {
      kind: "player_moved";
      turn: number;
      actorId: string;
      fromRoomId: string;
      toRoomId: string;
      roomId: string;
    }
  | {
      kind: "player_spoke";
      turn: number;
      actorId: string;
      roomId: string;
      message: string;
      targetId?: string;
    }
  | {
      kind: "item_created";
      turn: number;
      itemId: string;
      roomId: string;
    }
  | {
      kind: "item_picked_up";
      turn: number;
      actorId: string;
      itemId: string;
      roomId: string;
    }
  | {
      kind: "item_dropped";
      turn: number;
      actorId: string;
      itemId: string;
      roomId: string;
    }
  | {
      kind: "entity_attacked";
      turn: number;
      targetId: string;
      roomId: string;
      stat: string;
      amount: number;
    }
  | {
      kind: "player_died" | "player_incapacitated";
      turn: number;
      actorId: string;
      roomId: string;
    }
  | {
      kind: "critical_npc_died";
      turn: number;
      npcId: string;
      roomId: string;
      deathPolicy: "continue" | "ai_evaluate" | "immediate_outcome";
      notes?: string;
    }
  | {
      kind: "entity_defeated";
      turn: number;
      entityId: string;
      roomId: string;
    }
  | {
      kind: "npc_surrendered";
      turn: number;
      npcId: string;
      roomId: string;
    }
  | {
      kind: "npc_moved";
      turn: number;
      npcId: string;
      fromRoomId: string;
      toRoomId: string;
      roomId: string;
    };
