// ─────────────────────────────────────────────────────────────
// pi-backend.ts — Pi SDK implementation of AiBackend
// ─────────────────────────────────────────────────────────────

import { mkdirSync } from "node:fs";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { appendAiLog, currentDiagnosticContext } from "../diagnostics/logger.ts";
import type {
  AiBackend,
  AiPromptOptions,
  AiSession,
  AiSessionInfo,
  AiSessionOptions,
} from "./backend.ts";

export class PiBackend implements AiBackend {
  readonly name = "pi" as const;

  async createSession(options: AiSessionOptions): Promise<AiSession> {
    const context = currentDiagnosticContext();
    const startedAt = performance.now();
    const stage = (name: string, extra: Record<string, unknown> = {}) => {
      if (context?.aiCallId) appendAiLog(context.worldId, {
        kind: "pi_session_stage",
        stage: name,
        elapsedMs: Math.round(performance.now() - startedAt),
        role: options.role,
        provider: options.provider,
        model: options.model,
        ...extra,
      });
    };
    stage("create_started");
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    stage("registry_created");
    const model = await resolveModel(modelRegistry, options);
    stage("model_resolved");

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      systemPromptOverride: () => options.systemPrompt,
    });
    await loader.reload();
    stage("resources_loaded");

    const timeoutMs = aiRequestTimeoutMs(options.role);
    const retry = retrySettingsForRole(options.role, timeoutMs);
    const { session } = await createAgentSession({
      model,
      thinkingLevel: options.thinkingLevel ?? "off",
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      noTools: "all",
      sessionManager: sessionManagerFor(options),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: options.role === "dm" || options.role === "npc" },
        httpIdleTimeoutMs: retry.provider.timeoutMs,
        retry,
      }),
    });

    stage("session_created", { sessionId: session.sessionId });
    return new PiAiSession(session, options.role);
  }

  async ask(options: AiPromptOptions): Promise<string> {
    const session = await this.createSession(options);
    try {
      return await session.ask(options.userPrompt);
    } finally {
      session.dispose();
    }
  }
}

class PiAiSession implements AiSession {
  readonly info: AiSessionInfo;

  constructor(private session: AgentSession, private role: AiSessionOptions["role"]) {
    this.info = {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      persistent: session.sessionFile !== undefined,
    };
  }

  async ask(prompt: string): Promise<string> {
    let response = "";
    const context = currentDiagnosticContext();
    const timeoutMs = aiRequestTimeoutMs(this.role);
    const startedAt = performance.now();
    let firstEventRecorded = false;
    let firstTextRecorded = false;
    if (context?.aiCallId) {
      appendAiLog(context.worldId, {
        kind: "pi_request_policy",
        role: this.role,
        timeoutMs,
        retry: retrySettingsForRole(this.role, timeoutMs),
        sessionId: this.info.sessionId,
      });
      appendAiLog(context.worldId, {
        kind: "pi_prompt_started",
        role: this.role,
        sessionId: this.info.sessionId,
      });
    }
    const unsub = this.session.subscribe((event) => {
      if (!firstEventRecorded && context?.aiCallId) {
        firstEventRecorded = true;
        appendAiLog(context.worldId, {
          kind: "pi_first_event",
          eventType: event.type,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      }
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        response += event.assistantMessageEvent.delta;
        if (!firstTextRecorded && context?.aiCallId) {
          firstTextRecorded = true;
          appendAiLog(context.worldId, {
            kind: "pi_first_text_delta",
            elapsedMs: Math.round(performance.now() - startedAt),
          });
        }
      }
      recordPiSessionEvent(event, Math.round(performance.now() - startedAt));
    });

    try {
      await promptWithTimeout(this.session, prompt, timeoutMs);
    } finally {
      unsub();
    }
    if (context?.aiCallId) appendAiLog(context.worldId, {
      kind: "pi_prompt_completed",
      elapsedMs: Math.round(performance.now() - startedAt),
      responseChars: response.length,
    });
    return response.trim();
  }

  dispose(): void {
    this.session.dispose();
  }
}

export async function promptWithTimeout(
  session: Pick<AgentSession, "prompt" | "abort">,
  prompt: string,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`AI request timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([session.prompt(prompt), timeout]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AI request timed out")) {
      await session.abort().catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function retrySettingsForRole(role: AiSessionOptions["role"], timeoutMs: number) {
  const providerTimeoutMs = role === "interpreter"
    ? Math.max(5_000, timeoutMs - 5_000)
    : Math.max(5_000, Math.min(20_000, Math.floor((timeoutMs - 2_000) / 2)));
  return {
    enabled: true,
    maxRetries: role === "interpreter" ? 0 : 1,
    baseDelayMs: 1_000,
    provider: {
      timeoutMs: providerTimeoutMs,
      maxRetries: 0,
      maxRetryDelayMs: 5_000,
    },
  };
}

export function recordPiSessionEvent(event: unknown, elapsedMs?: number): void {
  const context = currentDiagnosticContext();
  if (!context?.aiCallId || !event || typeof event !== "object") return;
  const value = event as Record<string, unknown>;
  switch (value.type) {
    case "auto_retry_start":
      appendAiLog(context.worldId, {
        kind: "pi_auto_retry_start",
        attempt: value.attempt,
        maxAttempts: value.maxAttempts,
        delayMs: value.delayMs,
        providerError: value.errorMessage,
        elapsedMs,
      });
      break;
    case "auto_retry_end":
      appendAiLog(context.worldId, {
        kind: "pi_auto_retry_end",
        success: value.success,
        attempt: value.attempt,
        finalProviderError: value.finalError,
        elapsedMs,
      });
      break;
    case "agent_end":
      appendAiLog(context.worldId, {
        kind: "pi_agent_end",
        willRetry: value.willRetry,
        messageSummary: summarizeAgentMessages(value.messages),
        elapsedMs,
      });
      break;
    case "message_end": {
      const message = value.message as Record<string, unknown> | undefined;
      if (message?.role !== "assistant") break;
      appendAiLog(context.worldId, {
        kind: "pi_assistant_message_end",
        stopReason: message.stopReason,
        providerError: message.errorMessage,
        usage: message.usage,
        elapsedMs,
      });
      break;
    }
  }
}

function summarizeAgentMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return undefined;
  return messages.slice(-3).map((message) => {
    if (!message || typeof message !== "object") return { type: typeof message };
    const value = message as Record<string, unknown>;
    return {
      role: value.role,
      stopReason: value.stopReason,
      errorMessage: value.errorMessage,
      usage: value.usage,
    };
  });
}

export function aiRequestTimeoutMs(role: AiSessionOptions["role"]): number {
  const roleName = role.toUpperCase();
  const fallback = role === "interpreter" ? 15_000 : role === "character" ? 45_000 : 30_000;
  const configured = Number(Bun.env[`AI_${roleName}_TIMEOUT_MS`] ?? Bun.env.AI_REQUEST_TIMEOUT_MS ?? fallback);
  return Number.isFinite(configured) && configured >= 5_000 ? configured : fallback;
}

export function sessionManagerFor(options: AiSessionOptions): SessionManager {
  const persistence = options.persistence;
  if (!persistence || persistence.mode === "memory") {
    return SessionManager.inMemory(process.cwd());
  }

  if (persistence.mode === "create") {
    if (!persistence.sessionDir) {
      throw new Error(`Pi ${options.role} persistent session requires sessionDir`);
    }
    mkdirSync(persistence.sessionDir, { recursive: true });
    return SessionManager.create(process.cwd(), persistence.sessionDir);
  }

  if (!persistence.sessionFile) {
    throw new Error(`Pi ${options.role} session resume requires sessionFile`);
  }
  return SessionManager.open(
    persistence.sessionFile,
    persistence.sessionDir,
    process.cwd()
  );
}

async function resolveModel(
  modelRegistry: ReturnType<typeof ModelRegistry.create>,
  options: AiSessionOptions
) {
  if (!options.provider || !options.model) {
    throw new Error(`Pi backend requires provider/model for ${options.role}`);
  }

  const available = await modelRegistry.getAvailable();
  const model = available.find(
    (m) =>
      m.provider === options.provider &&
      (m.id === options.model || m.name === options.model)
  );
  if (!model) {
    const names = available.map((m) => `${m.provider}/${m.id}`).join(", ");
    throw new Error(
      `Pi ${options.role} model not found: ${options.provider}/${options.model}\n` +
        `Available: ${names || "(none — install/login to Pi first)"}`
    );
  }
  return model;
}
