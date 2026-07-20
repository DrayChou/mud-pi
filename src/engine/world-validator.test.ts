import { describe, expect, test } from "bun:test";
import { listWorldPacks, loadWorldPack, loadWorldPackSummary } from "./world-loader.ts";
import { validateWorldPack, type WorldPackForValidation } from "./world-validator.ts";

const BUILTIN_WORLDS = ["station-dream", "cthulhu", "dnd", "elysium"];

describe("validateWorldPack", () => {
  test("lists built-in world packs for startup selection", async () => {
    const worlds = await listWorldPacks();
    expect(worlds.map((w) => w.id)).toEqual(["cthulhu", "dnd", "elysium", "station-dream"]);
    expect(worlds.every((w) => w.name.length > 0)).toBe(true);
  });
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

  test("requires a persona for persistent NPC sessions", () => {
    const pack = basePack();
    pack.npcs[0]!.controller = "pi_session";

    expect(() => validateWorldPack(pack, "missing-persona")).toThrow(/uses pi_session but has no persona/);
  });

  test("rejects invalid world-owned conflict rules", () => {
    const pack = basePack();
    pack.conflictRules = {
      mode: "auto_combat",
      algorithm: "gauge-random-v1",
      baseHitChance: 2,
      normalDamageMin: 2,
      normalDamageMax: 1,
      critMultiplier: 0.5,
    };
    expect(() => validateWorldPack(pack, "broken-conflict")).toThrow(/baseHitChance must be between 0 and 1/);
    expect(() => validateWorldPack(pack, "broken-conflict")).toThrow(/normalDamageMax cannot be smaller/);
    expect(() => validateWorldPack(pack, "broken-conflict")).toThrow(/critMultiplier must be at least 1/);
  });

  test("rejects invalid procedural map configuration", () => {
    const pack = basePack();
    pack.proceduralMap = {
      generator: "seeded-mst-v1",
      totalRooms: { min: 0, max: 100 },
      loopChance: 2,
      attachTo: "MissingRoom",
      templates: [],
    };

    expect(() => validateWorldPack(pack, "broken-generator")).toThrow(/attachTo references missing room/);
    expect(() => validateWorldPack(pack, "broken-generator")).toThrow(/totalRooms.min cannot be smaller/);
    expect(() => validateWorldPack(pack, "broken-generator")).toThrow(/loopChance must be between 0 and 1/);
    expect(() => validateWorldPack(pack, "broken-generator")).toThrow(/requires room templates/);
  });

  test("rejects objective references and outcomes without package criteria", () => {
    const pack = basePack();
    pack.objectives = [{
      id: "find",
      title: "Find",
      description: "Find it",
      requires: ["missing-objective"],
      completion: { kind: "acquire_item", itemId: "missing-item" },
    }];
    pack.outcomes = [{
      id: "end",
      type: "failure",
      title: "End",
      summary: "Done",
      criteria: "",
      terminal: true,
    }];

    expect(() => validateWorldPack(pack, "broken-progress")).toThrow(/requires missing objective/);
    expect(() => validateWorldPack(pack, "broken-progress")).toThrow(/references missing item/);
    expect(() => validateWorldPack(pack, "broken-progress")).toThrow(/outcome end has empty criteria/);
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
