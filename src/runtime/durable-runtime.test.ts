import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadWorldPack } from "../engine/world-loader.ts";
import { initSave, loadState } from "../store/persist.ts";
import { pendingOutbox } from "../store/outbox.ts";
import type { ParsedCommand } from "../ai/interpreter.ts";
import { GameRuntime } from "./game-runtime.ts";

const saveIds: string[] = [];
afterEach(async () => {
  await Promise.all(saveIds.splice(0).map((id) => rm(join(import.meta.dir, "../../saves", id), { recursive: true, force: true })));
});

function parsed(verb: string, args: Record<string, string> = {}): ParsedCommand {
  return { verb, args, confidence: 1, raw: verb };
}

test("NPC delivery failure does not roll back committed facts and remains recoverable", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  state.worldId = `runtime-durable-${Date.now()}-${crypto.randomUUID()}`;
  saveIds.push(state.worldId);
  await initSave(state);

  const runtime = new GameRuntime({
    state,
    storyOutcomes: [],
    interpreter: { parse: async () => parsed("go", { direction: "east" }) },
    dm: { ask: async () => `<NARRATION>你走上站台。</NARRATION><WORLD_UPDATE>{}</WORLD_UPDATE>` },
    npcSessions: {
      respondToPlayerSay: async () => [],
      respondToEvents: async () => { throw new Error("agent unavailable"); },
    },
    persist: true,
  });

  expect(runtime.processInput("向东走")).rejects.toThrow("agent unavailable");
  expect(state.player.roomId).toBe("Platform");
  expect((await pendingOutbox(state.worldId)).some((record) => record.effect.kind === "npc_perception")).toBe(true);

  const recovered = await loadState(state.worldId);
  expect(recovered?.player.roomId).toBe("Platform");
  const recoveryRuntime = new GameRuntime({
    state: recovered!, storyOutcomes: [],
    interpreter: { parse: async () => parsed("status") },
    dm: { ask: async () => "" },
    npcSessions: { respondToPlayerSay: async () => [], respondToEvents: async () => [] },
    persist: true,
  });
  await recoveryRuntime.processInput("状态");
  expect((await pendingOutbox(state.worldId)).some((record) => record.effect.kind === "npc_perception")).toBe(false);
});
