import { describe, expect, test } from "bun:test";
import { projectPublicEvents, type Decider } from "../engine/decide.ts";
import type { ProposalEnvelope } from "../types/proposals.ts";
import type { WorldEvent } from "../types/world-events.ts";
import type { WorldState } from "../types/world.ts";
import { commitPreparedSettlement, prepareSettlement, settle } from "./settlement.ts";

function state(): WorldState {
  return {
    revision: 3, worldId: "test", worldPack: "test", turn: 7, schema: { defs: [] },
    player: { id: "player", name: "Player", roomId: "a", lifecycle: "active", stats: { hp: 5 }, maxStats: { hpMax: 10 }, inventory: ["new", "old"], equipment: { hand: "old" } },
    rooms: { a: { id: "a", title: "A", desc: "A", exits: {}, source: "static", discovered: true } },
    npcs: {},
    items: {
      old: { id: "old", name: "Old", desc: "", location: { kind: "equipped", ownerId: "player", slot: "hand" } },
      new: { id: "new", name: "New", desc: "", location: { kind: "inventory", ownerId: "player" } },
    },
    plotThreads: {}, worldFacts: [], objectives: {},
  };
}

function proposal(expectedRevision = 3): ProposalEnvelope<{ action: string }> {
  return { proposalId: "p1", correlationId: "c1", source: { kind: "engine", id: "engine", sessionId: "private" }, expectedRevision, observedTurn: 7, payload: { action: "test" } };
}

const context = { storyOutcomes: [] } as const;

function accepted(events: readonly [WorldEvent, ...WorldEvent[]]): Decider<{ action: string }, string> {
  return () => ({ accepted: true, result: "ok", events, warnings: [] });
}

describe("settlement", () => {
  test("rejects stale proposals without deciding or mutating state", () => {
    const live = state();
    const before = JSON.stringify(live);
    let called = false;
    const result = settle(live, proposal(2), (() => { called = true; throw new Error("unreachable"); }) as Decider<{ action: string }>, context);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.rejection.code).toBe("stale_revision");
    expect(called).toBe(false);
    expect(JSON.stringify(live)).toBe(before);
    expect(live.revision).toBe(3);
  });

  test("commits multiple events atomically and increments revision once", () => {
    const live = state();
    const root = live;
    const result = settle(live, proposal(), accepted([
      { kind: "item_transferred", itemId: "old", from: { kind: "equipped", ownerId: "player", slot: "hand" }, to: { kind: "inventory", ownerId: "player" } },
      { kind: "item_transferred", itemId: "new", from: { kind: "inventory", ownerId: "player" }, to: { kind: "equipped", ownerId: "player", slot: "hand" } },
    ]), context);
    expect(result.accepted).toBe(true);
    expect(live).toBe(root);
    expect(live.revision).toBe(4);
    expect(live.player.equipment.hand).toBe("new");
    expect(result.committedEvents.map((event) => event.eventId)).toEqual([`${result.transactionId}:0`, `${result.transactionId}:1`]);
    expect(result.committedEvents.every((event) => event.revision === 4)).toBe(true);
  });

  test("an invariant failure in a later event leaves live state byte-equivalent", () => {
    const live = state();
    const before = JSON.stringify(live);
    const result = settle(live, proposal(), accepted([
      { kind: "item_transferred", itemId: "old", from: { kind: "equipped", ownerId: "player", slot: "hand" }, to: { kind: "inventory", ownerId: "player" } },
      { kind: "item_transferred", itemId: "new", from: { kind: "room", roomId: "a" }, to: { kind: "equipped", ownerId: "player", slot: "hand" } },
    ]), context);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.rejection.code).toBe("event_invariant_failed");
    expect(JSON.stringify(live)).toBe(before);
  });

  test("preparation is pure and commit rejects an intervening revision", () => {
    const live = state();
    const prepared = prepareSettlement(live, proposal(), accepted([{ kind: "player_spoke", playerId: "player", roomId: "a", message: "hello" }]), context);
    expect(prepared.accepted).toBe(true);
    expect(live.revision).toBe(3);
    live.revision = 4;
    const committed = commitPreparedSettlement(live, prepared);
    expect(committed.accepted).toBe(false);
    expect(live.revision).toBe(4);
  });

  test("accepted and rejected decisions preserve their result semantics", () => {
    const live = state();
    const rejection = settle(live, proposal(), () => ({ accepted: false, rejection: { code: "precondition_failed", safeMessage: "No.", diagnostic: "blocked", retryable: false }, events: [], warnings: [] }), context);
    expect(rejection.accepted).toBe(false);
    expect(live.revision).toBe(3);
    const success = settle(live, proposal(), accepted([{ kind: "player_spoke", playerId: "player", roomId: "a", message: "hello" }]), context);
    expect(success.accepted).toBe(true);
    if (success.accepted) expect(success.result).toBe("ok");
    expect(live.revision).toBe(4);
  });

  test("projects committed facts without exposing private source metadata", () => {
    const result = settle(state(), proposal(), accepted([{ kind: "player_spoke", playerId: "player", roomId: "a", message: "hello" }]), context);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const projected = projectPublicEvents(result.committedEvents[0]!);
    expect(projected).toEqual([{ kind: "player_spoke", turn: 7, actorId: "player", roomId: "a", message: "hello", targetId: undefined }]);
    expect(JSON.stringify(projected)).not.toContain("private");
  });
});
