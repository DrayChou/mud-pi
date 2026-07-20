// ─────────────────────────────────────────────────────────────
// dm-session.ts — DM session wrapper over configurable AI backend
// ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import {
  ensureAgentSessionDir,
  loadAgentManifest,
  resolveAgentSessionPath,
  saveAgentManifest,
  toAgentRelativePath,
} from "../store/agents.ts";
import type { AiSession, AiSessionPersistenceOptions } from "./backend.ts";
import { backendForRole, createBackend, modelForRole } from "./backend.ts";

export interface DmSessionInitOptions {
  config: Config;
  worldId: string;
  worldPack: string;
  resume: boolean;
}

export interface DmSessionInitResult {
  resumed: boolean;
  recoveryNeeded: boolean;
  sessionFile?: string;
}

export class DmSession {
  private session!: AiSession;
  private initialized = false;

  async init(options: DmSessionInitOptions): Promise<DmSessionInitResult> {
    const { config, worldId, worldPack, resume } = options;
    const lorePath = join(import.meta.dir, "../../worlds", worldPack, "lore.md");
    const loreContent = existsSync(lorePath) ? readFileSync(lorePath, "utf-8") : "";

    const dmSystemPrompt = buildDmSystemPrompt(loreContent);
    const backendName = backendForRole(config, "dm");
    const backend = createBackend(backendName);
    const { provider, model } = modelForRole(config, "dm");
    const manifest = await loadAgentManifest(worldId);

    let resumed = false;
    let recoveryNeeded = false;
    let persistence: AiSessionPersistenceOptions | undefined;

    if (backendName === "pi") {
      const sessionDir = await ensureAgentSessionDir(worldId);
      const stored = resume && manifest.dm?.backend === "pi"
        ? manifest.dm.sessionFile
        : undefined;

      if (stored) {
        const sessionFile = resolveAgentSessionPath(worldId, stored);
        if (existsSync(sessionFile)) {
          persistence = { mode: "open", sessionDir, sessionFile };
          resumed = true;
        } else {
          console.warn(`[dm] Pi session file missing; creating a recovery session: ${sessionFile}`);
          persistence = { mode: "create", sessionDir };
          recoveryNeeded = true;
        }
      } else {
        persistence = { mode: "create", sessionDir };
        recoveryNeeded = resume;
      }
    }

    this.session = await backend.createSession({
      role: "dm",
      systemPrompt: dmSystemPrompt,
      provider,
      model,
      thinkingLevel: config.dmThinking,
      persistence,
    });
    this.initialized = true;

    if (backendName === "pi" && this.session.info.sessionFile) {
      const now = Date.now();
      const previousCreatedAt = manifest.dm?.createdAt;
      manifest.dm = {
        backend: "pi",
        sessionFile: toAgentRelativePath(worldId, this.session.info.sessionFile),
        sessionId: this.session.info.sessionId,
        createdAt: resumed && previousCreatedAt ? previousCreatedAt : now,
        updatedAt: now,
      };
      await saveAgentManifest(worldId, manifest);
    }

    return {
      resumed,
      recoveryNeeded,
      sessionFile: this.session.info.sessionFile,
    };
  }

  async ask(prompt: string): Promise<string> {
    if (!this.initialized) throw new Error("DmSession not initialized");
    return await this.session.ask(prompt);
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
2. 如有必要，通过 WORLD_UPDATE 扩展世界（新房间、新事实、可交互道具、更新剧情线）
3. 叙事中新出现且玩家可以检查、拾取或使用的具体道具，必须在同一轮写入 itemsAdded；否则引擎无法让玩家与它交互

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
  "itemsAdded": [],
  "npcsAdded": [],
  "npcsMoved": [],
  "npcsKilled": []
}
</WORLD_UPDATE>`;
}
