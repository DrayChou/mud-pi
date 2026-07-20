import { describe, expect, test } from "bun:test";
import { loadWorldPack } from "./world-loader.ts";
import {
  generateProceduralMap,
  PROCEDURAL_MAP_VERSION,
  type ProceduralMapConfig,
} from "./procedural-map.ts";
import type { RoomDef } from "../types/world.ts";

const config: ProceduralMapConfig = {
  generator: PROCEDURAL_MAP_VERSION,
  totalRooms: { min: 8, max: 12 },
  loopChance: 0.15,
  attachTo: "start",
  templates: [
    { title: "房间 {n}", desc: "由种子生成的房间 {n}" },
    { title: "回廊 {n}", desc: "由种子生成的回廊 {n}" },
  ],
};

function startRoom(): Record<string, RoomDef> {
  return {
    start: {
      id: "start",
      title: "入口",
      desc: "入口",
      exits: {},
      source: "static",
      discovered: true,
      visitedTurn: 0,
    },
  };
}

describe("deterministic procedural map", () => {
  test("reproduces the exact room graph for the same seed", () => {
    const first = generateProceduralMap({ seed: "same-seed", config, staticRooms: startRoom() });
    const second = generateProceduralMap({ seed: "same-seed", config, staticRooms: startRoom() });
    const different = generateProceduralMap({ seed: "other-seed", config, staticRooms: startRoom() });

    expect(second).toEqual(first);
    expect(different).not.toEqual(first);
  });

  test("creates 8-12 connected rooms from an MST with a bounded loop budget", () => {
    for (const seed of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
      const generated = generateProceduralMap({ seed, config, staticRooms: startRoom() });
      const ids = Object.keys(generated.rooms);
      const visited = new Set<string>(["start"]);
      const queue = ["start"];
      while (queue.length > 0) {
        const room = generated.rooms[queue.shift()!]!;
        for (const target of Object.values(room.exits)) {
          if (!visited.has(target)) {
            visited.add(target);
            queue.push(target);
          }
        }
      }

      expect(ids.length).toBeGreaterThanOrEqual(8);
      expect(ids.length).toBeLessThanOrEqual(12);
      expect(visited.size).toBe(ids.length);
      expect(generated.generation.mstEdges).toBe(ids.length - 1);
      expect(generated.generation.loopEdges).toBeLessThanOrEqual(
        Math.round((ids.length - 1) * config.loopChance)
      );
      expect(Object.values(generated.generation.roomRoles)).toContain("entrance");
      expect(Object.values(generated.generation.roomRoles)).toContain("boss");
      expect(Object.values(generated.generation.roomRoles)).toContain("treasure");
      expect(Object.values(generated.generation.roomRoles)).toContain("special");
    }
  });

  test("station-dream persists generation metadata and hides generated rooms initially", async () => {
    const first = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
      seed: "station-test-seed",
    });
    const second = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
      seed: "station-test-seed",
    });

    expect(first.generation?.seed).toBe("station-test-seed");
    expect(first.generation?.generatorVersion).toBe(PROCEDURAL_MAP_VERSION);
    expect(first.rooms).toEqual(second.rooms);
    expect(Object.keys(first.rooms).length).toBeGreaterThanOrEqual(8);
    expect(first.generation?.generatedRoomIds.every((id) => first.rooms[id]?.discovered === false)).toBe(true);
  });
});
