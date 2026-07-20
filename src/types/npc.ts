// ─────────────────────────────────────────────────────────────
// npc.ts — independent NPC perceptions, intents, and public results
// ─────────────────────────────────────────────────────────────

export interface NpcDecisionContext {
  requestedAtTurn: number;
  roomId: string;
  visibleEntityIds: string[];
}

export type NpcIntent =
  | { verb: "say"; content: string }
  | { verb: "move"; direction: string }
  | { verb: "attack"; targetId: string }
  | { verb: "flee"; direction: string }
  | { verb: "surrender" }
  | { verb: "wait" };

export interface NpcDecision {
  npcId: string;
  context: NpcDecisionContext;
  intent: NpcIntent;
}

export interface NpcPublicAction {
  npcId: string;
  npcName: string;
  verb: "say" | "move" | "attack" | "flee" | "surrender" | "wait";
  content?: string;
  direction?: string;
  fromRoomId?: string;
  toRoomId?: string;
  targetId?: string;
  damage?: number;
  succeeded: boolean;
  reason?: string;
}
