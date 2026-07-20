import { describe, expect, test } from "bun:test";
import type { CommittedWorldEvent, WorldEvent } from "../types/world-events.ts";
import type { ItemDef } from "../types/world.ts";
import { projectPublicEvents, type PublicProjectionContext } from "./public-events.ts";

function committed(event: WorldEvent, overrides: Partial<CommittedWorldEvent> = {}): CommittedWorldEvent {
  return {
    eventId: "tx-1:0",
    transactionId: "tx-1",
    index: 0,
    revision: 3,
    turn: 7,
    source: { kind: "npc", id: "secret-npc", sessionId: "private-session" },
    correlationId: "private-correlation",
    event,
    ...overrides,
  };
}

const context: PublicProjectionContext = {
  playerId: "player",
  playerRoomId: "hall",
  entityRoomIds: { player: "hall", goblin: "cave" },
};

function item(id: string, location: ItemDef["location"]): ItemDef {
  return { id, name: id, desc: id, location };
}

describe("projectPublicEvents", () => {
  test("projects movement and speech from committed payloads", () => {
    expect(projectPublicEvents(committed({
      kind: "player_moved", playerId: "player", fromRoomId: "yard", toRoomId: "hall",
    }))).toEqual([{
      kind: "player_moved", turn: 7, actorId: "player", fromRoomId: "yard", toRoomId: "hall", roomId: "hall",
    }]);

    expect(projectPublicEvents(committed({
      kind: "player_spoke", playerId: "player", roomId: "hall", message: "Hello", targetId: "guard",
    }))).toEqual([{
      kind: "player_spoke", turn: 7, actorId: "player", roomId: "hall", message: "Hello", targetId: "guard",
    }]);
  });

  test("projects item creation and player inventory grants in order", () => {
    expect(projectPublicEvents(
      committed({ kind: "item_created", item: item("coin", { kind: "inventory", ownerId: "player" }) }),
      context,
    )).toEqual([
      { kind: "item_created", turn: 7, itemId: "coin", roomId: "hall" },
      { kind: "item_granted", turn: 7, actorId: "player", itemId: "coin", roomId: "hall" },
    ]);

    expect(projectPublicEvents(
      committed({ kind: "item_created", item: item("key", { kind: "room", roomId: "vault" }) }),
      context,
    )).toEqual([{ kind: "item_created", turn: 7, itemId: "key", roomId: "vault" }]);
  });

  test("projects pickup, drop, and consumption from exact locations", () => {
    expect(projectPublicEvents(committed({
      kind: "item_transferred", itemId: "coin",
      from: { kind: "room", roomId: "vault" }, to: { kind: "inventory", ownerId: "player" },
    }), context)).toEqual([
      { kind: "item_picked_up", turn: 7, actorId: "player", itemId: "coin", roomId: "vault" },
    ]);

    expect(projectPublicEvents(committed({
      kind: "item_transferred", itemId: "coin",
      from: { kind: "equipped", ownerId: "player", slot: "hand" }, to: { kind: "room", roomId: "hall" },
    }), context)).toEqual([
      { kind: "item_dropped", turn: 7, actorId: "player", itemId: "coin", roomId: "hall" },
    ]);

    expect(projectPublicEvents(committed({
      kind: "item_transferred", itemId: "potion",
      from: { kind: "inventory", ownerId: "player" }, to: { kind: "destroyed" },
    }), context)).toEqual([
      { kind: "item_consumed", turn: 7, actorId: "player", itemId: "potion", roomId: "hall" },
    ]);
  });

  test("only projects decreasing parameters with a stable harm cause", () => {
    expect(projectPublicEvents(committed({
      kind: "parameter_changed", entityId: "goblin", parameterId: "hp", before: 9, after: 4, cause: "harm:combat",
    }), context)).toEqual([
      { kind: "entity_attacked", turn: 7, targetId: "goblin", roomId: "cave", stat: "hp", amount: 5 },
    ]);

    for (const event of [
      { kind: "parameter_changed", entityId: "player", parameterId: "hp", before: 4, after: 9, cause: "heal:item" },
      { kind: "parameter_changed", entityId: "player", parameterId: "mp", before: 9, after: 4, cause: "cost:spell" },
      { kind: "parameter_changed", entityId: "player", parameterId: "hp", before: 9, after: 4, cause: "adjustment" },
    ] satisfies WorldEvent[]) {
      expect(projectPublicEvents(committed(event), context)).toEqual([]);
    }
  });

  test("projects player lifecycle transitions but not recovery or NPC lifecycle", () => {
    expect(projectPublicEvents(committed({
      kind: "lifecycle_changed", entityId: "player", before: "active", after: "incapacitated", cause: "threshold:hp",
    }), context)).toEqual([
      { kind: "player_incapacitated", turn: 7, actorId: "player", roomId: "hall" },
    ]);
    expect(projectPublicEvents(committed({
      kind: "lifecycle_changed", entityId: "player", before: "incapacitated", after: "dead", cause: "threshold:hp",
    }), context)).toEqual([
      { kind: "player_died", turn: 7, actorId: "player", roomId: "hall" },
    ]);
    expect(projectPublicEvents(committed({
      kind: "lifecycle_changed", entityId: "goblin", before: "active", after: "dead", cause: "threshold:hp",
    }), context)).toEqual([]);
  });

  test("projects NPC defeat, critical metadata, and movement", () => {
    expect(projectPublicEvents(committed({
      kind: "npc_defeated", npcId: "oracle", roomId: "temple",
    }), {
      ...context,
      criticalNpcs: { oracle: { deathPolicy: "immediate_outcome", notes: "The prophecy ends." } },
    })).toEqual([
      { kind: "entity_defeated", turn: 7, entityId: "oracle", roomId: "temple" },
      {
        kind: "critical_npc_died", turn: 7, npcId: "oracle", roomId: "temple",
        deathPolicy: "immediate_outcome", notes: "The prophecy ends.",
      },
    ]);

    expect(projectPublicEvents(committed({
      kind: "npc_moved", npcId: "guard", fromRoomId: "gate", toRoomId: "hall",
    }), context)).toEqual([{
      kind: "npc_moved", turn: 7, npcId: "guard", fromRoomId: "gate", toRoomId: "hall", roomId: "hall",
    }]);
  });

  test("projects objective completion using public player context", () => {
    expect(projectPublicEvents(committed({
      kind: "objective_completed", objectiveId: "open-gate", completedTurn: 6,
    }), context)).toEqual([{
      kind: "objective_completed", turn: 7, objectiveId: "open-gate", actorId: "player", roomId: "hall",
    }]);
  });

  test("returns no events for non-public facts and never leaks committed metadata", () => {
    expect(projectPublicEvents(committed({
      kind: "world_fact_added", fact: { text: "secret", tile: null, createdTurn: 7 },
    }), context)).toEqual([]);

    const projected = projectPublicEvents(committed({
      kind: "player_spoke", playerId: "player", roomId: "hall", message: "Safe public words",
    }), context);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("private-session");
    expect(serialized).not.toContain("private-correlation");
    expect(serialized).not.toContain("secret-npc");
    expect(serialized).not.toContain("transactionId");
    expect(serialized).not.toContain("source");
  });
});
