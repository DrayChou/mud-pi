import { describe, expect, test } from "bun:test";
import { safeGeneratedName, validatePlayerName } from "./player-name.ts";

describe("player name validation", () => {
  test("accepts short names and trims whitespace", () => {
    expect(validatePlayerName("  林舟  ")).toEqual({ ok: true, value: "林舟" });
    expect(validatePlayerName("Erin Moore")).toEqual({ ok: true, value: "Erin Moore" });
  });

  test("allows empty names so AI or preset defaults can name the character", () => {
    expect(validatePlayerName("   ")).toEqual({ ok: true, value: undefined });
  });

  test("rejects long descriptive names", () => {
    const result = validatePlayerName("你知道诡秘之主吗？我就是那里面的主角");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("最多");
  });

  test("rejects sentence-like names", () => {
    const result = validatePlayerName("你是谁？");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("标点");
  });

  test("rejects description-like names", () => {
    const result = validatePlayerName("一个想回家的人");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("角色描述");
  });

  test("truncates unsafe generated names", () => {
    const name = safeGeneratedName("这是一个非常非常非常长的生成姓名？", "角色1");
    expect([...name].length).toBeLessThanOrEqual(16);
    expect(name).not.toContain("？");
    expect(safeGeneratedName("", "角色1")).toBe("角色1");
  });
});
