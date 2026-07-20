// ─────────────────────────────────────────────────────────────
// agents.ts — persisted references to Pi's native session JSONL files
// ─────────────────────────────────────────────────────────────

import type { AiBackendName } from "../config.ts";

export interface AgentSessionRef {
  backend: AiBackendName;
  /** Path relative to saves/{worldId}/agents/. */
  sessionFile?: string;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentManifest {
  version: 1;
  dm?: AgentSessionRef;
  npcs: Record<string, AgentSessionRef>;
}

export function emptyAgentManifest(): AgentManifest {
  return { version: 1, npcs: {} };
}
