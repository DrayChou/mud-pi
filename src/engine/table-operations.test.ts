import { expect, test } from "bun:test";
import { normalizeTableOperations } from "./table-operations.ts";
import type { DmMutation } from "../types/mutations.ts";

const room = {
  id: "vault",
  title: "地下室",
  desc: "潮湿地下室",
  exits: {},
  source: "dm_generated" as const,
  discovered: false,
};

test("normalizes legacy and GM wire formats into dependency-safe phases", () => {
  const legacy: DmMutation[] = [
    { kind: "dm/fact_added", text: "门已打开", tile: "hall" },
    { kind: "dm/room_exit_added", roomId: "hall", direction: "down", toRoomId: "vault" },
    { kind: "dm/room_added", room },
    { kind: "dm/outcome_reached", outcome: { id: "done", type: "success", title: "结束", summary: "结束", terminal: true, reachedTurn: 1 }, requestedAtTurn: 1 },
  ];
  const plan = normalizeTableOperations(legacy, [
    { kind: "move_player", toRoomId: "vault" },
  ]);

  expect(plan.map((entry) => [entry.phase, entry.operation.kind])).toEqual([
    ["materialize", "dm/room_added"],
    ["topology", "dm/room_exit_added"],
    ["state", "dm/fact_added"],
    ["state", "move_player"],
    ["outcome", "dm/outcome_reached"],
  ]);
});
