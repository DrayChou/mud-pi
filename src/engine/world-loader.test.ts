import { describe, expect, test } from "bun:test";
import { loadWorldPack } from "./world-loader.ts";
import type { ProtagonistProfile } from "../types/world.ts";

describe("loadWorldPack protagonists", () => {
  test("uses the world default protagonist when no custom choice is provided", async () => {
    const state = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
    });

    expect(state.player.profile?.id).toBe("lost_commuter");
    expect(state.player.name).toBe("迟归的通勤者");
    expect(state.player.inventory).toContain("ticket");
    expect(state.player.stats.attack).toBe(6);
    expect(state.player.stats.defense).toBe(3);
  });

  test("lets the player name override the protagonist default name", async () => {
    const state = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
      playerName: "阿月",
    });

    expect(state.player.name).toBe("阿月");
    expect(state.player.profile?.name).toBe("迟归的通勤者");
  });

  test("can load a selected preset protagonist", async () => {
    const state = await loadWorldPack("dnd", {
      fallbackPlayerName: "旅行者",
      protagonistId: "hedge_mage_apprentice",
    });

    expect(state.player.profile?.id).toBe("hedge_mage_apprentice");
    expect(state.player.inventory).toContain("healing_potion");
    expect(state.player.stats.mp).toBe(18);
    expect(state.player.stats.str).toBe(8);
  });

  test("can apply a generated custom protagonist profile", async () => {
    const generated: ProtagonistProfile = {
      id: "custom_returning_passenger",
      name: "林舟",
      summary: "想回家的乘客。",
      background: "你不确定自己为什么在车站醒来。",
      motivation: "找到回家的站台。",
      initialStats: { hp: 90, attack: 5, defense: 4 },
      initialInventory: ["ticket"],
      openingHook: "你听见广播念出了你的名字。",
    };

    const state = await loadWorldPack("station-dream", {
      fallbackPlayerName: "旅行者",
      protagonistProfile: generated,
    });

    expect(state.player.name).toBe("林舟");
    expect(state.player.profile).toEqual(generated);
    expect(state.player.stats.hp).toBe(90);
    expect(state.player.inventory).toContain("ticket");
  });

  test("rejects an unknown protagonist id", async () => {
    await expect(
      loadWorldPack("station-dream", {
        fallbackPlayerName: "旅行者",
        protagonistId: "missing",
      })
    ).rejects.toThrow("Protagonist not found");
  });
});
