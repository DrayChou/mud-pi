import type { AnyMutation } from "../types/mutations.ts";
import type { GameEvent } from "../types/events.ts";
import type { WorldState } from "../types/world.ts";

export interface GameEventContext {
  playerSpeech?: {
    message: string;
    targetId?: string;
  };
}

/**
 * Derive public facts from already validated mutations.
 * The function is pure: it does not mutate either state snapshot.
 */
export function deriveGameEvents(
  before: WorldState,
  mutations: AnyMutation[],
  after: WorldState,
  context: GameEventContext = {}
): GameEvent[] {
  const events: GameEvent[] = [];
  const turn = before.turn + 1;

  if (context.playerSpeech?.message.trim()) {
    events.push({
      kind: "player_spoke",
      turn,
      actorId: before.player.id,
      roomId: before.player.roomId,
      message: context.playerSpeech.message.trim(),
      targetId: context.playerSpeech.targetId,
    });
  }

  for (const mutation of mutations) {
    switch (mutation.kind) {
      case "engine/player_moved":
        if (after.player.roomId !== mutation.toRoomId) break;
        events.push({
          kind: "player_moved",
          turn,
          actorId: before.player.id,
          fromRoomId: before.player.roomId,
          toRoomId: mutation.toRoomId,
          roomId: mutation.toRoomId,
        });
        break;

      case "engine/item_picked_up": {
        const location = before.items[mutation.itemId]?.location;
        const afterLocation = after.items[mutation.itemId]?.location;
        if (
          location?.kind !== "room" ||
          (afterLocation?.kind !== "inventory" && afterLocation?.kind !== "equipped") ||
          afterLocation.ownerId !== after.player.id
        ) break;
        events.push({
          kind: "item_picked_up",
          turn,
          actorId: before.player.id,
          itemId: mutation.itemId,
          roomId: location.roomId,
        });
        break;
      }

      case "engine/item_dropped": {
        const location = after.items[mutation.itemId]?.location;
        if (location?.kind !== "room" || location.roomId !== mutation.roomId) break;
        events.push({
          kind: "item_dropped",
          turn,
          actorId: before.player.id,
          itemId: mutation.itemId,
          roomId: mutation.roomId,
        });
        break;
      }

      case "engine/npc_stat_changed":
      case "dm/npc_stat_changed": {
        if (mutation.delta >= 0) break;
        const npcBefore = before.npcs[mutation.npcId];
        const npc = npcBefore ?? after.npcs[mutation.npcId];
        if (
          !npc ||
          (npcBefore && after.npcs[mutation.npcId]?.stats[mutation.stat] === npcBefore.stats[mutation.stat])
        ) break;
        events.push({
          kind: "entity_attacked",
          turn,
          targetId: mutation.npcId,
          roomId: npc.roomId,
          stat: mutation.stat,
          amount: -mutation.delta,
        });
        break;
      }

      case "engine/player_stat_changed": {
        if (
          mutation.delta >= 0 ||
          after.player.stats[mutation.stat] === before.player.stats[mutation.stat]
        ) break;
        events.push({
          kind: "entity_attacked",
          turn,
          targetId: before.player.id,
          roomId: before.player.roomId,
          stat: mutation.stat,
          amount: -mutation.delta,
        });
        break;
      }

      case "engine/npc_killed":
      case "dm/npc_killed": {
        const npc = before.npcs[mutation.npcId] ?? after.npcs[mutation.npcId];
        if (!npc || after.npcs[mutation.npcId]?.alive !== false) break;
        events.push({
          kind: "entity_defeated",
          turn,
          entityId: mutation.npcId,
          roomId: npc.roomId,
        });
        break;
      }

      case "engine/npc_moved":
      case "dm/npc_moved": {
        const fromRoomId = before.npcs[mutation.npcId]?.roomId;
        if (!fromRoomId || after.npcs[mutation.npcId]?.roomId !== mutation.toRoomId) break;
        events.push({
          kind: "npc_moved",
          turn,
          npcId: mutation.npcId,
          fromRoomId,
          toRoomId: mutation.toRoomId,
          roomId: mutation.toRoomId,
        });
        break;
      }
    }
  }

  return events;
}
