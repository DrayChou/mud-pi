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
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = await resolveModel(modelRegistry, options);

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      systemPromptOverride: () => options.systemPrompt,
    });
    await loader.reload();

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
      }),
    });

    return new PiAiSession(session);
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

  constructor(private session: AgentSession) {
    this.info = {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      persistent: session.sessionFile !== undefined,
    };
  }

  async ask(prompt: string): Promise<string> {
    let response = "";
    const unsub = this.session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        response += event.assistantMessageEvent.delta;
      }
    });

    try {
      await this.session.prompt(prompt);
    } finally {
      unsub();
    }
    return response.trim();
  }

  dispose(): void {
    this.session.dispose();
  }
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
