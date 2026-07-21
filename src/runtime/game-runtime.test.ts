import { describe, expect, test } from "bun:test";
import { loadStoryOutcomes, loadWorldPack } from "../engine/world-loader.ts";
import { GameRuntime } from "./game-runtime.ts";
import type { ParsedCommand } from "../ai/interpreter.ts";
import { visibleEntityIds } from "../engine/npc-intents.ts";

function parsed(verb: string, args: Record<string, string> = {}): ParsedCommand {
  return { verb, args, confidence: 1, raw: verb };
}

describe("GameRuntime", () => {
  test("processes the opening through GM settlement and bounded narration correction", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const prompts: string[] = [];
    const replies = [
      `<NARRATION>不存在的门已经打开。</NARRATION><WORLD_UPDATE>{"gmOperations":[{"kind":"set_exit","roomId":"MissingRoom","direction":"north","toRoomId":"MissingRoom2"}]}</WORLD_UPDATE>`,
      `<NARRATION>站厅的灯光轻轻闪烁，列车仍未进站。</NARRATION>`,
    ];
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: { parse: async () => { throw new Error("opening must not invoke the interpreter"); } },
      dm: { ask: async (prompt) => { prompts.push(prompt); return replies.shift()!; } },
      npcSessions: { respondToPlayerSay: async () => [] },
      persist: false,
    });

    const result = await runtime.processOpening();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("结算反馈");
    expect(result.outputs).toContainEqual({
      kind: "narration",
      text: "站厅的灯光轻轻闪烁，列车仍未进站。",
    });
    expect(state.turn).toBe(1);
  });

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

  test("defers semantic direct replies so missing narrative references reach the Pi GM", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    let capturedPrompt = "";
    const runtime = new GameRuntime({
      state,
      storyOutcomes: await loadStoryOutcomes("cthulhu"),
      interpreter: { parse: async () => parsed("equip", { item: "祭坛上的仪式匕首" }) },
      dm: { ask: async (prompt) => {
        capturedPrompt = prompt;
        return `<NARRATION>祭坛上并没有匕首，只有干涸的蜡痕。</NARRATION><WORLD_UPDATE>{}</WORLD_UPDATE>`;
      } },
      npcSessions: { respondToPlayerSay: async () => [] },
      persist: false,
    });

    const result = await runtime.processInput("拿起并装备祭坛上的仪式匕首");

    expect(result.turnAdvanced).toBe(true);
    expect(result.outputs).toContainEqual({ kind: "narration", text: "祭坛上并没有匕首，只有干涸的蜡痕。" });
    expect(capturedPrompt).toContain("需要语义裁定：是");
    expect(capturedPrompt).toContain('"resolution":"missing"');
  });

  test("does not replay a guessed direction after the Pi GM already moved toward the named destination", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    state.player.roomId = "HarborsideWharf";
    const runtime = new GameRuntime({
      state,
      storyOutcomes: await loadStoryOutcomes("cthulhu"),
      interpreter: { parse: async () => ({ ...parsed("go", { direction: "north", intent: "回到大街" }), raw: "回到大街" }) },
      dm: { ask: async () => `<NARRATION>你沿西侧栈道回到黑暗大街。</NARRATION><WORLD_UPDATE>{"gmOperations":[{"kind":"move_player","toRoomId":"ArkhamStreet"}],"narrativeClaims":[{"kind":"player_location","roomId":"ArkhamStreet"}]}</WORLD_UPDATE>` },
      npcSessions: { respondToPlayerSay: async () => [] },
      persist: false,
    });

    const result = await runtime.processInput("回到大街");

    expect(state.player.roomId).toBe("ArkhamStreet");
    expect(result.outputs).toContainEqual({ kind: "room_changed", roomId: "ArkhamStreet" });
  });

  test("falls back to authoritative local narration when the DM times out", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: { parse: async () => parsed("look") },
      dm: { ask: async () => { throw new Error("AI request timed out after 60000ms"); } },
      npcSessions: { respondToPlayerSay: async () => [] },
      persist: false,
    });

    const result = await runtime.processInput("看看周围");

    expect(result.turnAdvanced).toBe(true);
    expect(result.outputs).toContainEqual({
      kind: "narration",
      text: `${state.rooms[state.player.roomId]!.desc} 暂时没有发现超出眼前权威状态的新变化。`,
    });
    expect(state.turn).toBe(1);
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

  test("settles the normalized Pi GM table plan and routes post-DM signals to NPC sessions", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const perceivedBatches: string[][] = [];
    const roomId = state.npcs.ticket_clerk!.roomId;
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: { parse: async () => parsed("say", { message: "有人吗？" }) },
      dm: { ask: async () => `<NARRATION>远处响起铃声。</NARRATION><WORLD_UPDATE>{"gmOperations":[{"kind":"record_fact","text":"The bell rang."},{"kind":"emit_signal","signalId":"bell","roomId":"${roomId}","message":"A bell rings."}]}</WORLD_UPDATE>` },
      npcSessions: {
        respondToPlayerSay: async () => [],
        respondToEvents: async (_snapshot, events) => {
          perceivedBatches.push(events.map((event) => event.kind));
          return [];
        },
      },
      persist: false,
    });

    await runtime.processInput("有人吗？");

    expect(state.worldFacts.some((fact) => fact.text === "The bell rang.")).toBe(true);
    expect(perceivedBatches.some((kinds) => kinds.includes("perceptible_signal"))).toBe(true);
  });

  test("withholds rejected candidate narration and asks the same DM once for correction", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const prompts: string[] = [];
    const replies = [
      `<NARRATION>不存在的钟已经被抹去了。</NARRATION><WORLD_UPDATE>{"gmOperations":[{"kind":"remove_fact","text":"A nonexistent bell."}]}</WORLD_UPDATE>`,
      `<NARRATION>你侧耳倾听，远处依旧寂静无声。</NARRATION>`,
    ];
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: { parse: async () => parsed("look") },
      dm: { ask: async (prompt) => { prompts.push(prompt); return replies.shift()!; } },
      npcSessions: { respondToPlayerSay: async () => [] },
      persist: false,
    });

    const result = await runtime.processInput("观察四周");

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("entity_not_found");
    expect(result.outputs.find((output) => output.kind === "narration")).toEqual({
      kind: "narration",
      text: "你侧耳倾听，远处依旧寂静无声。",
    });
  });

  test("withholds narration whose declared claims are not supported by committed state", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    const replies = [
      `<NARRATION>你已经进入不存在的地下室。</NARRATION><WORLD_UPDATE>{"narrativeClaims":[{"kind":"player_location","roomId":"missing_vault"}]}</WORLD_UPDATE>`,
      `<NARRATION>你仍站在原地；眼前没有通往地下室的已知道路。</NARRATION>`,
    ];
    const runtime = new GameRuntime({
      state,
      storyOutcomes: await loadStoryOutcomes("cthulhu"),
      interpreter: { parse: async () => parsed("interact", { target: "暗门" }) },
      dm: { ask: async () => replies.shift()! },
      npcSessions: { respondToPlayerSay: async () => [] },
      persist: false,
    });

    const result = await runtime.processInput("走进暗门后的地下室");

    expect(result.outputs).toContainEqual({ kind: "narration", text: "你仍站在原地；眼前没有通往地下室的已知道路。" });
    expect(state.player.roomId).toBe("ArkhamStreet");
  });

  test("uses a committed-facts fallback when the single correction is malformed", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    let calls = 0;
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: { parse: async () => parsed("look") },
      dm: {
        ask: async () => {
          calls += 1;
          return calls === 1
            ? `<NARRATION>不存在的门已经打开。</NARRATION><WORLD_UPDATE>{"gmOperations":[{"kind":"set_exit","roomId":"MissingRoom","direction":"north","toRoomId":"MissingRoom2"}]}</WORLD_UPDATE>`
            : "仍然声称门已经打开";
        },
      },
      npcSessions: { respondToPlayerSay: async () => [] },
      persist: false,
    });

    const result = await runtime.processInput("观察四周");
    const narration = result.outputs.find((output) => output.kind === "narration");

    expect(calls).toBe(2);
    expect(narration?.kind === "narration" && narration.text).toContain("并未如预想般改变");
  });

  test("expires finite conditions at the turn boundary through committed events", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.conditionDefinitions.brief_fear = { id: "brief_fear", label: "短暂恐惧", stacking: "refresh", defaultDurationTurns: 1 };
    state.conditions[`${state.player.id}:brief_fear`] = {
      conditionId: "brief_fear", targetEntityId: state.player.id, stacks: 1,
      appliedRevision: state.revision, appliedTurn: state.turn, expiresAtTurn: state.turn + 1,
    };
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: { parse: async () => parsed("look") },
      dm: { ask: async () => `<NARRATION>你稳住呼吸。</NARRATION><WORLD_UPDATE>{}</WORLD_UPDATE>` },
      npcSessions: { respondToPlayerSay: async () => [], respondToEvents: async () => [] },
      persist: false,
    });

    await runtime.processInput("观察四周");

    expect(state.conditions[`${state.player.id}:brief_fear`]).toBeUndefined();
    expect(state.turn).toBe(1);
  });

  test("accepts an AI NPC reward after authoritative objective and room checks", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    let perceivedKinds: string[] = [];
    const runtime = new GameRuntime({
      state,
      storyOutcomes: [],
      interpreter: { parse: async () => parsed("say", { target: "售票员", message: "我帮你整理好了票根。" }) },
      dm: { ask: async () => `<NARRATION>售票员把纸杯推到你面前。</NARRATION><WORLD_UPDATE>{}</WORLD_UPDATE>` },
      npcSessions: {
        respondToPlayerSay: async () => [],
        respondToEvents: async (snapshot, events) => {
          perceivedKinds = events.map((event) => event.kind);
          return [{
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
            objectiveId: "ask_ticket_clerk",
            itemId: "ticket_clerk_tea_turn_1",
            name: "售票员的热茶",
            desc: "一杯带着淡淡铁锈气味的热茶。",
          },
        }];
        },
      },
      persist: false,
    });

    await runtime.processInput("对售票员说我帮你整理好了票根");

    expect(perceivedKinds).toContain("objective_completed");
    expect(state.player.inventory).toContain("ticket_clerk_tea_turn_1");
    expect(state.items.ticket_clerk_tea_turn_1).toMatchObject({
      rewardTemplateId: "small_recovery",
      rewardObjectiveId: "ask_ticket_clerk",
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
