// ─────────────────────────────────────────────────────────────
// backend.ts — shared AI backend abstraction
// ─────────────────────────────────────────────────────────────

import type { Config, AiBackendName } from "../config.ts";
import {
  appendAiLog,
  appendErrorLog,
  currentDiagnosticContext,
  serializeError,
} from "../diagnostics/logger.ts";
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
  const backend = createRawBackend(name);
  return {
    name: backend.name,
    async createSession(options) {
      const session = await backend.createSession(options);
      return {
        info: session.info,
        ask: (prompt) => loggedAiCall(backend.name, options, prompt, () => session.ask(prompt)),
        dispose: () => session.dispose(),
      };
    },
    ask(options) {
      return loggedAiCall(backend.name, options, options.userPrompt, () => backend.ask(options));
    },
  };
}

function createRawBackend(name: AiBackendName): AiBackend {
  switch (name) {
    case "pi": return new PiBackend();
    case "codex": return new CodexBackend();
  }
}

async function loggedAiCall(
  backend: AiBackendName,
  options: AiSessionOptions,
  prompt: string,
  call: () => Promise<string>,
): Promise<string> {
  const context = currentDiagnosticContext();
  if (!context) return await call();
  const aiCallId = crypto.randomUUID();
  const startedAt = performance.now();
  try {
    const response = await call();
    appendAiLog(context.worldId, {
      kind: "ai_request",
      aiCallId,
      backend,
      role: options.role,
      phase: inferAiPhase(options.role, prompt),
      provider: options.provider,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      jsonOnly: options.jsonOnly ?? false,
      systemPrompt: options.systemPrompt,
      prompt,
      response,
      promptChars: prompt.length,
      responseChars: response.length,
      durationMs: Math.round(performance.now() - startedAt),
      status: "completed",
    });
    return response;
  } catch (error) {
    const diagnosticError = serializeError(error);
    appendAiLog(context.worldId, {
      kind: "ai_request",
      aiCallId,
      backend,
      role: options.role,
      phase: inferAiPhase(options.role, prompt),
      provider: options.provider,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      jsonOnly: options.jsonOnly ?? false,
      systemPrompt: options.systemPrompt,
      prompt,
      promptChars: prompt.length,
      durationMs: Math.round(performance.now() - startedAt),
      status: "failed",
      error: diagnosticError,
    });
    appendErrorLog(context.worldId, { kind: "ai_error", aiCallId, role: options.role, error: diagnosticError });
    throw error;
  }
}

function inferAiPhase(role: AiRole, prompt: string): string {
  if (role === "interpreter") return "interpret_input";
  if (role === "character") return "generate_character";
  if (role === "npc") return "npc_decision";
  if (prompt.includes("SESSION_RECOVERED") || prompt.includes("会话恢复")) return "dm_recovery";
  if (prompt.includes("叙述修正") || prompt.includes("只返回修正后的 <NARRATION>")) return "dm_narration_correction";
  return "dm_turn";
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
