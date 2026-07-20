// ─────────────────────────────────────────────────────────────
// dm-prompt.ts — build the per-turn prompt injected into Pi DM
// ─────────────────────────────────────────────────────────────

import type { StoryOutcomeDef, WorldState } from "../types/world.ts";
import type { EngineMutation, TurnRecord } from "../types/mutations.ts";
import type { CombatContext } from "../engine/commands.ts";
import type { NpcPublicAction } from "../types/npc.ts";
import type { GameEvent } from "../types/events.ts";

function describeMutation(m: EngineMutation): string | null {
  switch (m.kind) {
    case "engine/player_moved":      return `玩家移动到了 ${m.toRoomId}`;
    case "engine/player_stat_changed":
      return m.delta < 0 ? `玩家 ${m.stat} -${-m.delta}` : `玩家 ${m.stat} +${m.delta}`;
    case "engine/npc_moved":         return `NPC ${m.npcId} 移动到了 ${m.toRoomId}`;
    case "engine/npc_stat_changed":  return null; // covered by combatContext
    case "engine/npc_killed":        return null; // covered by combatContext
    case "engine/combat_started":    return null;
    case "engine/item_picked_up":    return `玩家拾取了 ${m.itemId}`;
    case "engine/item_dropped":      return `玩家丢弃了 ${m.itemId}`;
    case "engine/item_equipped":     return `玩家装备了 ${m.itemId}`;
    case "engine/objective_completed": return `玩家完成目标 ${m.objectiveId}`;
    case "engine/turn_advanced":     return null;
  }
}

// Format player stats for display, using schema labels
function describeGameEvent(event: GameEvent): string {
  switch (event.kind) {
    case "player_moved": return `玩家从 ${event.fromRoomId} 移动到 ${event.toRoomId}`;
    case "player_spoke": return `玩家在 ${event.roomId}${event.targetId ? ` 对 ${event.targetId}` : ""}说：“${event.message}”`;
    case "item_created": return `可交互道具 ${event.itemId} 出现在 ${event.roomId}`;
    case "item_picked_up": return `玩家在 ${event.roomId} 拾取了 ${event.itemId}`;
    case "item_dropped": return `玩家在 ${event.roomId} 丢下了 ${event.itemId}`;
    case "entity_attacked": return `${event.targetId} 的 ${event.stat} 受到 ${event.amount} 点损耗`;
    case "entity_defeated": return `${event.entityId} 在 ${event.roomId} 被击败`;
    case "player_died": return `玩家在 ${event.roomId} 死亡`;
    case "player_incapacitated": return `玩家在 ${event.roomId} 失去行动能力`;
    case "critical_npc_died": return `关键 NPC ${event.npcId} 死亡；策略=${event.deathPolicy}${event.notes ? `；说明=${event.notes}` : ""}`;
    case "npc_moved": return `NPC ${event.npcId} 从 ${event.fromRoomId} 移动到 ${event.toRoomId}`;
  }
}

function formatPlayerStats(state: WorldState): string {
  const parts: string[] = [];
  for (const def of state.schema.defs) {
    if (def.display === "hidden") continue;
    const cur = state.player.stats[def.key] ?? def.default;
    const max = state.player.maxStats[`${def.key}Max`] ?? def.max;
    parts.push(def.display === "bar" ? `${def.label}: ${cur}/${max}` : `${def.label}: ${cur}`);
  }
  return parts.join(" | ");
}

export function buildDmRecoveryPrompt(
  state: WorldState,
  recentTurns: TurnRecord[]
): string {
  const room = state.rooms[state.player.roomId];
  const facts = state.worldFacts.map((f) => `• ${f.text}`).join("\n") || "（无）";
  const plots = Object.values(state.plotThreads)
    .filter((p) => p.status === "active")
    .map((p) => `• ${p.title}：${p.summary}`)
    .join("\n") || "（无）";
  const history = recentTurns
    .map((t) => {
      const npcLines = t.npcActions?.map((a) =>
        a.verb === "say"
          ? `${a.npcName}说：“${a.content}”`
          : a.verb === "move"
            ? a.succeeded
              ? `${a.npcName}向${a.direction}移动到${a.toRoomId}`
              : `${a.npcName}移动失败：${a.reason}`
            : `${a.npcName}保持沉默`
      ).join("；");
      return `第 ${t.turn} 轮｜玩家：${t.playerInput}${npcLines ? `\nNPC：${npcLines}` : ""}\n叙事：${t.narration}`;
    })
    .join("\n\n") || "（没有可用的历史轮次）";

  return `[会话恢复]
你正在恢复一局已经进行中的文字 MUD。此前的 Pi DM session 不可用，下面的信息是当前权威状态和最近历史。
不要重新开场，不要推进回合，不要创建或修改任何世界内容。只在内部吸收这些信息，并严格回复：SESSION_RECOVERED

[当前回合]
${state.turn}

[主角]
${state.player.name}${state.player.profile ? `：${state.player.profile.summary}\n背景：${state.player.profile.background}\n动机：${state.player.profile.motivation}` : ""}

[当前位置]
${room ? `${room.title}（${room.id}）\n${room.desc}` : state.player.roomId}

[世界事实]
${facts}

[活跃剧情线]
${plots}

[最近轮次]
${history}`;
}

export function buildDmPrompt(
  state: WorldState,
  playerInput: string,
  engineMutations: EngineMutation[],
  combatContext?: CombatContext,
  npcActions: NpcPublicAction[] = [],
  outcomes: StoryOutcomeDef[] = [],
  gameEvents: GameEvent[] = []
): string {
  const room = state.rooms[state.player.roomId];
  const parts: string[] = [];

  // ── World facts ──
  const visibleFacts = state.worldFacts.filter(
    (f) => f.tile === null || f.tile === state.player.roomId
  );
  if (visibleFacts.length > 0) {
    parts.push("[世界事实]\n" + visibleFacts.map((f) => `• ${f.text}`).join("\n"));
  }

  // ── Objectives and story outcomes ──
  const visibleObjectives = Object.values(state.objectives).filter(
    (objective) => !objective.hidden || objective.status === "completed"
  );
  if (visibleObjectives.length > 0) {
    parts.push(
      "[目标进度]\n" +
      visibleObjectives.map((objective) =>
        `• ${objective.status === "completed" ? "✓" : "○"} ${objective.title}：${objective.description}`
      ).join("\n")
    );
  }
  if (state.outcome) {
    parts.push(`[已达成故事结果]\n${state.outcome.title}：${state.outcome.summary}`);
  } else if (outcomes.length > 0) {
    parts.push(
      `[剧本可用故事结果]\n` +
      outcomes.map((outcome) =>
        `• ${outcome.title}（id: ${outcome.id}，类型: ${outcome.type}，终止游戏: ${outcome.terminal ? "是" : "否"}）\n  判定标准：${outcome.criteria}\n  结果摘要：${outcome.summary}`
      ).join("\n") +
      `\n结果判定由你依据上述剧本标准完成。只有标准已经明确满足时才返回 outcomeReached；不满足时必须返回 null。若本轮触发结果，NARRATION 必须作为与该结果一致的收束叙事。`
    );
  }

  // ── Active plot threads ──
  const activePlots = Object.values(state.plotThreads).filter((p) => p.status === "active");
  if (activePlots.length > 0) {
    parts.push("[活跃剧情线]\n" + activePlots.map((p) => `• 🔴 ${p.title}：${p.summary}`).join("\n"));
  }

  // ── Critical NPC state ──
  const criticalNpcs = Object.values(state.npcs).filter(
    (npc) => npc.storyRole?.importance === "critical"
  );
  if (criticalNpcs.length > 0) {
    parts.push(
      `[关键 NPC 状态]\n` +
      criticalNpcs.map((npc) =>
        `• ${npc.name}（${npc.id}）：${npc.alive ? "存活" : "已死亡"}；死亡策略=${npc.storyRole?.deathPolicy ?? "ai_evaluate"}${npc.storyRole?.notes ? `；剧本说明=${npc.storyRole.notes}` : ""}`
      ).join("\n") +
      `\n关键 NPC 死亡不一定自动结束故事。依据剧本说明判断是继续原路线、转入替代路线，还是提出某个 StoryOutcome。`
    );
  }

  // ── Current room ──
  if (room) {
    const exits = Object.entries(room.exits).map(([d, id]) => `${d} → ${id}`).join("，");
    const npcsHere = Object.values(state.npcs).filter(
      (n) => n.roomId === state.player.roomId && n.alive
    );
    const npcLines = npcsHere.map((n) => {
      const poolDef = state.schema.defs.find((d) => d.role === "pool" && d.onDeplete !== "narrative");
      const poolKey = poolDef?.key;
      const statStr = poolKey
        ? ` (${poolDef!.label}: ${n.stats[poolKey] ?? 0}/${n.maxStats[`${poolKey}Max`] ?? poolDef!.max})`
        : "";
      return `  ${n.name}${statStr}`;
    });
    const npcBlock = npcsHere.length > 0 ? `\n在场:\n${npcLines.join("\n")}` : "";
    const itemsHere = Object.values(state.items).filter(
      (item) => item.location.kind === "room" && item.location.roomId === room.id
    );
    const itemBlock = itemsHere.length > 0
      ? `\n地面物品:\n${itemsHere.map((item) => `  ${item.name}（${item.id}）：${item.desc}${item.portable === false ? " [不可携带]" : ""}`).join("\n")}`
      : "";
    const proceduralRole = state.generation?.roomRoles[room.id];
    const generationBlock = proceduralRole
      ? `\n程序化语义角色：${proceduralRole}（这是 Engine 已分配的叙事功能，不代表自动生成实体）`
      : "";
    parts.push(`[当前房间]\n位置：${room.title}（${room.id}）\n${room.desc}\n出口：${exits || "无"}${generationBlock}${npcBlock}${itemBlock}`);
  }

  // ── Protagonist profile ──
  if (state.player.profile) {
    const p = state.player.profile;
    parts.push(
      `[主角设定]\n` +
        `姓名：${state.player.name}\n` +
        `身份概括：${p.summary}\n` +
        `背景：${p.background}\n` +
        `动机：${p.motivation}` +
        (p.openingHook ? `\n开场钩子：${p.openingHook}` : "")
    );
  }

  // ── Player state ──
  const inventoryItems = state.player.inventory.map((id) => state.items[id]).filter((item) => item !== undefined);
  const inv = inventoryItems.map((item) => item.name).join("，");
  parts.push(`[玩家状态]\n姓名：${state.player.name}\n生命阶段：${state.player.lifecycle}\n${formatPlayerStats(state)} | 背包: [${inv || "空"}]`);
  if (inventoryItems.length > 0) {
    parts.push(`[背包物品详情]\n${inventoryItems.map((item) => `• ${item.name}（${item.id}）：${item.desc}`).join("\n")}`);
  }

  // ── Combat context ──
  if (combatContext) {
    const { npcName, playerDealt, npcDealt, npcKilled, attackStat, npcStatAfter, npcStatMax, playerStatAfter, playerStatMax } = combatContext;
    const statDef = state.schema.defs.find((d) => d.key === attackStat);
    const statLabel = statDef?.label ?? attackStat;
    const npcStatus = npcKilled
      ? `${npcName} 已被击败`
      : `${npcName} 剩余 ${statLabel}: ${npcStatAfter}/${npcStatMax}`;
    const counterLine = npcDealt > 0
      ? `\n${npcName} 反击，玩家 ${statLabel} ${playerStatAfter}/${playerStatMax}`
      : "";
    parts.push(`[战斗结果]\n玩家对 ${npcName} 造成 ${playerDealt} 点${statLabel}损耗${counterLine}\n${npcStatus}`);
  }

  // ── Other engine events ──
  const eventLines = engineMutations.map(describeMutation).filter((s): s is string => s !== null);
  if (!combatContext) {
    parts.push(`[玩家行动]\n${playerInput}\n\n[本轮结果]\n${eventLines.length > 0 ? eventLines.join("\n") : "（无特殊事件）"}`);
  } else {
    parts.push(`[玩家行动]\n${playerInput}`);
  }

  // ── Independent NPC actions ──
  if (npcActions.length > 0) {
    const lines = npcActions.map((action) =>
      action.verb === "say"
        ? `- ${action.npcName}说：“${action.content}”`
        : action.verb === "move"
          ? action.succeeded
            ? `- ${action.npcName}从 ${action.fromRoomId} 向 ${action.direction} 移动到 ${action.toRoomId}`
            : `- ${action.npcName}尝试向 ${action.direction} 移动，但失败：${action.reason}`
          : `- ${action.npcName}保持沉默`
    );
    parts.push(
      `[独立 NPC 的已确定行动]\n${lines.join("\n")}\n这些行动来自 NPC 自己的长期 Pi Session。你只能叙述其公开结果，不得改写台词或替它决定其他行动。`
    );
  }

  // ── Authoritative events already settled this turn ──
  if (gameEvents.length > 0) {
    parts.push(
      `[本轮已结算事件]\n${gameEvents.map((event) => `• ${describeGameEvent(event)}`).join("\n")}\n这些事件和上方目标进度已经写入权威状态；不得否认或改写。`
    );
  }

  // ── Task ──
  parts.push(
`[你的任务]
用第二人称为玩家描述本轮体验（2-4句，沉浸式，不超过120字）。
如有必要，更新世界事实、剧情线、或创造新房间/NPC。
如果叙事中新出现了玩家可以检查、拾取或使用的具体道具，必须把它写入 itemsAdded。不要只在叙事中提到而不注册。
itemsAdded 格式：{"id":"稳定的英文或拼音ID","name":"显示名","desc":"可检查描述","aliases":["玩家可能使用的简称或同义词"],"roomId":"当前房间ID","portable":true}。
严格按以下格式返回：

<NARRATION>
（给玩家看的叙事文字）
</NARRATION>
<WORLD_UPDATE>
{
  "worldFacts": [],
  "factsRemoved": [],
  "plotThreads": [],
  "roomsAdded": [],
  "exitsAdded": [],
  "roomDescUpdates": [],
  "itemsAdded": [],
  "npcsAdded": [],
  "npcsMoved": [],
  "npcsKilled": [],
  "outcomeReached": null
}
</WORLD_UPDATE>`
  );

  return parts.join("\n\n");
}
