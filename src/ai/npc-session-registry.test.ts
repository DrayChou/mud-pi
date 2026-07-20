import { describe, expect, test } from "bun:test";
import type { NpcDef } from "../types/world.ts";
import { parseNpcResponse } from "./npc-session-registry.ts";

const npc: NpcDef = {
  id: "ticket_clerk",
  name: "售票员",
  roomId: "StationHall",
  alive: true,
  personality: "惜字如金",
  controller: "pi_session",
  source: "static",
  stats: { hp: 10 },
  maxStats: { hpMax: 10 },
  hostile: false,
};

describe("NPC session response parsing", () => {
  test("accepts a structured say action", () => {
    expect(parseNpcResponse(
      '{"thought":"这张票很旧","action":{"verb":"say","content":"时刻未到。"}}',
      npc
    )).toEqual({ verb: "say", content: "时刻未到。" });
  });

  test("accepts JSON fenced by the model", () => {
    expect(parseNpcResponse(
      '```json\n{"thought":"沉默更好","action":{"verb":"wait"}}\n```',
      npc
    )).toEqual({ verb: "wait" });
  });

  test("accepts a move intent for later engine validation", () => {
    expect(parseNpcResponse(
      '{"thought":"去站台看看","action":{"verb":"move","direction":"east"}}',
      npc
    )).toEqual({ verb: "move", direction: "east" });
  });

  test("rejects unsupported NPC actions", () => {
    expect(parseNpcResponse(
      '{"action":{"verb":"teleport","content":"Platform"}}',
      npc
    )).toBeNull();
  });
});
