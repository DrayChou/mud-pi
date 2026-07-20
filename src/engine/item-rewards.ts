import type { ItemDef, WorldState } from "../types/world.ts";

export interface ItemRewardGrantProposal {
  grantorNpcId?: string;
  templateId: string;
  itemId: string;
  name: string;
  desc: string;
  aliases?: string[];
  objectiveId?: string;
  requestedAtTurn: number;
}

export type ItemRewardDecision =
  | { accepted: true; item: ItemDef }
  | { accepted: false; reason: string };

export function decideItemRewardGrant(
  state: WorldState,
  proposal: ItemRewardGrantProposal
): ItemRewardDecision {
  if (proposal.requestedAtTurn !== state.turn) return reject("奖励决策已经过期");
  if (state.items[proposal.itemId] || !/^[a-z][a-z0-9_-]{0,63}$/.test(proposal.itemId)) {
    return reject("奖励道具 ID 无效或已经存在");
  }
  if (!proposal.name.trim() || !proposal.desc.trim()) return reject("奖励缺少名称或描述");

  const template = state.itemRewardRules?.templates.find((candidate) => candidate.id === proposal.templateId);
  if (!template || (template.kind !== "item" && template.kind !== "equipment")) {
    return reject("奖励模板不属于当前世界规则");
  }

  const objective = proposal.objectiveId ? state.objectives[proposal.objectiveId] : undefined;
  if (proposal.objectiveId) {
    if (!objective || objective.status !== "completed" || objective.reward?.mode !== "ai_judged") {
      return reject("关联任务尚未完成或不允许 AI 奖励");
    }
    if (!objective.reward.allowedTemplateIds.includes(template.id)) {
      return reject("该奖励模板不属于关联任务允许范围");
    }
    if (
      proposal.grantorNpcId &&
      objective.reward.eligibleGrantorNpcIds?.length &&
      !objective.reward.eligibleGrantorNpcIds.includes(proposal.grantorNpcId)
    ) return reject("该 NPC 不是关联任务允许的奖励人");
    const priorAwards = Object.values(state.items).filter((item) => item.rewardObjectiveId === objective.id).length;
    if (priorAwards >= (objective.reward.maxAwards ?? 1)) return reject("关联任务的奖励已经发放");
  }

  const grantor = state.npcs[proposal.grantorNpcId ?? ""];
  if (proposal.grantorNpcId && (!grantor || !grantor.alive || grantor.roomId !== state.player.roomId)) {
    return reject("赠予者不存在、已死亡或不在玩家面前");
  }

  const grantsThisTurn = Object.values(state.items).filter((item) =>
    item.rewardTemplateId && item.createdTurn === state.turn
  ).length;
  if (grantsThisTurn >= (state.itemRewardRules?.maxGrantedPerTurn ?? 2)) {
    return reject("本回合的 AI 奖励额度已经用完");
  }

  const grantorId = proposal.grantorNpcId ?? "dm";
  const priorByGrantor = Object.values(state.items)
    .filter((item) => item.rewardTemplateId === template.id && item.grantedByEntityId === grantorId)
    .sort((a, b) => (b.createdTurn ?? -1) - (a.createdTurn ?? -1));
  if (priorByGrantor.length >= (template.maxPerGrantor ?? 1)) {
    return reject("该赠予者已经发放过此类奖励");
  }
  const lastGrantTurn = priorByGrantor[0]?.createdTurn;
  if (lastGrantTurn !== undefined && state.turn - lastGrantTurn < (template.cooldownTurns ?? 0)) {
    return reject("此类奖励仍在冷却中");
  }

  return {
    accepted: true,
    item: {
      id: proposal.itemId,
      name: proposal.name.trim().slice(0, 80),
      desc: proposal.desc.trim().slice(0, 600),
      aliases: proposal.aliases?.map((alias) => alias.trim().slice(0, 80)).filter(Boolean).slice(0, 12),
      kind: template.kind,
      equipSlot: template.equipSlot,
      parameterModifiers: structuredClone(template.parameterModifiers ?? []),
      traits: structuredClone(template.traits ?? []),
      effects: structuredClone(template.effects ?? []),
      consumable: template.consumable ?? false,
      portable: template.portable ?? true,
      location: { kind: "inventory", ownerId: state.player.id },
      source: "dm_generated",
      createdTurn: state.turn,
      rewardTemplateId: template.id,
      rewardObjectiveId: objective?.id,
      grantedByEntityId: grantorId,
    },
  };
}

function reject(reason: string): ItemRewardDecision {
  return { accepted: false, reason };
}
