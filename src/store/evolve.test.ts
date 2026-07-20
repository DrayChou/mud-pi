import { describe, expect, test } from "bun:test";
import type { WorldState } from "../types/world.ts";
import { EventInvariantError, evolve } from "./evolve.ts";

function state(): WorldState {
  return {
    revision: 0,
    worldId: "test", worldPack: "test", turn: 2,
    schema: { defs: [{ key: "hp", label: "HP", min: 0, max: 10, default: 10, display: "number" }] },
    player: { id: "player", name: "Player", roomId: "a", lifecycle: "active", stats: { hp: 5 }, maxStats: { hpMax: 10 }, inventory: ["sword", "shield"], equipment: { hand: "sword" } },
    rooms: {
      a: { id: "a", title: "A", desc: "A", exits: {}, source: "static", discovered: true },
      b: { id: "b", title: "B", desc: "B", exits: {}, source: "static", discovered: false },
    },
    npcs: { foe: { id: "foe", name: "Foe", roomId: "a", alive: true, personality: "", source: "static", stats: { hp: 4 }, maxStats: { hpMax: 4 }, hostile: true } },
    items: {
      sword: { id: "sword", name: "Sword", desc: "", location: { kind: "equipped", ownerId: "player", slot: "hand" } },
      shield: { id: "shield", name: "Shield", desc: "", location: { kind: "inventory", ownerId: "player" } },
    },
    plotThreads: {}, worldFacts: [], objectives: {},
  };
}

describe("evolve", () => {
  test("replays exact parameter and lifecycle facts deterministically", () => {
    const initial = state();
    const replay = structuredClone(initial);
    const events = [
      { kind: "parameter_changed", entityId: "player", parameterId: "hp", before: 5, after: 0, cause: "harm:combat" } as const,
      { kind: "lifecycle_changed", entityId: "player", before: "active", after: "dead", cause: "threshold:hp" } as const,
    ];
    for (const event of events) evolve(initial, event);
    for (const event of events) evolve(replay, event);
    expect(replay).toEqual(initial);
    expect(initial.player.stats.hp).toBe(0);
    expect(initial.player.lifecycle).toBe("dead");
  });

  test("requires exact before values", () => {
    const initial = state();
    expect(() => evolve(initial, { kind: "parameter_changed", entityId: "player", parameterId: "hp", before: 6, after: 2, cause: "harm:test" })).toThrow(EventInvariantError);
    expect(initial.player.stats.hp).toBe(5);
  });

  test("updates inventory and equipment from ordered exact transfers", () => {
    const initial = state();
    evolve(initial, { kind: "item_transferred", itemId: "sword", from: { kind: "equipped", ownerId: "player", slot: "hand" }, to: { kind: "inventory", ownerId: "player" } });
    evolve(initial, { kind: "item_transferred", itemId: "shield", from: { kind: "inventory", ownerId: "player" }, to: { kind: "equipped", ownerId: "player", slot: "hand" } });
    expect(initial.player.equipment).toEqual({ hand: "shield" });
    expect(initial.player.inventory).toEqual(["sword", "shield"]);
  });
});
