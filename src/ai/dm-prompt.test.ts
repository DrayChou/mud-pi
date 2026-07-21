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
      { verb: "use", args: { item: "旧车票", question: "这里为何阻止我" }, confidence: 0.82 },
    );

    expect(prompt).toContain("你是真人式 Pi DM");
    expect(prompt).toContain("不要为了形式感要求每个行动掷骰");
    expect(prompt).toContain("允许创造性方案");
    expect(prompt).toContain("失败应推动故事");
    expect(prompt).toContain("出口尚未揭示时，不得声称玩家已经通过");
    expect(prompt).toContain("[当前场景是开放式障碍]");
    expect(prompt).toContain("gmOperations 不能留空");
    expect(prompt).toContain('"kind":"set_exit"');
    expect(prompt).toContain('"kind":"apply_condition"');
    expect(prompt).toContain("echo_mark：回声印记");
    expect(prompt).toContain("set_exit");
    expect(prompt).toContain("EchoGate");
    expect(prompt).toContain("列车已经载其归去");
    expect(prompt).toContain("就必须在同一响应设置对应 outcomeReached");
    expect(prompt).toContain('"kind":"transfer_card"');
    expect(prompt).toContain("物品已进入或离开背包");
    expect(prompt).toContain("不要把普通敌人写成游戏怪物般凭空");
    expect(prompt).toContain("规则是边界，不是选项菜单");
    expect(prompt).toContain("场景交互不是物品使用");
    expect(prompt).toContain("绝不能回答“背包里没有门”");
    expect(prompt).toContain("roomsAdded");
    expect(prompt).toContain("不要让 set_exit 指向尚未创建的房间");
    expect(prompt).toContain("可交互对象必须实体化");
    expect(prompt).toContain("允许玩家主动施暴");
    expect(prompt).toContain("npcsAdded");
    expect(prompt).toContain('"kind":"move_player"');
    expect(prompt).toContain("完整回应复合意图");
    expect(prompt).toContain("[Interpreter 辅助理解]");
    expect(prompt).toContain('"question":"这里为何阻止我"');
    expect(prompt).toContain("不是玩家完整意图");
    expect(prompt).toContain('"gmOperations": []');
  });
});
