import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { aiRequestTimeoutMs, promptWithTimeout, sessionManagerFor } from "./pi-backend.ts";

const dirs: string[] = [];

function tempSessionDir(): string {
  const dir = join(import.meta.dir, `../../saves/pi-session-test-${crypto.randomUUID()}`);
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("uses a short interpreter deadline and bounded narrative deadlines", () => {
  expect(aiRequestTimeoutMs("interpreter")).toBe(15_000);
  expect(aiRequestTimeoutMs("dm")).toBe(60_000);
  expect(aiRequestTimeoutMs("npc")).toBe(60_000);
  expect(aiRequestTimeoutMs("character")).toBe(60_000);
});

test("Pi request timeout aborts provider retries instead of waiting indefinitely", async () => {
  let aborted = false;
  const session = {
    prompt: async () => await new Promise<void>(() => {}),
    abort: async () => { aborted = true; },
  };
  await expect(promptWithTimeout(session as never, "prompt", 5)).rejects.toThrow("timed out after 5ms");
  expect(aborted).toBe(true);
});

describe("Pi session persistence", () => {
  test("creates and reopens Pi's native JSONL session", async () => {
    const sessionDir = tempSessionDir();
    const created = sessionManagerFor({
      role: "dm",
      systemPrompt: "test",
      persistence: { mode: "create", sessionDir },
    });

    // Pi intentionally delays creating the JSONL until the first assistant message.
    created.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "remember this" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const sessionFile = created.getSessionFile();
    expect(sessionFile).toBeDefined();
    expect(sessionFile?.endsWith(".jsonl")).toBe(true);

    const text = await Bun.file(sessionFile!).text();
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0].type).toBe("session");
    expect(lines.some((entry) => entry.type === "message" && entry.message.role === "assistant")).toBe(true);

    const reopened = sessionManagerFor({
      role: "dm",
      systemPrompt: "test",
      persistence: { mode: "open", sessionDir, sessionFile },
    });
    expect(reopened.getSessionId()).toBe(created.getSessionId());
    expect(reopened.buildSessionContext().messages.length).toBe(1);
  });

  test("keeps transient roles in memory by default", () => {
    const manager = sessionManagerFor({ role: "interpreter", systemPrompt: "test" });
    expect(manager.isPersisted()).toBe(false);
    expect(manager.getSessionFile()).toBeUndefined();
  });
});
