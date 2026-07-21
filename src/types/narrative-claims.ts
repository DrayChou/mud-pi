export type NarrativeClaim =
  | { kind: "player_location"; roomId: string }
  | { kind: "entity_present"; entityId: string; roomId: string }
  | { kind: "exit_available"; roomId: string; direction: string; toRoomId: string }
  | { kind: "item_location"; itemId: string; locationKind: "room" | "inventory" | "equipped" | "destroyed"; roomId?: string; ownerId?: string }
  | { kind: "npc_lifecycle"; npcId: string; alive: boolean }
  | { kind: "outcome"; outcomeId: string };
