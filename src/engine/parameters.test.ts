import { describe, expect, test } from "bun:test";
import {
  applyParameterModifiers,
  baseDeltaForEffectivePlayerChange,
  effectivePlayerStats,
  effectivePlayerTraits,
} from "./parameters.ts";
import { loadWorldPack } from "./world-loader.ts";

 describe("RPG Maker-style parameters", () => {
  test("applies flat equipment bonuses before multiplicative rates", () => {
    expect(applyParameterModifiers(
      { power: 10, guard: 8 },
      [
        { parameterId: "power", operation: "add", value: 5 },
        { parameterId: "power", operation: "rate", value: 1.2 },
        { parameterId: "guard", operation: "add", value: 2 },
      ]
    )).toEqual({ power: 18, guard: 10 });
  });

  test("does not turn recovery into an infinite base delta when an invalid zero rate exists", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.items.zero_rate_relic = {
      id: "zero_rate_relic",
      name: "凝滞遗物",
      desc: "测试用。",
      kind: "equipment",
      equipSlot: "relic",
      location: { kind: "equipped", ownerId: state.player.id, slot: "relic" },
      parameterModifiers: [{ parameterId: "hp", operation: "rate", value: 0 }],
    };
    state.player.equipment.relic = "zero_rate_relic";

    expect(baseDeltaForEffectivePlayerChange(state, "hp", 10)).toBe(0);
  });

  test("aggregates world-defined condition modifiers and traits once per stack", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.conditionDefinitions.focused = {
      id: "focused", label: "专注", stacking: "stack", maxStacks: 3,
      parameterModifiers: [{ parameterId: "accuracy", operation: "add", value: 2 }],
      traits: [{ code: "focused", value: 1 }],
    };
    state.conditions[`${state.player.id}:focused`] = {
      conditionId: "focused", targetEntityId: state.player.id, stacks: 2, appliedRevision: 1, appliedTurn: 0,
    };

    expect(effectivePlayerStats(state).accuracy).toBe(state.player.stats.accuracy! + 4);
    expect(effectivePlayerTraits(state).filter((trait) => trait.code === "focused")).toHaveLength(2);
  });

  test("derives effective values from equipped world-pack items without changing base stats", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.player.inventory = state.player.inventory.filter((id) => id !== "rusty_knife");
    state.player.equipment.weapon = "rusty_knife";
    state.items.rusty_knife!.location = { kind: "equipped", ownerId: state.player.id, slot: "weapon" };
    const baseAttack = state.player.stats.attack!;

    const effective = effectivePlayerStats(state);

    expect(effective.attack).toBe(baseAttack + 3);
    expect(effective.accuracy).toBe(state.player.stats.accuracy! + 1);
    expect(state.player.stats.attack).toBe(baseAttack);
    expect(effectivePlayerTraits(state)).toContainEqual({
      code: "weapon_family",
      dataId: "blade",
      value: 1,
    });
  });
});
