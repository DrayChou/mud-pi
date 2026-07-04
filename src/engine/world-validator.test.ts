import { describe, expect, test } from "bun:test";
import { loadWorldPack, loadWorldPackSummary } from "./world-loader.ts";
import { validateWorldPack, type WorldPackForValidation } from "./world-validator.ts";

const BUILTIN_WORLDS = ["station-dream", "cthulhu", "dnd", "elysium"];

describe("validateWorldPack", () => {
  test("all built-in world packs validate and load", async () => {
    for (const world of BUILTIN_WORLDS) {
      const summary = await loadWorldPackSummary(world);
      const state = await loadWorldPack(world, { fallbackPlayerName: "旅行者" });

      expect(summary.name.length).toBeGreaterThan(0);
      expect(state.player.roomId).toBe(summary.bornPoint);
      expect(state.player.profile?.id).toBe(summary.defaultProtagonistId);
    }
  });

  test("rejects invalid cross references and duplicate protagonist ids", () => {
    const pack = basePack();
    pack.defaultProtagonistId = "missing";
    pack.protagonists = [
      {
        id: "hero",
        name: "Hero",
        summary: "A hero",
        background: "Background",
        motivation: "Motivation",
        initialStats: { missingStat: 1 },
        initialInventory: ["missingItem"],
      },
      {
        id: "hero",
        name: "Hero 2",
        summary: "Another hero",
        background: "Background",
        motivation: "Motivation",
      },
    ];
    pack.rooms[0]!.exits.east = "MissingRoom";
    pack.items[0]!.inRoom = "MissingRoom";
    pack.npcs[0]!.roomId = "MissingRoom";

    expect(() => validateWorldPack(pack, "broken")).toThrow(/Invalid world pack broken/);
    expect(() => validateWorldPack(pack, "broken")).toThrow(/duplicate protagonist id: hero/);
    expect(() => validateWorldPack(pack, "broken")).toThrow(/defaultProtagonistId references missing protagonist/);
    expect(() => validateWorldPack(pack, "broken")).toThrow(/initialInventory references missing item/);
    expect(() => validateWorldPack(pack, "broken")).toThrow(/exit east references missing room/);
  });

  test("rejects stat values outside schema bounds", () => {
    const pack = basePack();
    pack.playerStats = { hp: 999 };

    expect(() => validateWorldPack(pack, "broken-stats")).toThrow(/playerStats.hp 999 is outside 0-10/);
  });
});

function basePack(): WorldPackForValidation {
  return {
    name: "Test World",
    bornPoint: "Start",
    schema: {
      defs: [
        {
          key: "hp",
          label: "HP",
          min: 0,
          max: 10,
          default: 10,
          display: "bar",
          onDeplete: "death",
          role: "pool",
        },
      ],
    },
    playerStats: { hp: 10 },
    defaultProtagonistId: "hero",
    protagonists: [
      {
        id: "hero",
        name: "Hero",
        summary: "A hero",
        background: "Background",
        motivation: "Motivation",
        initialStats: { hp: 9 },
        initialInventory: ["item"],
      },
    ],
    rooms: [{ id: "Start", exits: {} }],
    npcs: [{ id: "npc", roomId: "Start", stats: { hp: 5 } }],
    items: [{ id: "item", inRoom: "Start" }],
  };
}
