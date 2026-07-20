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

  test("requires a completed AI-reward task and prevents duplicate task awards", async () => {
    const state = await loadWorldPack("station-dream", { fallbackPlayerName: "旅行者" });
    const proposal = {
      grantorNpcId: "ticket_clerk",
      templateId: "small_recovery",
      objectiveId: "ask_ticket_clerk",
      itemId: "task_reward_1",
      name: "值班热茶",
      desc: "售票员对你的帮助表示认可。",
      requestedAtTurn: state.turn,
    };
    expect(decideItemRewardGrant(state, proposal)).toEqual({
      accepted: false,
      reason: "关联任务尚未完成或不允许 AI 奖励",
    });

    state.objectives.ask_ticket_clerk!.status = "completed";
    applyMutations(state, [{ kind: "engine/item_reward_granted", ...proposal }]);
    expect(state.items.task_reward_1?.rewardObjectiveId).toBe("ask_ticket_clerk");

    const duplicate = decideItemRewardGrant(state, { ...proposal, itemId: "task_reward_2" });
    expect(duplicate).toEqual({ accepted: false, reason: "关联任务的奖励已经发放" });
  });

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
