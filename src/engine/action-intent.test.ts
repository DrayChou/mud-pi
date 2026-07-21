import { describe, expect, test } from "bun:test";
import { actionIntentFromParsed, completionCommandForIntent, resolveActionIntent } from "./action-intent.ts";
import { loadWorldPack } from "./world-loader.ts";
import type { ParsedCommand } from "../ai/interpreter.ts";

function parsed(verb: string, args: Record<string, string>, raw: string): ParsedCommand {
  return { verb, args, raw, confidence: 0.95 };
}

describe("ActionIntent compatibility", () => {
  test("preserves compound goal, approach, question, tool, and direction", () => {
    const intent = actionIntentFromParsed(parsed("interact", {
      target: "铁门",
      direction: "down",
      approach: "轻轻推开并潜行",
      intent: "进入地下室观察教授",
      question: "他们在做什么",
      tool: "黄铜钥匙",
    }, "用钥匙轻轻开门，下去看看他们在做什么"));

    expect(intent).toMatchObject({
      primaryKind: "interact",
      goal: "进入地下室观察教授",
      approach: "轻轻推开并潜行",
      questions: ["他们在做什么"],
      direction: "down",
      targets: [{ text: "铁门", role: "target" }],
      tools: [{ text: "黄铜钥匙", role: "tool" }],
    });
  });
});

describe("authoritative entity reference resolution", () => {
  test("resolves item aliases and NPC plural wording in the current room", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    state.player.roomId = "MiskULibrary";
    state.npcs.polluted_professor = {
      ...structuredClone(state.npcs.librarian!),
      id: "polluted_professor",
      name: "被污染的失踪教授",
      roomId: "MiskULibrary",
      alive: true,
    };
    (state.npcs.polluted_professor as typeof state.npcs.polluted_professor & { aliases: string[] }).aliases = ["教授们", "失踪教授"];
    const key = state.items.necronomicon_fragment!;
    key.aliases = ["残页"];
    key.location = { kind: "inventory", ownerId: state.player.id };
    state.player.inventory.push(key.id);

    const attack = resolveActionIntent(state, actionIntentFromParsed(parsed("attack", { target: "教授们" }, "攻击教授们")));
    const use = resolveActionIntent(state, actionIntentFromParsed(parsed("use", { item: "残页" }, "阅读残页")));

    expect(attack.resolvedTargets[0]).toMatchObject({ resolution: "alias", entityId: "polluted_professor", entityKind: "npc" });
    expect(attack.requiresSemanticAdjudication).toBe(false);
    expect(use.resolvedTargets[0]).toMatchObject({ resolution: "alias", entityId: "necronomicon_fragment", entityKind: "item" });
  });

  test("marks narrated but unregistered scenery for semantic adjudication", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    state.player.roomId = "MiskULibrary";
    const resolved = resolveActionIntent(
      state,
      actionIntentFromParsed(parsed("interact", { target: "坚固密门", approach: "推开" }, "推开坚固密门")),
    );

    expect(resolved.resolvedTargets[0]).toMatchObject({ text: "坚固密门", resolution: "missing" });
    expect(resolved.requiresSemanticAdjudication).toBe(true);
  });

  test("does not resolve remote NPCs as visible attack targets", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    state.player.roomId = "HarborsideWharf";
    const resolved = resolveActionIntent(
      state,
      actionIntentFromParsed(parsed("attack", { target: "图书馆员亨利" }, "攻击图书馆员亨利")),
    );

    expect(resolved.resolvedTargets[0]?.resolution).toBe("missing");
    expect(resolved.requiresSemanticAdjudication).toBe(true);
  });

  test("builds generic completion commands by action kind instead of verb-specific retries", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    const navigateParsed = parsed("interact", { target: "铁门", direction: "down" }, "推门下楼");
    const navigate = resolveActionIntent(state, actionIntentFromParsed(navigateParsed));
    const statusParsed = parsed("story_status", { question: "结束了吗" }, "结束了吗");
    const status = resolveActionIntent(state, actionIntentFromParsed(statusParsed));

    expect(completionCommandForIntent(navigate, navigateParsed)).toMatchObject({ verb: "go", args: { direction: "down" } });
    expect(completionCommandForIntent(status, statusParsed)).toBeUndefined();
  });

  test("routes story status through semantic adjudication without a target", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    const resolved = resolveActionIntent(
      state,
      actionIntentFromParsed(parsed("story_status", { question: "游戏结束了吗" }, "游戏结束了吗")),
    );

    expect(resolved.primaryKind).toBe("story_status");
    expect(resolved.questions).toEqual(["游戏结束了吗"]);
    expect(resolved.requiresSemanticAdjudication).toBe(true);
  });
});
