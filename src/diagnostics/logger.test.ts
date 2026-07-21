import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  appendAiLog,
  appendOperationLog,
  runWithDiagnosticContext,
} from "./logger.ts";

const worldId = `diagnostics-test-${crypto.randomUUID()}`;
const saveDir = join(import.meta.dir, "../../saves", worldId);

afterEach(async () => {
  await rm(saveDir, { recursive: true, force: true });
});

test("writes correlated operation and AI records under the save", async () => {
  await runWithDiagnosticContext({
    worldId,
    requestId: "request-1",
    channel: "test",
    turn: 3,
    revision: 8,
  }, async () => {
    appendOperationLog(worldId, { kind: "runtime_operation_started", input: "向北走" });
    await Promise.resolve();
    appendAiLog(worldId, { kind: "ai_request", aiCallId: "ai-1", prompt: "prompt", response: "response" });
  });

  const operation = JSON.parse((await Bun.file(join(saveDir, "logs/operations.jsonl")).text()).trim());
  const ai = JSON.parse((await Bun.file(join(saveDir, "logs/ai-requests.jsonl")).text()).trim());
  expect(operation).toMatchObject({ schemaVersion: 1, worldId, requestId: "request-1", channel: "test", turn: 3, revision: 8 });
  expect(ai).toMatchObject({ worldId, requestId: "request-1", aiCallId: "ai-1", prompt: "prompt", response: "response" });
});

test("does not create diagnostics outside an operation context", async () => {
  appendOperationLog(worldId, { kind: "ignored" });
  expect(await Bun.file(join(saveDir, "logs/operations.jsonl")).exists()).toBe(false);
});
