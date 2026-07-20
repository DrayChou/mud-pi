import { describe, expect, test } from "bun:test";
import { executeCommand } from "./commands.ts";
import { decideItemRewardGrant } from "./item-rewards.ts";
import { loadWorldPack } from "./world-loader.ts";
import { applyMutations } from "../store/apply.ts";

const packs = ["station-dream", "dnd", "cthulhu", "elysium"];

describe("AI item reward templates", () => {
  for (const pack of packs) {
    test(`${pack} materializes only world-owned mechanics and produces usable inventory items`, async () => {
      const state = await loadWorldPack(pack, { fallbackPlayerName: "测试者" });
      const template = state.itemRewardRules!.templates[0]!;
      const proposal = {
        templateId: template.id,
        itemId: `reward_${pack.replace(/-/g, "_")}_turn_1`,
        name: `AI 命名的${template.label}`,
        desc: "AI 只负责世界观名称与描述，机械效果来自世界模板。",
        requestedAtTurn: state.turn,
      };
      const decision = decideItemRewardGrant(state, proposal);
      expect(decision.accepted).toBe(true);
      if (!decision.accepted) return;
      expect(decision.item.effects).toEqual(template.effects ?? []);
      expect(decision.item.parameterModifiers).toEqual(template.parameterModifiers ?? []);

      applyMutations(state, [{ kind: "dm/item_reward_granted", ...proposal }]);
      expect(state.player.inventory).toContain(proposal.itemId);

      const command = template.kind === "equipment"
        ? { verb: "equip", args: { item: proposal.name }, confidence: 1, raw: "equip" }
        : { verb: "use", args: { item: proposal.name }, confidence: 1, raw: "use" };
      const result = executeCommand(state, command);
      expect(result.directReply).toBeUndefined();
      applyMutations(state, result.mutations);
      expect(state.items[proposal.itemId]?.location.kind).toBe(template.kind === "equipment" ? "equipped" : "destroyed");
    });
  }

  test("rejects an NPC reward when the grantor is not in the player's room", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    state.npcs.ticket_clerk!.roomId = "Platform";
    const decision = decideItemRewardGrant(state, {
      grantorNpcId: "ticket_clerk",
      templateId: "small_recovery",
      itemId: "remote_reward",
      name: "远程奖励",
      desc: "不应隔空进入背包。",
      requestedAtTurn: state.turn,
    });
    expect(decision).toEqual({ accepted: false, reason: "赠予者不存在、已死亡或不在玩家面前" });
  });
});
