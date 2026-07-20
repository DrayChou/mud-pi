// ─────────────────────────────────────────────────────────────
// backend.ts — shared AI backend abstraction
// ─────────────────────────────────────────────────────────────

import type { Config, AiBackendName } from "../config.ts";
import { CodexBackend } from "./codex-backend.ts";
import { PiBackend } from "./pi-backend.ts";

export type AiRole = "dm" | "npc" | "interpreter" | "character";

export interface AiSessionPersistenceOptions {
  mode: "memory" | "create" | "open";
  sessionDir?: string;
  sessionFile?: string;
}

export interface AiSessionOptions {
  role: AiRole;
  systemPrompt: string;
  provider?: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  jsonOnly?: boolean;
  persistence?: AiSessionPersistenceOptions;
}

export interface AiPromptOptions extends AiSessionOptions {
  userPrompt: string;
}

export interface AiSessionInfo {
  sessionId?: string;
  sessionFile?: string;
  persistent: boolean;
}

export interface AiSession {
  readonly info: AiSessionInfo;
  ask(prompt: string): Promise<string>;
  dispose(): void;
}

export interface AiBackend {
  readonly name: AiBackendName;
  createSession(options: AiSessionOptions): Promise<AiSession>;
  ask(options: AiPromptOptions): Promise<string>;
}

export function createBackend(name: AiBackendName): AiBackend {
  switch (name) {
    case "pi":
      return new PiBackend();
    case "codex":
      return new CodexBackend();
  }
}

export function backendForRole(config: Config, role: AiRole): AiBackendName {
  switch (role) {
    case "dm":
    case "npc":
      return config.dmBackend;
    case "interpreter":
      return config.interpreterBackend;
    case "character":
      return config.characterBackend;
  }
}

export function modelForRole(
  config: Config,
  role: AiRole
): { provider?: string; model?: string } {
  const backend = backendForRole(config, role);
  if (backend === "codex") {
    switch (role) {
      case "dm":
      case "npc":
        return { model: config.codexDmModel };
      case "interpreter":
        return { model: config.codexInterpreterModel };
      case "character":
        return { model: config.codexCharacterModel };
    }
  }

  switch (role) {
    case "dm":
    case "npc":
    case "character":
      return { provider: config.dmProvider, model: config.dmModel };
    case "interpreter":
      return { provider: config.interpreterProvider, model: config.interpreterModel };
  }
}

export function backendLabel(config: Config, role: AiRole): string {
  const backend = backendForRole(config, role);
  const { provider, model } = modelForRole(config, role);
  if (backend === "codex") return model ? `codex/${model}` : "codex/(default)";
  return `${provider}/${model}`;
}
