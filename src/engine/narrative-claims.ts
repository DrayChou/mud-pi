import type { NarrativeClaim } from "../types/narrative-claims.ts";
import type { WorldState } from "../types/world.ts";

export interface NarrativeClaimIssue {
  claim: NarrativeClaim;
  message: string;
}

function entityRoom(state: WorldState, entityId: string): string | undefined {
  if (entityId === state.player.id) return state.player.roomId;
  const npc = state.npcs[entityId];
  if (npc?.alive) return npc.roomId;
  const item = state.items[entityId];
  if (item?.location.kind === "room") return item.location.roomId;
  return undefined;
}

export function validateNarrativeClaims(state: WorldState, claims: readonly NarrativeClaim[]): NarrativeClaimIssue[] {
  const issues: NarrativeClaimIssue[] = [];
  for (const claim of claims) {
    let valid = false;
    switch (claim.kind) {
      case "player_location":
        valid = state.player.roomId === claim.roomId;
        break;
      case "entity_present":
        valid = entityRoom(state, claim.entityId) === claim.roomId;
        break;
      case "exit_available":
        valid = state.rooms[claim.roomId]?.exits[claim.direction] === claim.toRoomId;
        break;
      case "item_location": {
        const location = state.items[claim.itemId]?.location;
        valid = Boolean(location && location.kind === claim.locationKind
          && (claim.roomId === undefined || (location.kind === "room" && location.roomId === claim.roomId))
          && (claim.ownerId === undefined || ((location.kind === "inventory" || location.kind === "equipped") && location.ownerId === claim.ownerId)));
        break;
      }
      case "npc_lifecycle":
        valid = state.npcs[claim.npcId]?.alive === claim.alive;
        break;
      case "outcome":
        valid = state.outcome?.id === claim.outcomeId;
        break;
    }
    if (!valid) issues.push({ claim, message: `Narrative claim is not supported by committed state: ${JSON.stringify(claim)}` });
  }
  return issues;
}
