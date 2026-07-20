import { describe, expect, test } from "bun:test";
import { loadWorldConflictResolver, validateCombatScriptResult } from "./conflict-script.ts";
import { loadWorldPack } from "./world-loader.ts";

 describe("world conflict scripts", () => {
  test("loads a resolver only from inside its world-pack directory", async () => {
    const resolver = await loadWorldConflictResolver("station-dream", "./conflict.ts");
    expect(resolver.id).toBe("station-dream-conflict");
    await expect(loadWorldConflictResolver("station-dream", "../dnd/conflict.ts")).rejects.toThrow(/must use a/);
    await expect(loadWorldConflictResolver("station-dream", "./missing.ts")).rejects.toThrow(/not found/);
  });

  test("rejects invalid numeric data returned by a world script", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const resolver = await loadWorldConflictResolver(state.worldPack, state.conflictScript);
    const target = state.npcs.shadow!;
    const result = resolver.resolve({
      schema: structuredClone(state.schema),
      actor: structuredClone(state.player),
      target: structuredClone(target),
      rules: structuredClone(state.conflictRules!),
      seed: "invalid-frame-test",
      options: {},
    });
    result.actions[0]!.damage = Number.NaN;
    expect(() => validateCombatScriptResult(result, state.player.id, target.id)).toThrow(/invalid presentation frame/);
  });

  test("executes the world script with world-owned parameter bindings", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const resolver = await loadWorldConflictResolver(state.worldPack, state.conflictScript);
    const target = state.npcs.shadow!;
    const result = resolver.resolve({
      schema: structuredClone(state.schema),
      actor: structuredClone(state.player),
      target: structuredClone(target),
      rules: structuredClone(state.conflictRules!),
      seed: "world-script-test",
      options: {},
    });
    expect(validateCombatScriptResult(result, state.player.id, target.id).npc.id).toBe("shadow");
    expect(result.poolKey).toBe("hp");
  });
});
