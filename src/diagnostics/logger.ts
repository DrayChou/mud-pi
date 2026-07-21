import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type RuntimeChannel = "cli" | "tui" | "telnet" | "web" | "test" | "system";

export interface DiagnosticContext {
  worldId: string;
  requestId: string;
  channel: RuntimeChannel;
  turn?: number;
  revision?: number;
  aiCallId?: string;
}

interface DiagnosticRecord {
  kind: string;
  ts?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<DiagnosticContext>();

export function currentDiagnosticContext(): DiagnosticContext | undefined {
  return storage.getStore();
}

export function runWithDiagnosticContext<T>(context: DiagnosticContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function appendOperationLog(worldId: string, record: DiagnosticRecord): void {
  appendLog(worldId, "operations.jsonl", record);
}

export function appendAiLog(worldId: string, record: DiagnosticRecord): void {
  appendLog(worldId, "ai-requests.jsonl", record);
}

export function appendErrorLog(worldId: string, record: DiagnosticRecord): void {
  appendLog(worldId, "errors.jsonl", record);
}

export function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}

function appendLog(worldId: string, filename: string, record: DiagnosticRecord): void {
  const context = currentDiagnosticContext();
  if (!context) return;
  const safeWorldId = worldId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const directory = join(import.meta.dir, "../../saves", safeWorldId, "logs");
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, filename), `${JSON.stringify({
    schemaVersion: 1,
    ts: record.ts ?? new Date().toISOString(),
    ...(context ?? {}),
    ...record,
  })}\n`, "utf8");
}
