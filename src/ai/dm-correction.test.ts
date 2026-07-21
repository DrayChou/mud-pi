import { describe, expect, test } from "bun:test";
import { loadWorldPack } from "../engine/world-loader.ts";
import {
  buildNarrationCorrectionPrompt,
  fallbackNarration,
  narrationNeedsCorrection,
  parseNarrationCorrection,
  type NarrationSettlementIssue,
} from "./dm-correction.ts";

describe("DM narration correction", () => {
  test("requests correction for rejections and narration-relevant warnings only", () => {
    const rejection: NarrationSettlementIssue = {
      proposalId: "p1",
      kind: "rejection",
      rejection: { code: "precondition_failed", safeMessage: "No change.", diagnostic: "missing fact", retryable: false },
    };
    const quietWarning: NarrationSettlementIssue = {
      proposalId: "p2",
      kind: "warning",
      warning: { code: "legacy_normalized", message: "normalized", narrationRelevant: false },
    };
    expect(narrationNeedsCorrection([quietWarning])).toBe(false);
    expect(narrationNeedsCorrection([rejection])).toBe(true);
  });

  test("builds bounded private feedback and parses only tagged corrections", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const issues: NarrationSettlementIssue[] = [{
      proposalId: "p1",
      kind: "warning",
      warning: { code: "value_clamped", message: "hp was clamped", details: { accepted: 0 }, narrationRelevant: true },
    }];
    const prompt = buildNarrationCorrectionPrompt(state, "你毫发无伤。", issues, []);
    expect(prompt).toContain("你毫发无伤");
    expect(prompt).toContain("value_clamped");
    expect(prompt).toContain("不得声称被拒绝的操作发生");
    expect(parseNarrationCorrection("<NARRATION>你踉跄着停下。</NARRATION>")).toBe("你踉跄着停下。");
    expect(parseNarrationCorrection("没有标签")).toBeNull();
    expect(fallbackNarration(state, issues)).toContain("规则允许的边界");
  });
});
