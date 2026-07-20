import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  agentDir,
  agentSessionDir,
  loadAgentManifest,
  resolveAgentSessionPath,
  saveAgentManifest,
  toAgentRelativePath,
} from "./agents.ts";

const worldIds: string[] = [];

function testWorldId(): string {
  const id = `agents-test-${crypto.randomUUID()}`;
  worldIds.push(id);
  return id;
}

afterEach(async () => {
  await Promise.all(worldIds.splice(0).map((id) => rm(join(import.meta.dir, "../../saves", id), {
    recursive: true,
    force: true,
  })));
});

describe("agent manifest", () => {
  test("defaults to an empty manifest", async () => {
    const manifest = await loadAgentManifest(testWorldId());
    expect(manifest).toEqual({ version: 1, npcs: {} });
  });

  test("stores Pi session paths relative to the save agent directory", async () => {
    const worldId = testWorldId();
    const sessionFile = join(agentSessionDir(worldId), "dm.jsonl");
    const stored = toAgentRelativePath(worldId, sessionFile);

    expect(stored).toBe(join("sessions", "dm.jsonl"));
    expect(resolveAgentSessionPath(worldId, stored)).toBe(sessionFile);

    await saveAgentManifest(worldId, {
      version: 1,
      dm: {
        backend: "pi",
        sessionFile: stored,
        sessionId: "dm-session",
        createdAt: 1,
        updatedAt: 2,
      },
      npcs: {},
    });

    expect(await loadAgentManifest(worldId)).toEqual({
      version: 1,
      dm: {
        backend: "pi",
        sessionFile: stored,
        sessionId: "dm-session",
        createdAt: 1,
        updatedAt: 2,
      },
      npcs: {},
    });
  });

  test("rejects relative paths that escape the agent directory", () => {
    const worldId = testWorldId();
    expect(() => resolveAgentSessionPath(worldId, "../../outside.jsonl")).toThrow();
    expect(() => toAgentRelativePath(worldId, join(agentDir(worldId), "../outside.jsonl"))).toThrow();
  });
});
