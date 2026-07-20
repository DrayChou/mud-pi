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
  | {
      verb: "give_item";
      content: string;
      templateId: string;
      itemId: string;
      name: string;
      desc: string;
      aliases?: string[];
      objectiveId?: string;
    }
  | { verb: "wait" };

export interface NpcDecision {
  npcId: string;
  context: NpcDecisionContext;
  intent: NpcIntent;
}

export interface NpcPublicAction {
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
}
