// ─────────────────────────────────────────────────────────────
// dm-session.ts — Pi SDK DM session wrapper
// ─────────────────────────────────────────────────────────────

import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";

export class DmSession {
  private session!: AgentSession;
  private initialized = false;

  async init(config: Config, worldPack: string): Promise<void> {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    // Resolve model — throws if not found
    const available = await modelRegistry.getAvailable();
    const model = available.find(
      (m) =>
        m.provider === config.dmProvider &&
        (m.id === config.dmModel || m.name === config.dmModel)
    );
    if (!model) {
      const names = available.map((m) => `${m.provider}/${m.id}`).join(", ");
      throw new Error(
        `DM model not found: ${config.dmProvider}/${config.dmModel}\n` +
          `Available: ${names || "(none — install/login to Pi first)"}`
      );
    }

    // Load lore.md from world pack as system prompt context
    const lorePath = join(
      import.meta.dir,
      "../../worlds",
      worldPack,
      "lore.md"
    );
    const loreContent = existsSync(lorePath)
      ? readFileSync(lorePath, "utf-8")
      : "";

    const dmSystemPrompt = buildDmSystemPrompt(loreContent);

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      systemPromptOverride: () => dmSystemPrompt,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      model,
      thinkingLevel: config.dmThinking,
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      noTools: "all",
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
      }),
    });

    this.session = session;
    this.initialized = true;
  }

  async ask(prompt: string): Promise<string> {
    if (!this.initialized) throw new Error("DmSession not initialized");

    let response = "";
    const unsub = this.session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        response += event.assistantMessageEvent.delta;
      }
    });

    await this.session.prompt(prompt);
    unsub();
    return response.trim();
  }

  dispose(): void {
    this.session?.dispose();
  }
}

function buildDmSystemPrompt(loreContent: string): string {
  return `你是一个文字MUD游戏的地下城主（DM）。

${loreContent ? `## 世界观\n\n${loreContent}\n\n` : ""}## 你的职责

每轮你会收到：世界事实、活跃剧情线、当前房间状态、玩家状态、本轮发生的事。

你需要：
1. 用第二人称写出沉浸式叙事（2-4句，不超过120字）
2. 如有必要，通过 WORLD_UPDATE 扩展世界（新房间、新事实、更新剧情线）

## 限制

- 不控制游戏逻辑（HP计算、物品规则由引擎负责）
- 不强制移动玩家
- 叙事不超过120字，精炼有力
- 严格按以下格式返回，不要加任何其他内容：

<NARRATION>
（给玩家看的叙事文字）
</NARRATION>
<WORLD_UPDATE>
{
  "worldFacts": [],
  "factsRemoved": [],
  "plotThreads": [],
  "roomsAdded": [],
  "exitsAdded": [],
  "roomDescUpdates": [],
  "npcsAdded": [],
  "npcsMoved": [],
  "npcsKilled": []
}
</WORLD_UPDATE>`;
}
