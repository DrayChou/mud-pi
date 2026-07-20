import { describe, expect, test } from "bun:test";
import { loadWorldPack } from "./world-loader.ts";
import { buildMapSnapshot, formatTextMap } from "./map.ts";
import { applyMutation } from "../store/apply.ts";
import { executeCommand } from "./commands.ts";
import type { ParsedCommand } from "../ai/interpreter.ts";

describe("map exploration", () => {
  test("starts with only the spawn room discovered and hides unknown titles", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });

    const snapshot = buildMapSnapshot(state);
    const text = formatTextMap(snapshot);

    expect(snapshot.rooms.map((room) => room.id)).toEqual(["StationHall"]);
    expect(text).toContain("* 车站入口大厅");
    expect(text).toContain("east→未知区域");
    expect(text).not.toContain("候车站台");
  });

  test("discovers and timestamps a room when the player enters it", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });

    applyMutation(state, { kind: "engine/player_moved", toRoomId: "Platform" });

    expect(state.rooms.Platform?.discovered).toBe(true);
    expect(state.rooms.Platform?.visitedTurn).toBe(1);
    const snapshot = buildMapSnapshot(state);
    expect(snapshot.rooms.map((room) => room.id)).toEqual(["StationHall", "Platform"]);
    expect(formatTextMap(snapshot)).toContain("west→车站入口大厅");
  });

  test("map command is a direct informational command", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const result = executeCommand(state, {
      verb: "map",
      args: {},
      confidence: 1,
      raw: "地图",
    } as ParsedCommand);

    expect(result.mutations).toEqual([]);
    expect(result.directReply).toContain("已探索地图");
  });
});
