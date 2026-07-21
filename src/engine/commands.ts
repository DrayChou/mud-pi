// ─────────────────────────────────────────────────────────────
// commands.ts — verb → EngineMutation[]
// Pure logic, no I/O, no LLM.
// ─────────────────────────────────────────────────────────────

import type { WorldState } from "../types/world.ts";
import type { EngineMutation } from "../types/mutations.ts";
import type { ParsedCommand } from "../ai/interpreter.ts";
import type { CombatSimulationResult } from "./combat.ts";
import {
  defaultConflictResolver,
  validateCombatScriptResult,
  type ConflictResolver,
} from "./conflict-script.ts";
import { buildMapSnapshot, formatTextMap } from "./map.ts";
import {
  baseDeltaForEffectivePlayerChange,
  effectivePlayerStats,
  effectivePlayerTraits,
} from "./parameters.ts";

export type CombatContext = CombatSimulationResult;

export interface CommandResult {
  mutations: EngineMutation[];
  directReply?: string;
  combatContext?: CombatContext;
}

export function executeCommand(
  state: WorldState,
  cmd: ParsedCommand,
  conflictResolver: ConflictResolver = defaultConflictResolver
): CommandResult {
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
    case "use":    return cmdUse(state, cmd, conflictResolver);
    case "attack": return cmdAttack(state, cmd, conflictResolver);
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
  const item = state.items[itemId]!;
  if (item.kind !== "equipment" || !item.equipSlot) {
    return { mutations: [], directReply: `${item.name}不是可装备物品。` };
  }

  return { mutations: [{ kind: "engine/item_equipped", itemId, slot: item.equipSlot }] };
}

function cmdUse(state: WorldState, cmd: ParsedCommand, conflictResolver: ConflictResolver): CommandResult {
  const itemName = cmd.args.item;
  if (!itemName) return { mutations: [], directReply: "使用什么？" };
  const itemId = state.player.inventory.find((id) => {
    const item = state.items[id];
    return item && itemMatches(item, itemName);
  });
  if (!itemId) return { mutations: [], directReply: `背包里没有"${itemName}"。` };
  const item = state.items[itemId]!;
  if (!item.effects?.length) return { mutations: [], directReply: `${item.name}没有可以直接使用的效果。` };

  const useItem = conflictResolver.useItem ?? defaultConflictResolver.useItem!;
  const proposal = useItem({
    schema: structuredClone(state.schema),
    actor: structuredClone({
      ...state.player,
      stats: effectivePlayerStats(state),
      traits: effectivePlayerTraits(state),
    }),
    item: structuredClone(item),
    seed: `${state.worldId}:turn:${state.turn + 1}:item:${item.id}`,
    options: structuredClone(state.conflictOptions ?? {}),
  });
  const mutations: EngineMutation[] = [];
  for (const effect of proposal.parameterDeltas) {
    if (!state.schema.defs.some((def) => def.key === effect.parameterId)) {
      throw new Error(`Item script references unknown parameter: ${effect.parameterId}`);
    }
    if (!Number.isFinite(effect.delta)) throw new Error("Item script returned a non-finite parameter delta");
    const baseDelta = baseDeltaForEffectivePlayerChange(state, effect.parameterId, effect.delta);
    if (baseDelta !== 0) mutations.push({ kind: "engine/player_stat_changed", stat: effect.parameterId, delta: baseDelta });
  }
  if (proposal.consume) mutations.push({ kind: "engine/item_consumed", itemId: item.id });
  return mutations.length > 0
    ? { mutations }
    : { mutations: [], directReply: proposal.summary };
}

// ── Combat ─────────────────────────────────────────────────────────────────

function isContextualAttackTarget(target: string): boolean {
  return /^(他|它|她|怪物|敌人|对方|眼睛|头|头部|脑袋|要害|身体|躯干|爪子)$/.test(target.trim());
}

function selectExplicitWeapon(state: WorldState, cmd: ParsedCommand): WorldState["items"][string] | undefined {
  const requested = cmd.args.weapon?.trim();
  const firearmIntent = /开枪|射击|扣动扳机|瞄准/.test(cmd.raw);
  if (!requested && !firearmIntent) return undefined;
  return state.player.inventory
    .map((id) => state.items[id])
    .find((item) => item?.kind === "equipment" && item.equipSlot && (
      (requested && itemMatches(item, requested)) ||
      (firearmIntent && item.traits?.some((trait) => trait.code === "weapon_family" && trait.dataId === "firearm"))
    ));
}

function stateWithEquippedItem(state: WorldState, itemId: string): WorldState {
  const next = structuredClone(state);
  const item = next.items[itemId];
  if (!item?.equipSlot) return next;
  const replacedId = next.player.equipment[item.equipSlot];
  if (replacedId && replacedId !== itemId) {
    const replaced = next.items[replacedId];
    if (replaced) replaced.location = { kind: "inventory", ownerId: next.player.id };
    if (!next.player.inventory.includes(replacedId)) next.player.inventory.push(replacedId);
  }
  next.player.inventory = next.player.inventory.filter((id) => id !== itemId);
  next.player.equipment[item.equipSlot] = itemId;
  item.location = { kind: "equipped", ownerId: next.player.id, slot: item.equipSlot };
  return next;
}

function cmdAttack(state: WorldState, cmd: ParsedCommand, conflictResolver: ConflictResolver): CommandResult {
  const targetName = cmd.args.target;
  if (!targetName) return { mutations: [], directReply: "攻击什么？" };

  const roomNpcs = Object.values(state.npcs).filter(
    (npc) => npc.roomId === state.player.roomId && npc.alive
  );
  const explicitTarget = roomNpcs.find(
    (npc) => npc.name.includes(targetName) || npc.id.includes(targetName)
  );
  const hostileNpcs = roomNpcs.filter((npc) => npc.hostile);
  const npc = explicitTarget ?? (
    hostileNpcs.length === 1 && isContextualAttackTarget(targetName)
      ? hostileNpcs[0]
      : undefined
  );
  if (!npc) return { mutations: [], directReply: `这里没有"${targetName}"可以攻击。` };

  const selectedWeapon = selectExplicitWeapon(state, cmd);
  const combatState = selectedWeapon ? stateWithEquippedItem(state, selectedWeapon.id) : state;
  const conflictRules = state.conflictRules ?? { mode: "auto_combat", algorithm: "gauge-random-v1" as const };
  const combatSeed = `${state.worldId}:turn:${state.turn + 1}:combat:${npc.id}`;
  const combat = validateCombatScriptResult(conflictResolver.resolve({
    schema: structuredClone(state.schema),
    actor: structuredClone({
      ...state.player,
      stats: effectivePlayerStats(combatState),
      traits: effectivePlayerTraits(combatState),
    }),
    target: structuredClone(npc),
    rules: structuredClone(conflictRules),
    seed: combatSeed,
    options: structuredClone(state.conflictOptions ?? {}),
  }), state.player.id, npc.id);
  const mutations: EngineMutation[] = [];
  if (selectedWeapon && selectedWeapon.location.kind === "inventory" && selectedWeapon.equipSlot) {
    mutations.push({ kind: "engine/item_equipped", itemId: selectedWeapon.id, slot: selectedWeapon.equipSlot });
  }
  mutations.push({ kind: "engine/combat_started", npcId: npc.id });
  const npcDelta = combat.npc.poolAfter - combat.npc.poolBefore;
  const effectivePlayerDelta = combat.player.poolAfter - combat.player.poolBefore;
  const playerDelta = baseDeltaForEffectivePlayerChange(state, combat.poolKey, effectivePlayerDelta);
  if (npcDelta !== 0) {
    mutations.push({ kind: "engine/npc_stat_changed", npcId: npc.id, stat: combat.poolKey, delta: npcDelta });
  }
  if (playerDelta !== 0) {
    mutations.push({ kind: "engine/player_stat_changed", stat: combat.poolKey, delta: playerDelta });
  }
  if (combat.npc.poolAfter <= 0) mutations.push({ kind: "engine/npc_killed", npcId: npc.id });

  return { mutations, combatContext: combat };
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
  const effectiveStats = effectivePlayerStats(state);
  const statLines = state.schema.defs
    .filter((d) => d.display !== "hidden")
    .map((d) => {
      const cur = effectiveStats[d.key] ?? d.default;
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
  const poolStats = state.schema.defs
    .filter((d) => d.display !== "hidden")
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
  use <物品>     使用物品
  attack <目标>  攻击
  inv            查看背包
  status         查看状态（${poolStats}）
  objectives     查看当前目标与故事结果
  map            查看已探索地图
  help           显示帮助
  quit           保存并退出`,
  };
}
