import { describe, expect, test } from "bun:test";
import { executeCommand } from "./commands.ts";
import { loadWorldPack } from "./world-loader.ts";
import { applyMutations } from "../store/apply.ts";
import type { ParsedCommand } from "../ai/interpreter.ts";

function command(verb: string, args: Record<string, string>): ParsedCommand {
  return { verb, args, confidence: 1 } as ParsedCommand;
}

describe("item commands", () => {
  test("cannot pick up an item from another room", async () => {
    const state = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
      protagonistId: "runaway_guard",
    });

    const result = executeCommand(state, command("get", { item: "锈铁刀" }));

    expect(result.mutations).toEqual([]);
    expect(result.directReply).toBeUndefined();
    expect(state.player.inventory).not.toContain("rusty_knife");
  });

  test("picks up only an item in the current room", async () => {
    const state = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
      protagonistId: "runaway_guard",
    });
    state.player.roomId = "Compartment1";

    const result = executeCommand(state, command("get", { item: "锈铁刀" }));
    applyMutations(state, result.mutations);

    expect(state.player.inventory).toContain("rusty_knife");
    expect(state.items.rusty_knife?.location).toEqual({
      kind: "inventory",
      ownerId: state.player.id,
    });
  });

  test("drops an equipped item into the current room", async () => {
    const state = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
      protagonistId: "runaway_guard",
    });
    state.player.roomId = "Compartment1";

    const getResult = executeCommand(state, command("get", { item: "锈铁刀" }));
    applyMutations(state, getResult.mutations);
    const equipResult = executeCommand(state, command("equip", { item: "锈铁刀" }));
    applyMutations(state, equipResult.mutations);
    expect(state.items.rusty_knife?.location.kind).toBe("equipped");

    const dropResult = executeCommand(state, command("drop", { item: "锈铁刀" }));
    applyMutations(state, dropResult.mutations);

    expect(state.player.inventory).not.toContain("rusty_knife");
    expect(state.player.equipment.weapon).toBeUndefined();
    expect(state.items.rusty_knife?.location).toEqual({
      kind: "room",
      roomId: "Compartment1",
    });
  });

  test("rejects a stale pickup mutation after the player moved away", async () => {
    const state = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
      protagonistId: "runaway_guard",
    });
    state.player.roomId = "Compartment1";
    const result = executeCommand(state, command("get", { item: "锈铁刀" }));
    state.player.roomId = "Compartment2";

    applyMutations(state, result.mutations);

    expect(state.player.inventory).not.toContain("rusty_knife");
    expect(state.items.rusty_knife?.location).toEqual({
      kind: "room",
      roomId: "Compartment1",
    });
  });
});
