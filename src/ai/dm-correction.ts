import type { GameEvent } from "../types/events.ts";
import type { SettlementRejection, SettlementWarning } from "../types/proposals.ts";
import type { WorldState } from "../types/world.ts";

export type NarrationSettlementIssue =
  | { proposalId: string; kind: "rejection"; rejection: SettlementRejection }
  | { proposalId: string; kind: "warning"; warning: SettlementWarning };

export function narrationNeedsCorrection(issues: readonly NarrationSettlementIssue[]): boolean {
  return issues.some((issue) => issue.kind === "rejection" || issue.warning.narrationRelevant);
}

export function buildNarrationCorrectionPrompt(
  state: Readonly<WorldState>,
  candidateNarration: string,
  issues: readonly NarrationSettlementIssue[],
  committedEvents: readonly GameEvent[],
): string {
  const feedback = issues.map((issue) => issue.kind === "rejection"
    ? {
        proposalId: issue.proposalId,
        status: "rejected",
        code: issue.rejection.code,
        message: issue.rejection.safeMessage,
        details: issue.rejection.details,
      }
    : {
        proposalId: issue.proposalId,
        status: "accepted_with_warning",
        code: issue.warning.code,
        message: issue.warning.message,
        details: issue.warning.details,
      });

  return `你上一条候选叙述尚未展示，因为部分桌面操作被拒绝或被规则修正。\n\n候选叙述：\n${candidateNarration}\n\n结算反馈：\n${JSON.stringify(feedback, null, 2)}\n\n本轮已经提交的公开事实：\n${JSON.stringify(committedEvents, null, 2)}\n\n当前权威位置：${state.rooms[state.player.roomId]?.title ?? state.player.roomId}\n当前玩家参数：${JSON.stringify(state.player.stats)}\n\n只改写给玩家看的叙述，使其严格符合已经提交的事实。不得声称被拒绝的操作发生，也不要提出新的世界操作。保持第二人称、2-4句、不超过120字。严格返回：\n<NARRATION>\n修正后的叙述\n</NARRATION>`;
}

export function parseNarrationCorrection(raw: string): string | null {
  const match = raw.match(/<NARRATION>([\s\S]*?)<\/NARRATION>/i);
  const narration = match?.[1]?.trim();
  return narration ? narration.slice(0, 500) : null;
}

export function fallbackNarration(
  state: Readonly<WorldState>,
  issues: readonly NarrationSettlementIssue[],
): string {
  const room = state.rooms[state.player.roomId]?.title ?? "眼前";
  const adjusted = issues.some((issue) => issue.kind === "warning" && issue.warning.narrationRelevant);
  return adjusted
    ? `${room}里的变化最终停在规则允许的边界。你重新看清局势，一切以眼前真实留下的结果为准。`
    : `${room}里的局势并未如预想般改变。你定了定神，眼前仍只有那些真正发生并留下痕迹的事。`;
}
