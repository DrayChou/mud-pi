// ─────────────────────────────────────────────────────────────
// dm-prompt.ts — build the per-turn prompt injected into Pi DM
// ─────────────────────────────────────────────────────────────

import type { WorldState } from "../types/world.ts";
import type { EngineMutation } from "../types/mutations.ts";
import type { CombatContext } from "../engine/commands.ts";

function describeMutation(m: EngineMutation): string | null {
  switch (m.kind) {
    case "engine/player_moved":      return `玩家移动到了 ${m.toRoomId}`;
    case "engine/player_stat_changed":
      return m.delta < 0 ? `玩家 ${m.stat} -${-m.delta}` : `玩家 ${m.stat} +${m.delta}`;
    case "engine/npc_stat_changed":  return null; // covered by combatContext
    case "engine/npc_killed":        return null; // covered by combatContext
    case "engine/combat_started":    return null;
    case "engine/item_picked_up":    return `玩家拾取了 ${m.itemId}`;
    case "engine/item_dropped":      return `玩家丢弃了 ${m.itemId}`;
    case "engine/item_equipped":     return `玩家装备了 ${m.itemId}`;
    case "engine/turn_advanced":     return null;
  }
}

// Format player stats for display, using schema labels
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

export function buildDmPrompt(
  state: WorldState,
  playerInput: string,
  engineMutations: EngineMutation[],
  combatContext?: CombatContext
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

  // ── Active plot threads ──
  const activePlots = Object.values(state.plotThreads).filter((p) => p.status === "active");
  if (activePlots.length > 0) {
    parts.push("[活跃剧情线]\n" + activePlots.map((p) => `• 🔴 ${p.title}：${p.summary}`).join("\n"));
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
    parts.push(`[当前房间]\n位置：${room.title}（${room.id}）\n${room.desc}\n出口：${exits || "无"}${npcBlock}`);
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
  const inv = state.player.inventory.map((id) => state.items[id]?.name ?? id).join("，");
  parts.push(`[玩家状态]\n姓名：${state.player.name}\n${formatPlayerStats(state)} | 背包: [${inv || "空"}]`);

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

  // ── Task ──
  parts.push(
`[你的任务]
用第二人称为玩家描述本轮体验（2-4句，沉浸式，不超过120字）。
如有必要，更新世界事实、剧情线、或创造新房间/NPC。
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
  "npcsAdded": [],
  "npcsMoved": [],
  "npcsKilled": []
}
</WORLD_UPDATE>`
  );

  return parts.join("\n\n");
}
