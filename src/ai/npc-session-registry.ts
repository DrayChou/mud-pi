// ─────────────────────────────────────────────────────────────
// npc-session-registry.ts — lazy, save-bound sessions for important NPCs
// ─────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import type { Config } from "../config.ts";
import {
  ensureAgentSessionDir,
  loadAgentManifest,
  resolveAgentSessionPath,
  saveAgentManifest,
  toAgentRelativePath,
} from "../store/agents.ts";
import { visibleEntityIds } from "../engine/npc-intents.ts";
import type { NpcDecision, NpcIntent } from "../types/npc.ts";
import type { NpcDef, WorldState } from "../types/world.ts";
import type { AiSession, AiSessionPersistenceOptions } from "./backend.ts";
import { backendForRole, createBackend, modelForRole } from "./backend.ts";

interface RawNpcResponse {
  thought?: unknown;
  action?: {
    verb?: unknown;
    content?: unknown;
    direction?: unknown;
  } | null;
}

export class NpcSessionRegistry {
  private config!: Config;
  private worldId = "";
  private sessions = new Map<string, AiSession>();

  init(config: Config, worldId: string): void {
    this.config = config;
    this.worldId = worldId;
  }

  async respondToPlayerSay(
    state: WorldState,
    message: string,
    target?: string
  ): Promise<NpcDecision[]> {
    const npc = selectNpc(state, target);
    if (!npc) return [];

    const context = {
      requestedAtTurn: state.turn,
      roomId: npc.roomId,
      visibleEntityIds: visibleEntityIds(state, npc.roomId),
    };
    const session = await this.getOrCreate(npc);
    const raw = await session.ask(buildNpcPerceptionPrompt(state, npc, message));
    const intent = parseNpcResponse(raw, npc);
    if (!intent) return [];
    return [{ npcId: npc.id, context, intent }];
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  private async getOrCreate(npc: NpcDef): Promise<AiSession> {
    const existing = this.sessions.get(npc.id);
    if (existing) return existing;
    if (!this.config || !this.worldId) throw new Error("NpcSessionRegistry not initialized");

    const backendName = backendForRole(this.config, "npc");
    const backend = createBackend(backendName);
    const { provider, model } = modelForRole(this.config, "npc");
    const manifest = await loadAgentManifest(this.worldId);
    let persistence: AiSessionPersistenceOptions | undefined;
    let resumed = false;

    if (backendName === "pi") {
      const sessionDir = await ensureAgentSessionDir(this.worldId);
      const stored = manifest.npcs[npc.id];
      if (stored?.backend === "pi" && stored.sessionFile) {
        const sessionFile = resolveAgentSessionPath(this.worldId, stored.sessionFile);
        if (existsSync(sessionFile)) {
          persistence = { mode: "open", sessionDir, sessionFile };
          resumed = true;
        } else {
          console.warn(`[npc:${npc.id}] Pi session file missing; creating a new session`);
          persistence = { mode: "create", sessionDir };
        }
      } else {
        persistence = { mode: "create", sessionDir };
      }
    }

    const session = await backend.createSession({
      role: "npc",
      systemPrompt: buildNpcSystemPrompt(npc),
      provider,
      model,
      thinkingLevel: "low",
      jsonOnly: true,
      persistence,
    });
    this.sessions.set(npc.id, session);

    if (backendName === "pi" && session.info.sessionFile) {
      const now = Date.now();
      const oldRef = manifest.npcs[npc.id];
      manifest.npcs[npc.id] = {
        backend: "pi",
        sessionFile: toAgentRelativePath(this.worldId, session.info.sessionFile),
        sessionId: session.info.sessionId,
        createdAt: resumed && oldRef?.createdAt ? oldRef.createdAt : now,
        updatedAt: now,
      };
      await saveAgentManifest(this.worldId, manifest);
    }

    return session;
  }
}

function selectNpc(state: WorldState, target?: string): NpcDef | undefined {
  const candidates = Object.values(state.npcs).filter(
    (npc) =>
      npc.alive &&
      npc.roomId === state.player.roomId &&
      npc.controller === "pi_session"
  );

  if (target?.trim()) {
    const needle = target.trim().toLowerCase();
    return candidates.find(
      (npc) =>
        npc.id.toLowerCase().includes(needle) ||
        npc.name.toLowerCase().includes(needle) ||
        needle.includes(npc.name.toLowerCase())
    );
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

function buildNpcSystemPrompt(npc: NpcDef): string {
  const persona = npc.persona;
  const goals = persona?.goals?.map((g) => `- ${g}`).join("\n") || "- 按照你的身份和处境行动";
  const constraints = persona?.constraints?.map((c) => `- ${c}`).join("\n") || "- 不主动透露自己不知道的信息";

  return `你是文字 MUD 中的独立 NPC「${npc.name}」，不是 DM，也不是旁白。

[身份与性格]
${npc.personality}
${persona?.background ? `\n[背景]\n${persona.background}` : ""}
${persona?.speechStyle ? `\n[说话方式]\n${persona.speechStyle}` : ""}

[目标]
${goals}

[约束]
${constraints}
- 你只能依据自己的 Pi Session 记忆和本轮提供的感知作出决定。
- 你不知道其他房间发生的事情，除非亲历或被告知。
- 你不能直接改变生命、物品、位置或世界状态。
- 每轮只能选择一个行动：说一句话、沿当前房间出口移动、或保持不动。
- thought 是你的私人想法，不会展示给玩家；不要把 thought 写进台词。

严格返回 JSON，不要 Markdown：
{"thought":"简短的私人想法","action":{"verb":"say","content":"符合角色身份的一句话"}}
{"thought":"简短的私人想法","action":{"verb":"move","direction":"east|west|north|south|up|down"}}
或：
{"thought":"简短的私人想法","action":{"verb":"wait"}}`;
}

function buildNpcPerceptionPrompt(state: WorldState, npc: NpcDef, message: string): string {
  const room = state.rooms[npc.roomId];
  const others = Object.values(state.npcs)
    .filter((other) => other.alive && other.roomId === npc.roomId && other.id !== npc.id)
    .map((other) => `${other.name}（NPC）`);
  others.unshift(`${state.player.name}（玩家）`);

  return `[当前权威状态]
回合：${state.turn}
你的位置：${room?.title ?? npc.roomId}（${npc.roomId}）
你的状态：${npc.alive ? "存活" : "已死亡"}
在场角色：${others.join("、")}

[刚刚感知到]
${state.player.name}对你说：“${message}”

根据你的长期 Pi Session 记忆、身份和当前感知，决定回应或沉默。`;
}

export function parseNpcResponse(raw: string, npc: NpcDef): NpcIntent | null {
  const json = extractJson(raw);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json) as RawNpcResponse;
    const verb = parsed.action?.verb;
    if (verb === "wait" || parsed.action === null) {
      return { verb: "wait" };
    }
    if (verb === "move" && typeof parsed.action?.direction === "string") {
      const direction = parsed.action.direction.trim().slice(0, 20);
      return direction ? { verb: "move", direction } : null;
    }
    if (verb !== "say" || typeof parsed.action?.content !== "string") return null;

    const content = parsed.action.content.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 300);
    if (!content) return null;
    return { verb: "say", content };
  } catch {
    console.warn(`[npc:${npc.id}] failed to parse response`);
    return null;
  }
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const object = trimmed.match(/\{[\s\S]*\}/);
  return object?.[0] ?? null;
}
