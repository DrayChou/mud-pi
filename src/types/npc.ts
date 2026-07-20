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
  | { verb: "wait" };

export interface NpcDecision {
  npcId: string;
  context: NpcDecisionContext;
  intent: NpcIntent;
}

export interface NpcPublicAction {
  npcId: string;
  npcName: string;
  verb: "say" | "move" | "wait";
  content?: string;
  direction?: string;
  fromRoomId?: string;
  toRoomId?: string;
  succeeded: boolean;
  reason?: string;
}
