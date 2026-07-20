import { describe, expect, test } from "bun:test";
import { applyParameterModifiers, effectivePlayerStats, effectivePlayerTraits } from "./parameters.ts";
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
