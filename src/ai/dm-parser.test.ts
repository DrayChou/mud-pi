import { describe, expect, test } from "bun:test";
import { parseDmResponse } from "./dm-parser.ts";
import { loadWorldPack } from "../engine/world-loader.ts";
import { applyMutations } from "../store/apply.ts";
import { executeCommand } from "../engine/commands.ts";
import type { ParsedCommand } from "./interpreter.ts";

describe("DM-created interactive items", () => {
  test("registers a narrated item in the current room", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    const raw = `<NARRATION>木箱旁散落着几枚深色鳞片。</NARRATION>
<WORLD_UPDATE>
{"itemsAdded":[{"id":"dark_scale","name":"深色鳞片","desc":"厚而暗，边缘泛着不自然的虹彩。","portable":true}]}
</WORLD_UPDATE>`;

    const response = parseDmResponse(raw, state.schema, state.player.roomId);
    applyMutations(state, response.mutations);

    expect(state.items.dark_scale).toMatchObject({
      id: "dark_scale",
      name: "深色鳞片",
      portable: true,
      source: "dm_generated",
      location: { kind: "room", roomId: state.player.roomId },
    });
  });

  test("a registered narrative item can be picked up with a partial name", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    const response = parseDmResponse(
      `<NARRATION>你发现一枚深色鳞片。</NARRATION><WORLD_UPDATE>{"itemsAdded":[{"id":"dark_scale","name":"深色鳞片","desc":"带着腥味。","aliases":["鳞片","鱼人的鳞片"]}]}</WORLD_UPDATE>`,
      state.schema,
      state.player.roomId
    );
    applyMutations(state, response.mutations);

    const result = executeCommand(state, {
      verb: "get",
      args: { item: "鱼人的鳞片" },
      confidence: 1,
      raw: "捡起鳞片",
    } as ParsedCommand);
    applyMutations(state, result.mutations);

    expect(state.player.inventory).toContain("dark_scale");
    expect(state.items.dark_scale?.location).toEqual({
      kind: "inventory",
      ownerId: state.player.id,
    });
  });

  test("rejects a DM item placed in a nonexistent room", async () => {
    const state = await loadWorldPack("cthulhu", { fallbackPlayerName: "调查员" });
    const response = parseDmResponse(
      `<NARRATION>虚空中有东西。</NARRATION><WORLD_UPDATE>{"itemsAdded":[{"id":"void_item","name":"虚空物","desc":"不应存在。","roomId":"MissingRoom"}]}</WORLD_UPDATE>`,
      state.schema,
      state.player.roomId
    );

    applyMutations(state, response.mutations);

    expect(state.items.void_item).toBeUndefined();
  });
});
