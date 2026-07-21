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
  test("resolves pronouns or body parts against the only hostile target and equips an explicit firearm", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    state.player.roomId = "HarborsideWharf";
    const revolver = state.items.revolver!;
    revolver.location = { kind: "inventory", ownerId: state.player.id };
    state.player.inventory.push(revolver.id);

    const result = executeCommand(state, command("attack", { target: "眼睛", weapon: "左轮手枪" }));

    expect(result.directReply).toBeUndefined();
    expect(result.mutations[0]).toEqual({ kind: "engine/item_equipped", itemId: "revolver", slot: "weapon" });
    expect(result.mutations[1]).toEqual({ kind: "engine/combat_started", npcId: "deep_one" });
    expect(result.combatContext?.player.attack).toBe(23);
  });

  test("matches plural group wording to a registered narrated NPC", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    state.player.roomId = "MiskULibrary";
    state.npcs.polluted_professor = {
      ...structuredClone(state.npcs.librarian!),
      id: "polluted_professor",
      name: "被污染的失踪教授",
      roomId: "MiskULibrary",
      alive: true,
      hostile: false,
      stats: { ...state.npcs.librarian!.stats, hp: 5 },
    };

    const result = executeCommand(state, { ...command("attack", { target: "教授们" }), raw: "开枪打死这些教授" });

    expect(result.directReply).toBeUndefined();
    expect(result.mutations.some((mutation) => mutation.kind === "engine/combat_started" && mutation.npcId === "polluted_professor")).toBe(true);
  });

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

describe("scene interaction commands", () => {
  test("routes doors and other scenery to the Pi GM instead of treating them as inventory", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    state.player.roomId = "MiskULibrary";

    const misclassifiedUse = executeCommand(state, { ...command("use", { item: "坚固密门" }), raw: "推开坚固密门" });
    const interaction = executeCommand(state, { ...command("interact", { target: "坚固密门", approach: "轻轻推开" }), raw: "轻轻推开门" });

    expect(misclassifiedUse.directReply).toBeUndefined();
    expect(interaction.directReply).toBeUndefined();
  });

  test("lets the GM adjudicate narrated paths while preserving exact direction shortcuts", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    state.player.roomId = "MiskULibrary";

    const semantic = executeCommand(state, { ...command("go", { direction: "down", approach: "潜行并观察" }), raw: "慢慢走下去，不要弄出声响" });
    const shortcut = executeCommand(state, { ...command("go", { direction: "down" }), raw: "down" });

    expect(semantic.directReply).toBeUndefined();
    expect(shortcut.directReply).toContain("没有出路");
  });
});

describe("item commands", () => {
  test("uses world-script item effects and consumes configured items", async () => {
    const state = await loadWorldPack("dnd", { fallbackPlayerName: "冒险者" });
    state.player.stats.hp = 5;

    const result = executeCommand(state, command("use", { item: "治愈药水" }));
    applyMutations(state, result.mutations);

    expect(state.player.stats.hp).toBeGreaterThanOrEqual(9);
    expect(state.player.stats.hp).toBeLessThanOrEqual(15);
    expect(state.player.inventory).not.toContain("healing_potion");
    expect(state.items.healing_potion?.location).toEqual({ kind: "destroyed" });
  });

  test("equips only world-pack equipment in its declared slot", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.player.inventory.push("rusty_knife");
    state.items.rusty_knife!.location = { kind: "inventory", ownerId: state.player.id };

    const equip = executeCommand(state, command("equip", { item: "锈铁刀" }));
    const reject = executeCommand(state, command("equip", { item: "车票" }));

    expect(equip.mutations).toEqual([{ kind: "engine/item_equipped", itemId: "rusty_knife", slot: "weapon" }]);
    expect(reject.directReply).toContain("不是可装备物品");
  });

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
