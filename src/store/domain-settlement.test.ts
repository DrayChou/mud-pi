import { expect, test } from "bun:test";
import { loadWorldPack } from "../engine/world-loader.ts";
import { settleRuntimeMutation } from "./domain-settlement.ts";

function metadata(id: string) {
  return { proposalId: id, correlationId: "domain-route", sourceId: "player_engine" };
}

test("runtime movement mutation is translated to a typed movement proposal", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  const destination = Object.values(state.rooms[state.player.roomId]!.exits)[0]!;
  const result = settleRuntimeMutation(state, { kind: "engine/player_moved", toRoomId: destination }, metadata("move"));

  expect(result.accepted).toBe(true);
  expect(result.proposal.payload).toEqual({ kind: "move_player", toRoomId: destination });
});

test("runtime item reward is materialized by the typed item decider", async () => {
  const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
  state.objectives.ask_ticket_clerk!.status = "completed";
  state.objectives.ask_ticket_clerk!.completedTurn = state.turn;
  const result = settleRuntimeMutation(state, {
    kind: "engine/item_reward_granted",
    grantorNpcId: "ticket_clerk",
    templateId: "small_recovery",
    itemId: "typed_reward",
    name: "Typed Reward",
    desc: "A reward materialized by a typed proposal.",
    objectiveId: "ask_ticket_clerk",
    requestedAtTurn: state.turn,
  }, { ...metadata("reward"), sourceId: "ticket_clerk" });

  expect(result.accepted).toBe(true);
  expect(state.items.typed_reward?.rewardTemplateId).toBe("small_recovery");
  expect(state.items.typed_reward?.location).toEqual({ kind: "inventory", ownerId: state.player.id });
  if (result.accepted) expect(result.committedEvents.map(({ event }) => event.kind)).toEqual(["item_created"]);
});
