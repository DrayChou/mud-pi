import { describe, expect, test } from "bun:test";
import { ProcessTerminal, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { loadWorldPack } from "../engine/world-loader.ts";
import { GameRuntime } from "../runtime/game-runtime.ts";
import { MudTuiComponent } from "./tui.ts";

describe("MudTuiComponent", () => {
  test("renders responsive wide and narrow layouts without overflowing", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: {
        parse: async (raw) => ({ verb: "status", args: {}, confidence: 1, raw }),
      },
      dm: { ask: async () => "" },
      npcSessions: { respondToPlayerSay: async () => [] },
      persist: false,
    });
    const tui = new TUI(new ProcessTerminal());
    const component = new MudTuiComponent(runtime, tui, () => {}, [
      { kind: "narration", text: "这是经过权威结算的开场。" },
    ]);

    const wide = component.render(120);
    component.invalidate();
    const narrow = component.render(72);

    expect(wide.some((line) => line.includes("玩家 / 目标"))).toBe(true);
    expect(wide.some((line) => line.includes("房间 / 地图"))).toBe(true);
    expect(wide.some((line) => line.includes("这是经过权威结算的开场"))).toBe(true);
    expect(narrow.some((line) => line.includes("状态"))).toBe(true);
    expect(narrow.some((line) => line.includes("背包") && line.includes("旧车票"))).toBe(true);
    expect(narrow.some((line) => line.includes("目标") && line.includes("询问归途"))).toBe(true);
    expect(wide.every((line) => visibleWidth(line) <= 120)).toBe(true);
    expect(narrow.every((line) => visibleWidth(line) <= 72)).toBe(true);
  });
});
