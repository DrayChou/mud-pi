import { describe, expect, test } from "bun:test";
import { loadStoryOutcomes, loadWorldPack } from "../engine/world-loader.ts";
import { GameRuntime } from "./game-runtime.ts";
import type { ParsedCommand } from "../ai/interpreter.ts";
import { visibleEntityIds } from "../engine/npc-intents.ts";

function parsed(verb: string, args: Record<string, string> = {}): ParsedCommand {
  return { verb, args, confidence: 1, raw: verb };
}

describe("GameRuntime", () => {
  test("returns direct replies without invoking the DM or advancing the turn", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    let dmCalls = 0;
    const runtime = new GameRuntime({
      state,
      storyOutcomes: await loadStoryOutcomes("station-dream"),
      interpreter: { parse: async () => parsed("status") },
      dm: { ask: async () => { dmCalls += 1; return ""; } },
      npcSessions: { respondToPlayerSay: async () => [] },
      persist: false,
    });

    const result = await runtime.processInput("状态");

    expect(result.turnAdvanced).toBe(false);
    expect(result.outputs[0]?.kind).toBe("direct_reply");
    expect(state.turn).toBe(0);
    expect(dmCalls).toBe(0);
  });

  test("settles movement and objective progress before constructing the DM prompt", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.player.roomId = "Platform";
    state.objectives.ask_ticket_clerk!.status = "completed";
    let capturedPrompt = "";
    let objectiveStatusSeenByNpc: string | undefined;
    const runtime = new GameRuntime({
      state,
      storyOutcomes: await loadStoryOutcomes("station-dream"),
      interpreter: { parse: async () => parsed("go", { direction: "north" }) },
      dm: {
        ask: async (prompt) => {
          capturedPrompt = prompt;
          return `<NARRATION>你登上了列车。</NARRATION><WORLD_UPDATE>{}</WORLD_UPDATE>`;
        },
      },
      npcSessions: {
        respondToPlayerSay: async () => [],
        respondToEvents: async (snapshot) => {
          objectiveStatusSeenByNpc = snapshot.objectives.board_train?.status;
          return [];
        },
      },
      persist: false,
    });

    const result = await runtime.processInput("向北走");

    expect(state.player.roomId).toBe("Compartment1");
    expect(state.objectives.board_train?.status).toBe("completed");
    expect(capturedPrompt).toContain("✓ 登上列车");
    expect(objectiveStatusSeenByNpc).toBe("completed");
    expect(capturedPrompt).toContain("玩家从 Platform 移动到 Compartment1");
    expect(result.outputs.map((output) => output.kind)).toEqual([
      "narration",
      "objective_completed",
      "room_changed",
    ]);
    expect(state.turn).toBe(1);
  });

  test("routes settled visible events to NPC sessions before DM narration", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    let perceivedKinds: string[] = [];
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: { parse: async () => parsed("go", { direction: "east" }) },
      dm: { ask: async () => `<NARRATION>你走向站台。</NARRATION><WORLD_UPDATE>{}</WORLD_UPDATE>` },
      npcSessions: {
        respondToPlayerSay: async () => [],
        respondToEvents: async (_snapshot, events) => {
          perceivedKinds = events.map((event) => event.kind);
          return [];
        },
      },
      persist: false,
    });

    await runtime.processInput("向东走");

    expect(perceivedKinds).toEqual(["player_moved"]);
    expect(state.player.roomId).toBe("Platform");
  });

  test("accepts an AI NPC reward after authoritative objective and room checks", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: { parse: async () => parsed("say", { target: "售票员", message: "我帮你整理好了票根。" }) },
      dm: { ask: async () => `<NARRATION>售票员把纸杯推到你面前。</NARRATION><WORLD_UPDATE>{}</WORLD_UPDATE>` },
      npcSessions: {
        respondToPlayerSay: async () => [],
        respondToEvents: async (snapshot) => [{
          npcId: "ticket_clerk",
          context: {
            requestedAtTurn: snapshot.turn,
            roomId: snapshot.npcs.ticket_clerk!.roomId,
            visibleEntityIds: visibleEntityIds(snapshot, snapshot.npcs.ticket_clerk!.roomId),
          },
          intent: {
            verb: "give_item",
            content: "拿去暖暖手。",
            templateId: "small_recovery",
            itemId: "ticket_clerk_tea_turn_1",
            name: "售票员的热茶",
            desc: "一杯带着淡淡铁锈气味的热茶。",
          },
        }],
      },
      persist: false,
    });

    await runtime.processInput("对售票员说我帮你整理好了票根");

    expect(state.player.inventory).toContain("ticket_clerk_tea_turn_1");
    expect(state.items.ticket_clerk_tea_turn_1).toMatchObject({
      rewardTemplateId: "small_recovery",
      grantedByEntityId: "ticket_clerk",
    });
  });

  test("returns one structured auto-combat result without waking NPC sessions", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.player.roomId = "Compartment3";
    let capturedPrompt = "";
    let npcWakeups = 0;
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: { parse: async () => parsed("attack", { target: "阴影" }) },
      dm: {
        ask: async (prompt) => {
          capturedPrompt = prompt;
          return `<NARRATION>阴影在你的攻击后反扑。</NARRATION><WORLD_UPDATE>{}</WORLD_UPDATE>`;
        },
      },
      npcSessions: {
        respondToPlayerSay: async () => [],
        respondToEvents: async () => { npcWakeups += 1; return []; },
      },
      persist: false,
    });

    const turn = await runtime.processInput("攻击阴影");

    expect(state.npcs.shadow?.alive).toBe(false);
    expect(turn.outputs.some((output) => output.kind === "combat_result")).toBe(true);
    expect(npcWakeups).toBe(0);
    expect(capturedPrompt).toContain("[自动战斗模拟结果]");
    expect(capturedPrompt).toContain("战斗已经一次性结算");
  });

  test("exposes a detached snapshot for adapters", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: { parse: async () => parsed("status") },
      dm: { ask: async () => "" },
      npcSessions: { respondToPlayerSay: async () => [] },
      persist: false,
    });

    const snapshot = runtime.getSnapshot();
    snapshot.player.name = "被修改";

    expect(runtime.state.player.name).not.toBe("被修改");
  });
});
