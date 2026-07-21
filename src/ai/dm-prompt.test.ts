import { describe, expect, test } from "bun:test";
import { loadStoryOutcomes, loadWorldPack } from "../engine/world-loader.ts";
import { buildDmPrompt } from "./dm-prompt.ts";

describe("Pi DM adjudication prompt", () => {
  test("states the semantic authority boundary and world-specific table tools", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.player.roomId = "EchoGate";

    const prompt = buildDmPrompt(
      state,
      "我把旧车票贴在黑暗上，坦白自己真正想回去的地方。",
      [],
      undefined,
      [],
      await loadStoryOutcomes("station-dream"),
      [],
    );

    expect(prompt).toContain("你是真人式 Pi DM");
    expect(prompt).toContain("不要为了形式感要求每个行动掷骰");
    expect(prompt).toContain("允许创造性方案");
    expect(prompt).toContain("失败应推动故事");
    expect(prompt).toContain("出口尚未揭示时，不得声称玩家已经通过");
    expect(prompt).toContain("echo_mark：回声印记");
    expect(prompt).toContain("set_exit");
    expect(prompt).toContain("EchoGate");
    expect(prompt).toContain('"gmOperations": []');
  });
});
