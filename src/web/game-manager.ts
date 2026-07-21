import { join } from "node:path";
import { loadConfig, type Config } from "../config.ts";
import { backendLabel } from "../ai/backend.ts";
import { DmSession } from "../ai/dm-session.ts";
import { buildDmRecoveryPrompt } from "../ai/dm-prompt.ts";
import { Interpreter } from "../ai/interpreter.ts";
import { NpcSessionRegistry } from "../ai/npc-session-registry.ts";
import { loadWorldConflictResolver } from "../engine/conflict-script.ts";
import { effectivePlayerStats } from "../engine/parameters.ts";
import { listWorldPacks, loadStoryOutcomes, loadWorldPack, loadWorldPackSummary } from "../engine/world-loader.ts";
import { GameRuntime } from "../runtime/game-runtime.ts";
import { initSave, loadState, loadTurns } from "../store/persist.ts";
import type { GameOutput } from "../runtime/game-output.ts";
import type { WorldState } from "../types/world.ts";
import { runWithDiagnosticContext } from "../diagnostics/logger.ts";

interface ManagedGame {
  runtime: GameRuntime;
  dm: DmSession;
  npcs: NpcSessionRegistry;
  token: string;
  chain: Promise<unknown>;
}

export interface WebGameView {
  worldId: string;
  worldPack: string;
  worldName: string;
  turn: number;
  revision: number;
  player: {
    name: string;
    lifecycle: string;
    stats: Record<string, number>;
    inventory: Array<{ id: string; name: string; equipped: boolean }>;
  };
  room: {
    id: string;
    title: string;
    desc: string;
    exits: string[];
    items: Array<{ id: string; name: string }>;
    npcs: Array<{ id: string; name: string }>;
  };
  objectives: Array<{ id: string; title: string; description: string; status: string }>;
  outcome?: { id: string; title: string; summary: string; terminal: boolean };
}

export class WebGameManager {
  private readonly config: Config;
  private readonly games = new Map<string, ManagedGame>();

  constructor(config = loadConfig()) {
    this.config = config;
  }

  async worlds() {
    return await listWorldPacks();
  }

  async createGame(input: { worldPack: string; playerName?: string; protagonistId?: string; seed?: string }) {
    const summary = await loadWorldPackSummary(input.worldPack);
    const profile = input.protagonistId
      ? summary.protagonists.find((candidate) => candidate.id === input.protagonistId)
      : summary.protagonists.find((candidate) => candidate.id === summary.defaultProtagonistId) ?? summary.protagonists[0];
    if (input.protagonistId && !profile) throw new Error("未知的预设主角");
    const state = await loadWorldPack(input.worldPack, {
      fallbackPlayerName: this.config.defaultPlayerName,
      playerName: input.playerName,
      protagonistProfile: profile,
      seed: input.seed,
    });
    await initSave(state);
    const token = crypto.randomUUID();
    await Bun.write(accessFile(state.worldId), JSON.stringify({ schemaVersion: 1, token, createdAt: new Date().toISOString() }));
    const game = await this.initialize(state, false, token);
    this.games.set(state.worldId, game);
    try {
      const opening = await this.exclusive(game, () => game.runtime.processOpening());
      return { sessionId: state.worldId, token, outputs: opening.outputs, state: projectGame(state) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        sessionId: state.worldId,
        token,
        outputs: [{ kind: "direct_reply" as const, text: `Pi DM 暂时没有完成开场（${message}）。会话已经保存，你可以直接描述第一个行动重试。` }],
        openingError: message,
        state: projectGame(state),
      };
    }
  }

  async resume(worldId: string, token: string) {
    const game = await this.authorizedGame(worldId, token);
    const turns = await loadTurns(worldId);
    return {
      sessionId: worldId,
      outputs: [] as GameOutput[],
      history: turns.slice(-30).flatMap((turn) => [
        ...(turn.playerInput.startsWith("开始游戏") ? [] : [{ type: "player", text: `你：${turn.playerInput}` }]),
        ...(turn.narration ? [{ type: "narration", text: turn.narration }] : []),
      ]),
      state: projectGame(game.runtime.state),
    };
  }

  async input(worldId: string, token: string, text: string) {
    const game = await this.authorizedGame(worldId, token);
    const result = await this.exclusive(game, () => game.runtime.processInput(text));
    return { ...result, state: projectGame(game.runtime.state) };
  }

  async shutdown(): Promise<void> {
    for (const game of this.games.values()) {
      await game.runtime.save();
      game.dm.dispose();
      game.npcs.dispose();
    }
    this.games.clear();
  }

  private async authorizedGame(worldId: string, token: string): Promise<ManagedGame> {
    const existing = this.games.get(worldId);
    if (existing) {
      if (!safeTokenEqual(existing.token, token)) throw new Error("存档访问凭证无效");
      return existing;
    }
    const access = await readAccess(worldId);
    if (!access || !safeTokenEqual(access.token, token)) throw new Error("存档访问凭证无效");
    const state = await loadState(worldId);
    if (!state) throw new Error("存档不存在");
    const game = await this.initialize(state, true, access.token);
    this.games.set(worldId, game);
    return game;
  }

  private async initialize(state: WorldState, resume: boolean, token: string): Promise<ManagedGame> {
    const dm = new DmSession();
    const interpreter = new Interpreter();
    const npcs = new NpcSessionRegistry();
    npcs.init(this.config, state.worldId);
    const [dmInit, storyOutcomes, conflictResolver] = await Promise.all([
      dm.init({ config: this.config, worldId: state.worldId, worldPack: state.worldPack, resume }),
      loadStoryOutcomes(state.worldPack),
      loadWorldConflictResolver(state.worldPack, state.conflictScript),
      interpreter.init(this.config),
    ]);
    if (dmInit.recoveryNeeded) {
      const turns = await loadTurns(state.worldId);
      await runWithDiagnosticContext({
        worldId: state.worldId,
        requestId: crypto.randomUUID(),
        channel: "web",
        turn: state.turn,
        revision: state.revision,
      }, () => dm.ask(buildDmRecoveryPrompt(state, turns.slice(-20))));
    }
    return {
      token,
      dm,
      npcs,
      chain: Promise.resolve(),
      runtime: new GameRuntime({
        state,
        storyOutcomes,
        interpreter,
        dm,
        npcSessions: npcs,
        dmModelLabel: backendLabel(this.config, "dm"),
        conflictResolver,
        channel: "web",
      }),
    };
  }

  private async exclusive<T>(game: ManagedGame, operation: () => Promise<T>): Promise<T> {
    const run = game.chain.then(operation, operation);
    game.chain = run.then(() => undefined, () => undefined);
    return await run;
  }
}

function projectGame(state: WorldState): WebGameView {
  const room = state.rooms[state.player.roomId];
  if (!room) throw new Error(`当前房间不存在：${state.player.roomId}`);
  return {
    worldId: state.worldId,
    worldPack: state.worldPack,
    worldName: state.worldPack,
    turn: state.turn,
    revision: state.revision,
    player: {
      name: state.player.name,
      lifecycle: state.player.lifecycle,
      stats: effectivePlayerStats(state),
      inventory: state.player.inventory.map((id) => ({
        id,
        name: state.items[id]?.name ?? id,
        equipped: Object.values(state.player.equipment).includes(id),
      })),
    },
    room: {
      id: room.id,
      title: room.title,
      desc: room.desc,
      exits: Object.keys(room.exits),
      items: Object.values(state.items).filter((item) => item.location.kind === "room" && item.location.roomId === room.id).map(({ id, name }) => ({ id, name })),
      npcs: Object.values(state.npcs).filter((npc) => npc.alive && npc.roomId === room.id).map(({ id, name }) => ({ id, name })),
    },
    objectives: Object.values(state.objectives).filter((objective) => !objective.hidden).map(({ id, title, description, status }) => ({ id, title, description, status })),
    outcome: state.outcome ? {
      id: state.outcome.id,
      title: state.outcome.title,
      summary: state.outcome.summary,
      terminal: state.outcome.terminal,
    } : undefined,
  };
}

function accessFile(worldId: string): string {
  return join(import.meta.dir, "../../saves", worldId, "web-access.json");
}

async function readAccess(worldId: string): Promise<{ token: string } | null> {
  const file = Bun.file(accessFile(worldId));
  if (!(await file.exists())) return null;
  try {
    const value = await file.json();
    return typeof value?.token === "string" ? value : null;
  } catch {
    return null;
  }
}

function safeTokenEqual(actual: string, supplied: string): boolean {
  if (!actual || actual.length !== supplied.length) return false;
  let mismatch = 0;
  for (let index = 0; index < actual.length; index++) mismatch |= actual.charCodeAt(index) ^ supplied.charCodeAt(index);
  return mismatch === 0;
}
