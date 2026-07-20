import { describe, expect, test } from "bun:test";
import type { Decider } from "../engine/decide.ts";
import type { ProposalEnvelope } from "../types/proposals.ts";
import type { WorldEvent } from "../types/world-events.ts";
import type { WorldState } from "../types/world.ts";
import { commitPreparedSettlement, prepareSettlement, settle, settleBatch } from "./settlement.ts";

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

  test("returns the prior settlement when the same proposal id is retried", () => {
    const live = state();
    const first = settle(live, proposal(), accepted([{ kind: "player_spoke", playerId: "player", roomId: "a", message: "hello" }]), context);
    expect(first.accepted).toBe(true);
    expect(live.revision).toBe(4);

    let decidedAgain = false;
    const retried = settle(
      live,
      { ...proposal(4), payload: { action: "changed" } },
      (() => { decidedAgain = true; throw new Error("must not decide twice"); }) as Decider<{ action: string }, string>,
      context,
    );
    expect(retried).toBe(first);
    expect(decidedAgain).toBe(false);
    expect(live.revision).toBe(4);
  });

  test("returns the prior rejection when the same proposal id is retried after revision changes", () => {
    const live = state();
    const rejected = settle(live, proposal(), () => ({
      accepted: false,
      rejection: { code: "precondition_failed", safeMessage: "No.", diagnostic: "blocked", retryable: true },
      events: [],
      warnings: [],
    }), context);
    expect(rejected.accepted).toBe(false);

    live.revision = 4;
    let decidedAgain = false;
    const retried = settle(
      live,
      { ...proposal(4), payload: { action: "now-valid" } },
      (() => { decidedAgain = true; throw new Error("must not decide rejected proposal twice"); }) as Decider<{ action: string }, string>,
      context,
    );
    expect(retried as unknown).toBe(rejected);
    expect(decidedAgain).toBe(false);
    expect(live.revision).toBe(4);
  });

  test("settles a batch from one observed revision and continues after sibling rejection", () => {
    const live = state();
    const result = settleBatch(live, {
      batchId: "batch-1",
      correlationId: "correlation-1",
      source: { kind: "dm", id: "dm" },
      expectedRevision: 3,
      observedTurn: 7,
      proposals: [
        { proposalId: "batch-child-1", payload: { action: "first" } },
        { proposalId: "batch-child-2", payload: { action: "reject" } },
        { proposalId: "batch-child-3", payload: { action: "third" } },
      ],
    }, (snapshot, child) => child.payload.action === "reject"
      ? { accepted: false, rejection: { code: "precondition_failed", safeMessage: "No.", diagnostic: "blocked", retryable: false }, events: [], warnings: [] }
      : {
          accepted: true,
          result: child.payload.action,
          events: [{ kind: "player_spoke", playerId: snapshot.player.id, roomId: snapshot.player.roomId, message: child.payload.action }],
          warnings: [],
        }, context);

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.settlements.map((settlement) => settlement.accepted)).toEqual([true, false, true]);
    expect(result.allAccepted).toBe(false);
    expect(result.revisionBefore).toBe(3);
    expect(result.revisionAfter).toBe(5);
    expect(live.revision).toBe(5);
  });

  test("returns prior child settlements when a completed batch is retried", () => {
    const live = state();
    const batch = {
      batchId: "batch-retry",
      correlationId: "correlation-retry",
      source: { kind: "dm" as const, id: "dm" },
      expectedRevision: 3,
      observedTurn: 7,
      proposals: [{ proposalId: "retry-child", payload: { action: "once" } }],
    };
    let decisions = 0;
    const decider = (snapshot: WorldState, child: ProposalEnvelope<{ action: string }>) => {
      decisions += 1;
      return {
        accepted: true as const,
        result: child.payload.action,
        events: [{ kind: "player_spoke" as const, playerId: snapshot.player.id, roomId: snapshot.player.roomId, message: child.payload.action }] as const,
        warnings: [],
      };
    };

    const first = settleBatch(live, batch, decider, context);
    const retry = settleBatch(live, batch, decider, context);

    expect(first.accepted).toBe(true);
    expect(retry).toEqual(first);
    expect(decisions).toBe(1);
    expect(live.revision).toBe(4);
  });

  test("prevents an unrelated settlement from interleaving with an active batch", () => {
    const live = state();
    let externalAccepted: boolean | undefined;
    const result = settleBatch(live, {
      batchId: "batch-locked",
      correlationId: "correlation-locked",
      source: { kind: "dm", id: "dm" },
      expectedRevision: 3,
      observedTurn: 7,
      proposals: [{ proposalId: "locked-child", payload: { action: "inside" } }],
    }, (snapshot, child) => {
      const external = settle(
        live,
        { ...proposal(3), proposalId: "external-during-batch" },
        accepted([{ kind: "player_spoke", playerId: "player", roomId: "a", message: "external" }]),
        context,
      );
      externalAccepted = external.accepted;
      return {
        accepted: true,
        result: child.payload.action,
        events: [{ kind: "player_spoke", playerId: snapshot.player.id, roomId: snapshot.player.roomId, message: child.payload.action }],
        warnings: [],
      };
    }, context);

    expect(result.accepted).toBe(true);
    expect(externalAccepted).toBe(false);
    expect(live.revision).toBe(4);
    if (result.accepted) expect(result.settlements[0]?.accepted).toBe(true);
  });

  test("rejects a stale batch before deciding any child", () => {
    const live = state();
    let decisions = 0;
    const result = settleBatch(live, {
      batchId: "batch-stale",
      correlationId: "correlation-stale",
      source: { kind: "dm", id: "dm" },
      expectedRevision: 2,
      observedTurn: 7,
      proposals: [{ proposalId: "stale-child", payload: { action: "never" } }],
    }, (() => { decisions += 1; throw new Error("unreachable"); }) as Decider<{ action: string }, string>, context);

    expect(result.accepted).toBe(false);
    expect(decisions).toBe(0);
    expect(live.revision).toBe(3);
  });

  test("accepted and rejected decisions preserve their result semantics", () => {
    const live = state();
    const rejection = settle(live, proposal(), () => ({ accepted: false, rejection: { code: "precondition_failed", safeMessage: "No.", diagnostic: "blocked", retryable: false }, events: [], warnings: [] }), context);
    expect(rejection.accepted).toBe(false);
    expect(live.revision).toBe(3);
    const success = settle(live, { ...proposal(), proposalId: "p2" }, accepted([{ kind: "player_spoke", playerId: "player", roomId: "a", message: "hello" }]), context);
    expect(success.accepted).toBe(true);
    if (success.accepted) expect(success.result).toBe("ok");
    expect(live.revision).toBe(4);
  });
});
