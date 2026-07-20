// ─────────────────────────────────────────────────────────────
// commands.ts — verb → EngineMutation[]
// Pure logic, no I/O, no LLM.
// ─────────────────────────────────────────────────────────────

import type { WorldState, StatDef } from "../types/world.ts";
import type { EngineMutation } from "../types/mutations.ts";
import type { ParsedCommand } from "../ai/interpreter.ts";
import { buildMapSnapshot, formatTextMap } from "./map.ts";

export interface CombatContext {
  npcId: string;
  npcName: string;
  playerDealt: number;
  npcDealt: number;
  npcKilled: boolean;
  // stat snapshots for DM narration — schema-driven
  attackStat: string;   // which stat was used (e.g. "hp", "san")
  npcStatAfter: number;
  npcStatMax: number;
  playerStatAfter: number;
  playerStatMax: number;
}

export interface CommandResult {
  mutations: EngineMutation[];
  directReply?: string;
  combatContext?: CombatContext;
}

export function executeCommand(state: WorldState, cmd: ParsedCommand): CommandResult {
  const informational = new Set(["look", "inv", "status", "objectives", "map", "help", "quit"]);
  if (state.outcome?.terminal && !informational.has(cmd.verb)) {
    return { mutations: [], directReply: "这个故事已经结束。你仍可以查看状态、目标或退出。" };
  }
  if (state.player.lifecycle !== "active" && !informational.has(cmd.verb) && cmd.verb !== "say") {
    return {
      mutations: [],
      directReply: state.player.lifecycle === "dead"
        ? "你已经死亡，无法进行这个行动。"
        : "你目前失去行动能力。",
    };
  }

  switch (cmd.verb) {
    case "look":   return { mutations: [] };
    case "go":     return cmdGo(state, cmd);
    case "get":    return cmdGet(state, cmd);
    case "drop":   return cmdDrop(state, cmd);
    case "equip":  return cmdEquip(state, cmd);
    case "attack": return cmdAttack(state, cmd);
    case "inv":    return cmdInv(state);
    case "status": return cmdStatus(state);
    case "objectives": return cmdObjectives(state);
    case "map":    return { mutations: [], directReply: formatTextMap(buildMapSnapshot(state)) };
    case "help":   return cmdHelp(state);
    case "say":    return { mutations: [] };
    case "quit":   return { mutations: [], directReply: "__QUIT__" };
    default:       return { mutations: [] };
  }
}

// ── Movement ───────────────────────────────────────────────────────────────

function cmdGo(state: WorldState, cmd: ParsedCommand): CommandResult {
  const dir = cmd.args.direction;
  if (!dir) return { mutations: [], directReply: "往哪里走？" };

  const room = state.rooms[state.player.roomId];
  if (!room) return { mutations: [], directReply: "你身处虚空之中。" };

  const toRoomId = room.exits[dir];
  if (!toRoomId) return { mutations: [], directReply: `${dir} 方向没有出路。` };
  if (!state.rooms[toRoomId]) return { mutations: [], directReply: "那条路通向虚无。" };

  return { mutations: [{ kind: "engine/player_moved", toRoomId }] };
}

// ── Items ──────────────────────────────────────────────────────────────────

function itemMatches(item: WorldState["items"][string], query: string): boolean {
  const terms = [item.id, item.name, ...(item.aliases ?? [])];
  return terms.some((term) => term.includes(query) || query.includes(term));
}

function cmdGet(state: WorldState, cmd: ParsedCommand): CommandResult {
  const itemName = cmd.args.item;
  if (!itemName) return { mutations: [], directReply: "拾取什么？" };

  const matchingItems = Object.values(state.items).filter((item) => itemMatches(item, itemName));
  const item = matchingItems.find(
    (i) => i.location.kind === "room" && i.location.roomId === state.player.roomId
  );
  if (!item) {
    const owned = matchingItems.some(
      (i) =>
        (i.location.kind === "inventory" || i.location.kind === "equipped") &&
        i.location.ownerId === state.player.id
    );
    return owned
      ? { mutations: [], directReply: "你已经拿着它了。" }
      : { mutations: [] }; // Let the DM resolve narrative objects that are not registered yet.
  }
  if (item.portable === false) {
    return { mutations: [], directReply: `${item.name}无法被拿走。` };
  }

  return { mutations: [{ kind: "engine/item_picked_up", itemId: item.id }] };
}

function cmdDrop(state: WorldState, cmd: ParsedCommand): CommandResult {
  const itemName = cmd.args.item;
  if (!itemName) return { mutations: [], directReply: "丢弃什么？" };

  const itemId = state.player.inventory.find((id) => {
    const item = state.items[id];
    return item && itemMatches(item, itemName);
  });
  if (!itemId) return { mutations: [], directReply: `背包里没有"${itemName}"。` };

  return {
    mutations: [{ kind: "engine/item_dropped", itemId, roomId: state.player.roomId }],
  };
}

function cmdEquip(state: WorldState, cmd: ParsedCommand): CommandResult {
  const itemName = cmd.args.item;
  if (!itemName) return { mutations: [], directReply: "装备什么？" };

  const itemId = state.player.inventory.find((id) => {
    const item = state.items[id];
    return item && itemMatches(item, itemName);
  });
  if (!itemId) return { mutations: [], directReply: `背包里没有"${itemName}"。` };
  if (state.items[itemId]?.location.kind === "equipped") {
    return { mutations: [], directReply: "你已经装备着它了。" };
  }

  return { mutations: [{ kind: "engine/item_equipped", itemId, slot: "weapon" }] };
}

// ── Combat ─────────────────────────────────────────────────────────────────

function cmdAttack(state: WorldState, cmd: ParsedCommand): CommandResult {
  const targetName = cmd.args.target;
  if (!targetName) return { mutations: [], directReply: "攻击什么？" };

  const npc = Object.values(state.npcs).find(
    (n) =>
      n.roomId === state.player.roomId &&
      n.alive &&
      (n.name.includes(targetName) || n.id.includes(targetName))
  );
  if (!npc) return { mutations: [], directReply: `这里没有"${targetName}"可以攻击。` };

  // Resolve which stat is the "damage pool" (role=pool + onDeplete=death/incapacitate)
  const poolDef = state.schema.defs.find(
    (d) => d.role === "pool" && d.onDeplete !== "narrative"
  );
  const attackDef = state.schema.defs.find((d) => d.role === "attack");
  const defenseDef = state.schema.defs.find((d) => d.role === "defense");

  const poolKey = poolDef?.key ?? "hp";
  const attackKey = attackDef?.key ?? poolKey;
  const defenseKey = defenseDef?.key ?? "";

  // Player hits NPC
  const playerAttack = state.player.stats[attackKey] ?? 5;
  const npcDefense = defenseKey ? (npc.stats[defenseKey] ?? 0) : 0;
  const playerDealt = Math.max(1, playerAttack - npcDefense);

  const npcPoolCur = npc.stats[poolKey] ?? 0;
  const npcPoolAfter = Math.max(0, npcPoolCur - playerDealt);
  const npcKilled = npcPoolAfter <= 0;

  const mutations: EngineMutation[] = [
    { kind: "engine/npc_stat_changed", npcId: npc.id, stat: poolKey, delta: -playerDealt },
  ];
  if (npcKilled) mutations.push({ kind: "engine/npc_killed", npcId: npc.id });

  // NPC counter-attacks if still alive
  let npcDealt = 0;
  if (!npcKilled) {
    const npcAttack = npc.stats[attackKey] ?? 3;
    const playerDefense = defenseKey ? (state.player.stats[defenseKey] ?? 0) : 0;
    npcDealt = Math.max(1, npcAttack - playerDefense);
    mutations.push({
      kind: "engine/player_stat_changed",
      stat: poolKey,
      delta: -npcDealt,
    });
  }

  const playerPoolMax = state.player.maxStats[`${poolKey}Max`] ?? poolDef?.max ?? 100;
  const playerPoolAfter = Math.max(
    0,
    (state.player.stats[poolKey] ?? 0) - npcDealt
  );

  return {
    mutations,
    combatContext: {
      npcId: npc.id,
      npcName: npc.name,
      playerDealt,
      npcDealt,
      npcKilled,
      attackStat: poolKey,
      npcStatAfter: npcPoolAfter,
      npcStatMax: npc.maxStats[`${poolKey}Max`] ?? poolDef?.max ?? 20,
      playerStatAfter: playerPoolAfter,
      playerStatMax: playerPoolMax,
    },
  };
}

// ── Info commands ──────────────────────────────────────────────────────────

function cmdInv(state: WorldState): CommandResult {
  const items = state.player.inventory.map((id) => {
    const item = state.items[id];
    return `  • ${item?.name ?? id}`;
  });
  return {
    mutations: [],
    directReply: items.length === 0 ? "背包空空如也。" : "背包里有：\n" + items.join("\n"),
  };
}

function cmdStatus(state: WorldState): CommandResult {
  const p = state.player;
  // Show all visible pool stats
  const statLines = state.schema.defs
    .filter((d) => d.display !== "hidden" && d.role === "pool")
    .map((d) => {
      const cur = p.stats[d.key] ?? d.default;
      const max = p.maxStats[`${d.key}Max`] ?? d.max;
      return d.display === "bar"
        ? `  ${d.label}: ${cur}/${max}`
        : `  ${d.label}: ${cur}`;
    });

  const equipped = Object.entries(p.equipment)
    .map(([slot, id]) => `  ${slot}: ${state.items[id]?.name ?? id}`)
    .join("\n");

  return {
    mutations: [],
    directReply:
      `${p.name}\n` +
      statLines.join("\n") +
      (equipped ? `\n装备:\n${equipped}` : ""),
  };
}

function cmdObjectives(state: WorldState): CommandResult {
  const visible = Object.values(state.objectives).filter(
    (objective) => !objective.hidden || objective.status === "completed"
  );
  const lines = visible.map((objective) =>
    `${objective.status === "completed" ? "✓" : "○"} ${objective.title}\n  ${objective.description}`
  );
  const outcome = state.outcome
    ? `\n\n故事结果：${state.outcome.title}\n${state.outcome.summary}`
    : "";
  return {
    mutations: [],
    directReply: (lines.length > 0 ? `当前目标：\n${lines.join("\n")}` : "当前没有明确目标。") + outcome,
  };
}

function cmdHelp(state: WorldState): CommandResult {
  // Build stat display hint from schema
  const poolStats = state.schema.defs
    .filter((d) => d.role === "pool" && d.display !== "hidden")
    .map((d) => d.label)
    .join("、");

  return {
    mutations: [],
    directReply: `可用指令：
  look [目标]    查看周围或物品
  go <方向>      移动（东/西/南/北）
  say <内容>     说话
  get <物品>     拾取
  drop <物品>    丢弃
  equip <物品>   装备
  attack <目标>  攻击
  inv            查看背包
  status         查看状态（${poolStats}）
  objectives     查看当前目标与故事结果
  map            查看已探索地图
  help           显示帮助
  quit           保存并退出`,
  };
}
