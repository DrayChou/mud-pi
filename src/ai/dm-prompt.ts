// ─────────────────────────────────────────────────────────────
// dm-prompt.ts — build the per-turn prompt injected into Pi DM
// ─────────────────────────────────────────────────────────────

import type { ItemDef, StoryOutcomeDef, WorldState } from "../types/world.ts";
import type { EngineMutation, TurnRecord } from "../types/mutations.ts";
import type { CombatContext } from "../engine/commands.ts";
import type { NpcPublicAction } from "../types/npc.ts";
import type { GameEvent } from "../types/events.ts";
import { effectivePlayerStats } from "../engine/parameters.ts";

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
    case "engine/item_consumed":     return `玩家使用并消耗了 ${m.itemId}`;
    case "engine/item_reward_granted": return `NPC ${m.grantorNpcId} 向玩家交付了奖励 ${m.itemId}`;
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
    case "item_granted": return `玩家在 ${event.roomId} 直接获得了 ${event.itemId}`;
    case "item_picked_up": return `玩家在 ${event.roomId} 拾取了 ${event.itemId}`;
    case "item_consumed": return `玩家在 ${event.roomId} 使用并消耗了 ${event.itemId}`;
    case "item_dropped": return `玩家在 ${event.roomId} 丢下了 ${event.itemId}`;
    case "perceptible_signal": return `在 ${event.roomId} 可感知到：${event.message}`;
    case "condition_changed": return `${event.targetId} 的状态 ${event.conditionId} ${event.change}（层数 ${event.stacks}）`;
    case "objective_completed": return `玩家在 ${event.roomId} 完成了目标 ${event.objectiveId}`;
    case "entity_attacked": return `${event.targetId} 的 ${event.stat} 受到 ${event.amount} 点损耗`;
    case "entity_defeated": return `${event.entityId} 在 ${event.roomId} 被击败`;
    case "player_died": return `玩家在 ${event.roomId} 死亡`;
    case "player_incapacitated": return `玩家在 ${event.roomId} 失去行动能力`;
    case "critical_npc_died": return `关键 NPC ${event.npcId} 死亡；策略=${event.deathPolicy}${event.notes ? `；说明=${event.notes}` : ""}`;
    case "npc_moved": return `NPC ${event.npcId} 从 ${event.fromRoomId} 移动到 ${event.toRoomId}`;
  }
}

function formatNpcAction(action: NpcPublicAction): string {
  if (!action.succeeded) return `${action.npcName}尝试${action.verb}，但失败：${action.reason}`;
  switch (action.verb) {
    case "say": return `${action.npcName}说：“${action.content}”`;
    case "move": return `${action.npcName}向${action.direction}移动到${action.toRoomId}`;
    case "give_item": return `${action.npcName}说：“${action.content}”，并交给玩家${action.itemName ?? action.itemId}`;
    case "wait": return `${action.npcName}保持沉默`;
  }
}

function describeItemData(state: WorldState, item: ItemDef): string {
  const modifiers = (item.parameterModifiers ?? []).map((modifier) => {
    const label = state.schema.defs.find((def) => def.key === modifier.parameterId)?.label ?? modifier.parameterId;
    return modifier.operation === "add"
      ? `${label}${modifier.value >= 0 ? "+" : ""}${modifier.value}`
      : `${label}×${modifier.value}`;
  });
  const traits = (item.traits ?? []).map((trait) => `${trait.code}${trait.dataId ? `:${trait.dataId}` : ""}=${trait.value}`);
  const provenance = [
    item.rewardTemplateId ? `奖励模板:${item.rewardTemplateId}` : undefined,
    item.rewardObjectiveId ? `关联任务:${item.rewardObjectiveId}` : undefined,
    item.grantedByEntityId ? `赠予者:${item.grantedByEntityId}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const metadata = [...modifiers, ...traits, ...provenance];
  return `${item.desc}${item.kind ? ` [${item.kind}]` : ""}${item.equipSlot ? ` [槽位:${item.equipSlot}]` : ""}${metadata.length ? ` [${metadata.join("，")}]` : ""}`;
}

function formatPlayerStats(state: WorldState): string {
  const parts: string[] = [];
  const effectiveStats = effectivePlayerStats(state);
  for (const def of state.schema.defs) {
    if (def.display === "hidden") continue;
    const cur = effectiveStats[def.key] ?? def.default;
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
      const npcLines = t.npcActions?.map((action) => formatNpcAction(action)).join("；");
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
  gameEvents: GameEvent[] = [],
  interpretedIntent?: { verb: string; args: Record<string, string>; confidence: number },
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
      visibleObjectives.map((objective) => {
        const reward = objective.status === "completed" && objective.reward?.mode === "ai_judged"
          ? `；可由 AI 判断奖励，允许模板=${objective.reward.allowedTemplateIds.join(",")}，指导=${objective.reward.guidance}；发放时 rewardObjectiveId=${objective.id}`
          : "";
        return `• ${objective.status === "completed" ? "✓" : "○"} ${objective.title}：${objective.description}${reward}`;
      }).join("\n")
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
      `\n结果判定由你依据上述剧本标准完成。只有标准已经明确满足时才返回 outcomeReached；不满足时必须返回 null。若本轮触发结果，NARRATION 必须作为与该结果一致的收束叙事。反过来，如果 NARRATION 声称玩家已经离开、列车已经载其归去、故事已经失败或身份已经转化，就必须在同一响应设置对应 outcomeReached；若不提交 Outcome，就只能叙述尚未完成的进展，不能写成终局。`
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
    const npcLines = npcsHere.map((npc) => {
      const visible = state.schema.defs
        .filter((def) => def.display !== "hidden")
        .map((def) => `${def.label}:${npc.stats[def.key] ?? def.default}`)
        .join("，");
      return `  ${npc.name}${visible ? ` (${visible})` : ""}`;
    });
    const npcBlock = npcsHere.length > 0 ? `\n在场:\n${npcLines.join("\n")}` : "";
    const itemsHere = Object.values(state.items).filter(
      (item) => item.location.kind === "room" && item.location.roomId === room.id
    );
    const itemBlock = itemsHere.length > 0
      ? `\n地面物品:\n${itemsHere.map((item) => `  ${item.name}（${item.id}）：${describeItemData(state, item)}${item.portable === false ? " [不可携带]" : ""}`).join("\n")}`
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
    parts.push(`[背包物品详情]\n${inventoryItems.map((item) => `• ${item.name}（${item.id}）：${describeItemData(state, item)}`).join("\n")}`);
  }

  // ── Interpreter hint (never a replacement for the raw utterance) ──
  if (interpretedIntent) {
    parts.push(
      `[Interpreter 辅助理解]\n主要机械动词：${interpretedIntent.verb}\n参数：${JSON.stringify(interpretedIntent.args)}\n置信度：${interpretedIntent.confidence}\n这只是 Engine 执行主要机械动作的辅助标签，不是玩家完整意图。你必须重新阅读原始输入，回应其中的提问、情绪、方法、条件和次要动作；不要因标签只有一个 verb 就忽略复合表达。`
    );
  }

  // ── Combat context ──
  if (combatContext) {
    const statDef = state.schema.defs.find((def) => def.key === combatContext.poolKey);
    const statLabel = statDef?.label ?? combatContext.poolKey;
    const misses = combatContext.actions.filter((frame) => !frame.hit).length;
    const criticals = combatContext.actions.filter((frame) => frame.critical).length;
    parts.push(
      `[自动战斗模拟结果]\n` +
      `胜者：${combatContext.winner === "player" ? state.player.name : combatContext.npc.name}\n` +
      `${state.player.name}：${statLabel} ${combatContext.player.poolBefore} → ${combatContext.player.poolAfter}/${combatContext.player.poolMax}，速度 ${combatContext.player.speed}\n` +
      `${combatContext.npc.name}：${statLabel} ${combatContext.npc.poolBefore} → ${combatContext.npc.poolAfter}/${combatContext.npc.poolMax}，速度 ${combatContext.npc.speed}\n` +
      `模拟 tick：${combatContext.ticks}；出手次数：${combatContext.actions.length}；失手：${misses}；暴击：${criticals}\n` +
      `预计玩家胜率：${Math.round(combatContext.estimatedPlayerWinChance * 100)}%；风险：${combatContext.risk}；随机种子：${combatContext.seed}\n` +
      `战斗已经一次性结算。只需叙述结果和代价，不要再追加攻击、反击、逃跑或其他战斗状态修改。前端会根据结构化帧渲染进度条和出手动画。`
    );
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
    const lines = npcActions.map((action) => `- ${formatNpcAction(action)}`);
    parts.push(
      `[独立 NPC 的已确定行动]\n${lines.join("\n")}\n这些行动来自 NPC 的持久 Pi Session，并已由 Engine 校验。你只能叙述其公开结果，不得改写或替它决定其他行动。`
    );
  }

  // ── Authoritative events already settled this turn ──
  if (gameEvents.length > 0) {
    parts.push(
      `[本轮已结算事件]\n${gameEvents.map((event) => `• ${describeGameEvent(event)}`).join("\n")}\n这些事件和上方目标进度已经写入权威状态；不得否认或改写。`
    );
  }

  // ── Active authored obstacle reminder ──
  if (room?.tags?.includes("open_ended_obstacle")) {
    parts.push(
      `[当前场景是开放式障碍]\n` +
      `先语义判断玩家方案是否取得进展。若只是部分进展，可用 record_fact 或 Condition 保存真正需要跨回合引用的结果；若方案已突破阻隔，gmOperations 不能留空，必须先提交场景描述要求的 set_exit 等权威操作。不要只写“黑暗退去”“道路显现”却不更新桌面。`
    );
  }

  // ── Semantic adjudication boundary ──
  parts.push(
`[语义裁定原则]
你是真人式 Pi DM，负责理解玩家自由行动并判断其在当前情境中的意义；Engine 是权威桌面，只保存实体、位置、参数、Condition、目标和已提交事实。

1. **先判断是否需要机械结算**：纯观察、合理常识、已充分建立的方案可以直接成功；只有结果确实不确定且失败有意义时才考虑检定。不要为了形式感要求每个行动掷骰。
2. **允许创造性方案**：不要把调查、说服、欺骗、潜行、机关或开放式障碍缩减为固定命令或唯一密码。依据已有线索、角色设定、道具、代价和风险判断完全成功、部分成功、失败前进或拒绝。
3. **失败应推动故事**：优先给出代价、新线索、错误方向、参数变化或短期 Condition，而不是无信息地说“失败了”。但不要无依据奖励成功。
4. **尊重权威桌面**：不存在的出口、物品、NPC 或状态不能只靠叙述变成事实。出口尚未揭示时，不得声称玩家已经通过；方案成立后先提交 set_exit 等合法 gmOperations，再叙述其结果。门、窗、楼梯、机关和家具属于场景对象，不要求位于玩家背包；玩家操作它们时应做语义裁定，绝不能回答“背包里没有门”。
5. **按需结构化**：一次性的气氛、犹豫、疼痛或印象留在叙述；需要跨回合、UI 查询或后续规则引用时才记录为 world fact、Condition、参数或实体。
6. **具体物品必须实体化**：若某个新对象之后可以被检查、拾取、装备、消耗或作为奖励，必须在同一轮注册；纯背景陈设无需全部实体化。
7. **不要替独立 NPC 决策**：上方“独立 NPC 的已确定行动”来自它自己的持久 Session。你可以连接叙事，但不能重写它的意图或私有记忆。
8. **候选叙述必须可修正**：WORLD_UPDATE 只是 Proposal。若某项操作可能被 Engine 拒绝，叙述应避免把未经确认的机械结果写成不可撤销事实。
9. **携带变化必须落桌**：如果玩家明确拿走当前房间已有的可携带物品，而本轮已结算事件中没有拾取事件，可用 transfer_card 将该 itemId 转入玩家 inventory。叙述声称“收进背包、夹进报纸、带在身上”时，必须已有拾取事件或在同一响应提交 transfer_card；否则只能描述检查，不能声称已经携带。
10. **线索出现必须有场景因果**：冲突后出现的新线索应来自事先可成立的位置或关系，例如卡在鳞片、藏在衣袋、落在货箱旁或被打斗暴露。不要把普通敌人写成游戏怪物般凭空“掉落”文件或装备；创建物品时在同轮叙述中交代其物理来源。
11. **场景交互不是物品使用**：打开门、推窗、拉机关、翻桌、观察墙缝、沿楼梯潜行等都应直接结合当前叙述裁定。若门后的目的地尚不存在但本轮确实要揭示并允许进入，必须在 WORLD_UPDATE 的 roomsAdded 创建目的地，再通过 exitsAdded 或 set_exit 建立双向/合理出口；随后才能叙述通道已经可以通行。若上一轮曾口误宣称通道敞开而权威状态没有出口，本轮应主动修复该矛盾，而不是继续机械拒绝。
12. **规则是边界，不是选项菜单**：世界包描述已知事实、主题、机械词汇和不可违反的边界，但没有列出的方案不等于不可行。先依据当前 fiction 推演“以这种方法做这件事会发生什么”，再选择是否需要把结果落桌；不要要求玩家猜规则文件里的标准答案。
13. **完整回应复合意图**：一句话可能同时包含提问、观察、移动、使用物品和攻击。Engine 会先执行主要机械动作，你仍要回应其余有意义部分。例如“这是什么，瞄准它开枪”既要依据可见特征回答它是什么，也要叙述已结算攻击，不能只处理其中一半。
14. **在不确定处做真人 GM 判断**：当现有 fiction 足以支持时直接裁定；只有两种解释会导致显著不同且无法从上下文推断时才简短追问。不要因为规则未写、名称不精确或玩家用了代词就机械拒绝。
15. **保持世界主动但不抢夺主角权**：让环境、威胁和 NPC 根据已发生事实作出有因果的反应，主动呈现后果与新压力；但不要替玩家决定思想、承诺、情感结论或未声明的重大行动。
16. **区分知识层级**：可以描述角色当下可感知的形态、声音、气味和合理推断；只有已有线索或角色背景支持时才给出专有名称与真相。回答玩家问题时允许“不完全但有用”，不要无依据全知，也不要无信息回避。

裁定示例：
- 玩家根据两条已知线索准确指出机关规律：可以直接成功，不必掷骰。
- 玩家用不相关物品强行撬开无形屏障：可失败并损耗工具、留下线索或施加短期状态，而不是凭空开门。
- 玩家提出意外但符合主题的交换或坦白：可以认可方案，并用 set_exit、record_fact 或 apply_condition 保存后续真正需要引用的结果。
- 玩家只说“我仔细搜索”：由你描述搜索范围、发现和代价；只有新出现的可交互对象才需要注册。`);

  // ── Task ──
  parts.push(
`[你的任务]
用第二人称为玩家描述本轮体验（2-4句，沉浸式，不超过120字）。
如有必要，更新世界事实、剧情线、或创造新房间/NPC。
如果叙事中新出现了玩家可以检查、拾取、装备或使用的具体道具，必须把它写入 itemsAdded。不要只在叙事中提到而不注册。
玩家进入新的地点时，可以按场景逻辑生成少量有意义的道具或可检查陈设，但不要保证每个房间都有奖励，也不要无理由刷出强力装备。
itemsAdded 基础格式：{"id":"稳定且唯一的英文或拼音ID","name":"显示名","desc":"可检查描述","aliases":["简称或同义词"],"placement":"room","roomId":"当前房间ID","portable":true,"kind":"item"}。
- placement="room"：道具出现在场景中，玩家需要拾取；roomId 省略时默认为当前房间。
- placement="inventory"：仅用于 AI 判定的 NPC/任务奖励，必须提供当前世界允许的 rewardTemplateId；若是 NPC 当面赠予，同时提供 grantedByNpcId；若因已完成任务而奖励，同时提供 rewardObjectiveId。Engine 会使用模板中的固定机械规则，AI 只能创作名称、描述和别名。
- placement="room" 的场景物品 kind 可为 item/equipment/key/scenery；equipment 必须提供 equipSlot；scenery 会被视为不可携带。
- 场景物品可选 parameterModifiers/traits/effects/consumable 必须使用当前世界已经声明的参数 ID，数值应克制且符合剧情。
- 奖励不是每个任务或对话都必须有。只有根据已结算事件、目标完成、NPC 动机、信任或交换关系判断确实应得时才发放。
当前世界允许的 AI 奖励模板：
${(state.itemRewardRules?.templates ?? []).map((template) => `- ${template.id}：${template.label}；${template.guidance}`).join("\n") || "- 无；不能直接向背包发放道具"}

当前世界允许的跨回合 Condition：
${Object.values(state.conditionDefinitions).map((condition) => `- ${condition.id}：${condition.label}；叠加策略=${condition.stacking}；默认持续=${condition.defaultDurationTurns ?? "永久"}回合`).join("\n") || "- 无"}
需要保存跨回合状态时，可在 gmOperations 中使用 apply_condition 或 remove_condition。只能使用上方 condition ID；不要把一次性叙事细节做成 Condition。

常用 gmOperations 精确格式（只提交本轮确实发生的操作）：
- 记录事实：{"kind":"record_fact","text":"事实","roomId":"可选房间ID"}
- 揭示或修改通往已存在房间的出口：{"kind":"set_exit","roomId":"当前房间ID","direction":"north","toRoomId":"已存在房间ID"}
- 创建尚不存在的目的地：在 roomsAdded 放入 {"id":"稳定且唯一的房间ID","title":"标题","desc":"可复用的客观描述","exits":{}}，并在 exitsAdded 放入 {"roomId":"当前房间ID","direction":"down","toRoomId":"新房间ID"}；需要返回路径时再为新房间添加反向出口。不要让 set_exit 指向尚未创建的房间。
- 施加状态：{"kind":"apply_condition","conditionId":"允许的ID","targetEntityId":"${state.player.id}","durationTurns":3}
- 移除状态：{"kind":"remove_condition","conditionId":"允许的ID","targetEntityId":"${state.player.id}","reason":"原因"}
- 将当前房间已有物品放入玩家背包：{"kind":"transfer_card","itemId":"地面物品括号中的精确ID","to":{"kind":"inventory","ownerId":"${state.player.id}"}}
- 调整参数：{"kind":"adjust_parameter","entityId":"${state.player.id}","parameterId":"参数ID","delta":-1,"cause":"明确原因"}
- 完成语义目标：{"kind":"complete_objective","objectiveId":"仅限 gmCompletionAllowed 的目标ID","reason":"成立原因"}
如果叙述声称出口出现、物品已进入或离开背包、跨回合状态生效、参数改变或目标完成，对应的已结算事件或 gmOperations 不得缺失。不要把这些变化只写进 NARRATION。

严格按以下格式返回：

<NARRATION>
（给玩家看的叙事文字）
</NARRATION>
<WORLD_UPDATE>
{
  "gmOperations": [],
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
