import { readdir } from "node:fs/promises";

interface RecordLine {
  kind?: string;
  ts?: string;
  worldId?: string;
  requestId?: string;
  aiCallId?: string;
  role?: string;
  provider?: string;
  model?: string;
  status?: string;
  durationMs?: number;
  phase?: string;
  providerError?: string;
  finalProviderError?: string;
  error?: { message?: string };
}

const requestedWorld = process.argv[2];
const records: RecordLine[] = [];
for (const worldId of await readdir("saves")) {
  if (requestedWorld && worldId !== requestedWorld) continue;
  const file = Bun.file(`saves/${worldId}/logs/ai-requests.jsonl`);
  if (!(await file.exists())) continue;
  for (const line of (await file.text()).split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* A process may have ended during the final append. */ }
  }
}

const requests = records.filter((record) => record.kind === "ai_request");
for (const role of ["interpreter", "dm", "npc", "character"]) {
  const roleRequests = requests.filter((record) => record.role === role);
  const successful = roleRequests.filter((record) => record.status === "completed" && typeof record.durationMs === "number");
  const durations = successful.map((record) => record.durationMs!).sort((a, b) => a - b);
  const failed = roleRequests.filter((record) => record.status === "failed");
  console.log(JSON.stringify({
    role,
    calls: roleRequests.length,
    completed: successful.length,
    failed: failed.length,
    latencyMs: durations.length ? {
      min: durations[0],
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.at(-1),
    } : undefined,
    failures: failed.map((record) => ({
      ts: record.ts,
      worldId: record.worldId,
      requestId: record.requestId,
      aiCallId: record.aiCallId,
      provider: record.provider,
      model: record.model,
      durationMs: record.durationMs,
      error: record.error?.message,
    })),
  }, null, 2));
}

const retries = records.filter((record) => record.kind === "pi_auto_retry_start" || record.kind === "pi_auto_retry_end");
if (retries.length > 0) {
  console.log("\nPi provider retries:");
  for (const retry of retries) console.log(JSON.stringify(retry));
}

function percentile(values: number[], ratio: number): number {
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * ratio))]!;
}
