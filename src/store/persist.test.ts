import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadWorldPack } from "../engine/world-loader.ts";
import { loadState } from "./persist.ts";

const createdSaveIds: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdSaveIds.splice(0).map((id) =>
      rm(join(import.meta.dir, "../../saves", id), { recursive: true, force: true })
    )
  );
});

describe("state compatibility", () => {
  test("recovers item locations for saves created before item locations existed", async () => {
    const state = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
      protagonistId: "runaway_guard",
    });
    state.worldId = `persist-legacy-items-${Date.now()}-${Math.random()}`;
    createdSaveIds.push(state.worldId);

    const legacyState = structuredClone(state) as unknown as {
      items: Record<string, { location?: unknown }>;
      player: { inventory: string[]; equipment: Record<string, string> };
      objectives?: unknown;
      endingRules?: unknown;
    };
    delete legacyState.items.ticket?.location;
    delete legacyState.items.rusty_knife?.location;
    delete legacyState.objectives;
    delete legacyState.endingRules;
    legacyState.player.inventory.push("ticket");

    const dir = join(import.meta.dir, "../../saves", state.worldId);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "state.json"), JSON.stringify(legacyState));

    const loaded = await loadState(state.worldId);

    expect(loaded?.items.ticket?.location).toEqual({
      kind: "inventory",
      ownerId: "player1",
    });
    expect(loaded?.items.rusty_knife?.location).toEqual({
      kind: "room",
      roomId: "Compartment1",
    });
    expect(loaded?.objectives.ask_ticket_clerk?.status).toBe("active");
    expect(loaded?.endingRules).toHaveLength(2);
  });
});
