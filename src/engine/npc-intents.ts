// ─────────────────────────────────────────────────────────────
// npc-intents.ts — validate independent NPC decisions against authority state
// ─────────────────────────────────────────────────────────────

import type { GameEvent } from "../types/events.ts";
import type { EngineMutation } from "../types/mutations.ts";
import type { NpcDecision, NpcPublicAction } from "../types/npc.ts";
import type { WorldState } from "../types/world.ts";
import { calculateDamage, resolveCombatSchema } from "./combat.ts";

export interface NpcIntentResult {
  mutations: EngineMutation[];
  action: NpcPublicAction;
}

const DIRECTION_MAP: Record<string, string> = {
  east: "east", e: "east", 东: "east",
  west: "west", w: "west", 西: "west",
  south: "south", s: "south", 南: "south",
  north: "north", n: "north", 北: "north",
  up: "up", u: "up", 上: "up",
  down: "down", d: "down", 下: "down",
};

export function executeNpcDecision(
  state: WorldState,
  decision: NpcDecision
): NpcIntentResult {
  const npc = state.npcs[decision.npcId];
  const name = npc?.name ?? decision.npcId;

  if (!npc || !npc.alive) {
    return failed(decision, name, "NPC 已不存在或死亡");
  }
  if (state.turn !== decision.context.requestedAtTurn) {
    return failed(decision, name, "决策对应的回合已经过期");
  }
  if (npc.roomId !== decision.context.roomId) {
    return failed(decision, name, "NPC 的位置已经变化");
  }

  const visibleNow = visibleEntityIds(state, npc.roomId);
  if (!sameIds(visibleNow, decision.context.visibleEntityIds)) {
    return failed(decision, name, "房间内角色已经变化");
  }

  switch (decision.intent.verb) {
    case "wait":
      return {
        mutations: [],
        action: { npcId: npc.id, npcName: name, verb: "wait", succeeded: true },
      };

    case "say":
      return {
        mutations: [],
        action: {
          npcId: npc.id,
          npcName: name,
          verb: "say",
          content: decision.intent.content,
          succeeded: true,
        },
      };

    case "move":
    case "flee": {
      const direction = normalizeDirection(decision.intent.direction);
      if (!direction) return failed(decision, name, "方向无效");

      const room = state.rooms[npc.roomId];
      const toRoomId = room?.exits[direction];
      if (!toRoomId || !state.rooms[toRoomId]) {
        return failed(decision, name, `${direction} 方向没有可用出口`, direction);
      }

      return {
        mutations: [{ kind: "engine/npc_moved", npcId: npc.id, toRoomId }],
        action: {
          npcId: npc.id,
          npcName: name,
          verb: decision.intent.verb,
          direction,
          fromRoomId: npc.roomId,
          toRoomId,
          succeeded: true,
        },
      };
    }

    case "attack": {
      if (decision.intent.targetId !== state.player.id) {
        return failed(decision, name, "第一版 NPC 战斗只能攻击同房间玩家");
      }
      if (npc.combatState === "surrendered") return failed(decision, name, "NPC 已经投降");
      if (state.player.roomId !== npc.roomId || state.player.lifecycle !== "active") {
        return failed(decision, name, "玩家不在可攻击状态或不在同一房间");
      }
      const combat = resolveCombatSchema(state.schema);
      const damage = calculateDamage(npc.stats, state.player.stats, combat, 3);
      return {
        mutations: [{ kind: "engine/player_stat_changed", stat: combat.poolKey, delta: -damage }],
        action: {
          npcId: npc.id,
          npcName: name,
          verb: "attack",
          targetId: state.player.id,
          damage,
          succeeded: true,
        },
      };
    }

    case "surrender":
      if (npc.combatState === "surrendered") return failed(decision, name, "NPC 已经投降");
      return {
        mutations: [{ kind: "engine/npc_surrendered", npcId: npc.id }],
        action: {
          npcId: npc.id,
          npcName: name,
          verb: "surrender",
          succeeded: true,
        },
      };
  }
}

export function buildRuleNpcDecisions(state: WorldState, events: GameEvent[]): NpcDecision[] {
  const decisions: NpcDecision[] = [];
  const selected = new Set<string>();
  for (const event of events) {
    if (event.kind !== "entity_attacked") continue;
    const npc = state.npcs[event.targetId];
    if (
      !npc || selected.has(npc.id) || !npc.alive || npc.controller !== "rule" ||
      npc.combatState === "surrendered" || npc.roomId !== state.player.roomId ||
      state.player.lifecycle !== "active"
    ) continue;
    selected.add(npc.id);
    decisions.push({
      npcId: npc.id,
      context: {
        requestedAtTurn: state.turn,
        roomId: npc.roomId,
        visibleEntityIds: visibleEntityIds(state, npc.roomId),
      },
      intent: { verb: "attack", targetId: state.player.id },
    });
  }
  return decisions;
}

export function visibleEntityIds(state: WorldState, roomId: string): string[] {
  const ids = Object.values(state.npcs)
    .filter((npc) => npc.alive && npc.roomId === roomId)
    .map((npc) => npc.id);
  if (state.player.roomId === roomId) ids.push(state.player.id);
  return ids.sort();
}

function failed(
  decision: NpcDecision,
  npcName: string,
  reason: string,
  direction?: string
): NpcIntentResult {
  return {
    mutations: [],
    action: {
      npcId: decision.npcId,
      npcName,
      verb: decision.intent.verb,
      content: decision.intent.verb === "say" ? decision.intent.content : undefined,
      direction: decision.intent.verb === "move" || decision.intent.verb === "flee"
        ? direction ?? decision.intent.direction
        : undefined,
      targetId: decision.intent.verb === "attack" ? decision.intent.targetId : undefined,
      succeeded: false,
      reason,
    },
  };
}

function normalizeDirection(value: string): string | undefined {
  return DIRECTION_MAP[value.trim().toLowerCase()];
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === [...b].sort()[index]);
}
