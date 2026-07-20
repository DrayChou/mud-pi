import { describe, expect, test } from "bun:test";
import { executeCommand } from "./commands.ts";
import { loadWorldPack } from "./world-loader.ts";
import { applyMutations } from "../store/apply.ts";
import type { ParsedCommand } from "../ai/interpreter.ts";

function command(verb: string, args: Record<string, string>): ParsedCommand {
  return { verb, args, confidence: 1 } as ParsedCommand;
}

describe("progress commands", () => {
  test("shows visible objectives and a reached story outcome", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.objectives.ask_ticket_clerk!.status = "completed";
    state.outcome = {
      id: "return_with_ticket",
      type: "success",
      title: "有票者的归途",
      summary: "列车终于启动。",
      terminal: true,
      reachedTurn: 4,
    };

    const result = executeCommand(state, command("objectives", {}));

    expect(result.directReply).toContain("✓ 询问归途");
    expect(result.directReply).toContain("○ 登上列车");
    expect(result.directReply).toContain("故事结果：有票者的归途");
  });
});

describe("lifecycle command guards", () => {
  test("blocks physical actions after player death", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.player.lifecycle = "dead";

    const blocked = executeCommand(state, command("go", { direction: "east" }));
    const status = executeCommand(state, command("status", {}));

    expect(blocked.directReply).toContain("已经死亡");
    expect(status.directReply).toContain(state.player.name);
  });

  test("blocks further story actions after a terminal outcome", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.outcome = {
      id: "done",
      type: "failure",
      title: "结束",
      summary: "故事结束。",
      terminal: true,
      reachedTurn: 1,
    };

    const result = executeCommand(state, command("say", { message: "继续" }));
    expect(result.directReply).toContain("故事已经结束");
  });
});

describe("combat commands", () => {
  test("resolves the whole fight once and returns presentation frames", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.player.roomId = "Compartment3";

    const result = executeCommand(state, command("attack", { target: "阴影" }));
    applyMutations(state, result.mutations);

    expect(result.combatContext?.winner).toBe("player");
    expect(result.combatContext?.actions.length).toBeGreaterThan(1);
    expect(result.combatContext?.player.speed).toBe(9);
    expect(state.npcs.shadow?.alive).toBe(false);
    expect(state.player.stats.hp).toBe(result.combatContext?.player.poolAfter);
  });
});

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
