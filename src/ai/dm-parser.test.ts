import { describe, expect, test } from "bun:test";
import { parseDmResponse } from "./dm-parser.ts";
import { loadStoryOutcomes, loadWorldPack } from "../engine/world-loader.ts";
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

  test("grants a narrated reward directly to the player inventory", async () => {
    const state = await loadWorldPack("dnd", { fallbackPlayerName: "冒险者" });
    const response = parseDmResponse(
      `<NARRATION>铁匠把一枚护符放进你的手中。</NARRATION><WORLD_UPDATE>{"itemsAdded":[{"id":"forge_charm","name":"炉火护符","desc":"仍带着炉膛的温度。","placement":"inventory","kind":"equipment","equipSlot":"neck","parameterModifiers":[{"parameterId":"ac","operation":"add","value":1}]}]}</WORLD_UPDATE>`,
      state.schema,
      state.player.roomId,
      [],
      state.turn,
      state.player.id
    );
    applyMutations(state, response.mutations);

    expect(state.player.inventory).toContain("forge_charm");
    expect(state.items.forge_charm).toMatchObject({
      kind: "equipment",
      equipSlot: "neck",
      location: { kind: "inventory", ownerId: state.player.id },
      parameterModifiers: [{ parameterId: "ac", operation: "add", value: 1 }],
    });
  });

  test("sanitizes unsafe mechanics on AI-created items", async () => {
    const state = await loadWorldPack("dnd", { fallbackPlayerName: "冒险者" });
    const response = parseDmResponse(
      `<NARRATION>地上躺着一把荒谬的剑。</NARRATION><WORLD_UPDATE>{"itemsAdded":[{"id":"absurd_sword","name":"荒谬之剑","desc":"它不该拥有无限力量。","kind":"equipment","equipSlot":"weapon","parameterModifiers":[{"parameterId":"missing","operation":"add","value":999999},{"parameterId":"str","operation":"rate","value":999}],"effects":[{"code":"recover_parameter","parameterId":"hp","dice":{"count":999,"sides":999}}]}]}</WORLD_UPDATE>`,
      state.schema,
      state.player.roomId
    );
    applyMutations(state, response.mutations);

    expect(state.items.absurd_sword?.parameterModifiers).toEqual([]);
    expect(state.items.absurd_sword?.effects).toEqual([]);
  });

  test("can populate a newly generated room in the same update", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const response = parseDmResponse(
      `<NARRATION>候车室深处露出一间积灰的行李房。</NARRATION><WORLD_UPDATE>{"roomsAdded":[{"id":"DustyLuggageRoom","title":"积灰行李房","desc":"无人认领的箱子堆到天花板。"}],"itemsAdded":[{"id":"brass_luggage_tag","name":"黄铜行李牌","desc":"号码已经磨平。","roomId":"DustyLuggageRoom","placement":"room","kind":"key"}]}</WORLD_UPDATE>`,
      state.schema,
      state.player.roomId
    );
    applyMutations(state, response.mutations);

    expect(state.rooms.DustyLuggageRoom).toBeDefined();
    expect(state.items.brass_luggage_tag?.location).toEqual({
      kind: "room",
      roomId: "DustyLuggageRoom",
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

  test("accepts a configured story outcome proposed by the DM", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const outcomes = await loadStoryOutcomes("station-dream");
    const response = parseDmResponse(
      `<NARRATION>车票上浮现出归途。</NARRATION><WORLD_UPDATE>{"outcomeReached":{"id":"return_with_ticket","reason":"玩家承认了真正的归处。"}}</WORLD_UPDATE>`,
      state.schema,
      state.player.roomId,
      outcomes
    );

    applyMutations(state, response.mutations);

    expect(state.outcome).toMatchObject({
      id: "return_with_ticket",
      type: "success",
      terminal: true,
      reason: "玩家承认了真正的归处。",
    });
  });

  test("rejects a stale story outcome proposal", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const outcomes = await loadStoryOutcomes("station-dream");
    const response = parseDmResponse(
      `<NARRATION>结束。</NARRATION><WORLD_UPDATE>{"outcomeReached":{"id":"return_with_ticket"}}</WORLD_UPDATE>`,
      state.schema,
      state.player.roomId,
      outcomes,
      state.turn
    );
    state.turn += 1;

    applyMutations(state, response.mutations);

    expect(state.outcome).toBeUndefined();
  });

  test("rejects an outcome id not declared by the world pack", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const outcomes = await loadStoryOutcomes("station-dream");
    const response = parseDmResponse(
      `<NARRATION>结束。</NARRATION><WORLD_UPDATE>{"outcomeReached":{"id":"invented_outcome"}}</WORLD_UPDATE>`,
      state.schema,
      state.player.roomId,
      outcomes
    );

    applyMutations(state, response.mutations);

    expect(state.outcome).toBeUndefined();
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
