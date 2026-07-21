// ─────────────────────────────────────────────────────────────
// main.ts — CLI entry point
// Usage: bun run src/main.ts [--world <pack>] [--name <player>] [--save <id>] [--seed <value>] [--tui|--telnet] [--host 127.0.0.1] [--port 4000]
// ─────────────────────────────────────────────────────────────

import { createInterface as createLineInterface } from "node:readline";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { listWorldPacks, loadStoryOutcomes, loadWorldPack, loadWorldPackSummary } from "./engine/world-loader.ts";
import { loadState, loadTurns, initSave } from "./store/persist.ts";
import { validatePlayerName } from "./engine/player-name.ts";
import { loadWorldConflictResolver } from "./engine/conflict-script.ts";
import { effectivePlayerStats } from "./engine/parameters.ts";
import { GameRuntime } from "./runtime/game-runtime.ts";
import type { GameOutput } from "./runtime/game-output.ts";
import { runMudTui } from "./adapters/tui.ts";
import { startTelnetServer } from "./adapters/telnet.ts";
import { Interpreter } from "./ai/interpreter.ts";
import { DmSession } from "./ai/dm-session.ts";
import { NpcSessionRegistry } from "./ai/npc-session-registry.ts";
import { buildDmRecoveryPrompt } from "./ai/dm-prompt.ts";
import { generateProtagonistCandidates } from "./ai/character-generator.ts";
import { backendLabel } from "./ai/backend.ts";
import type { ProtagonistProfile, WorldState } from "./types/world.ts";
import { runWithDiagnosticContext } from "./diagnostics/logger.ts";

// ── Parse CLI args ─────────────────────────────────────────────────────────

function parseArgs(): {
  worldPack?: string;
  playerName?: string;
  saveId?: string;
  tui?: boolean;
  telnet?: boolean;
  port?: number;
  host?: string;
  seed?: string;
} {
  const args = process.argv.slice(2);
  const result: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--world" && args[i + 1]) result.worldPack = args[++i];
    if (args[i] === "--name" && args[i + 1]) result.playerName = args[++i];
    if (args[i] === "--save" && args[i + 1]) result.saveId = args[++i];
    if (args[i] === "--tui") result.tui = true;
    if (args[i] === "--telnet") result.telnet = true;
    if (args[i] === "--port" && args[i + 1]) {
      const port = Number(args[++i]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) result.port = port;
    }
    if (args[i] === "--host" && args[i + 1]) result.host = args[++i];
    if (args[i] === "--seed" && args[i + 1]) result.seed = args[++i];
  }
  return result;
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function print(text: string) {
  console.log(text);
}

function separator() {
  console.log("\n" + "─".repeat(50));
}

function printRoom(state: WorldState) {
  const room = state.rooms[state.player.roomId];
  if (!room) return;
  separator();
  console.log(`\x1b[1;33m${room.title}\x1b[0m`);
  console.log(room.desc);
  const exits = Object.keys(room.exits);
  console.log(`\x1b[36m[出口: ${exits.length > 0 ? exits.join("  ") : "无"}]\x1b[0m`);
  const itemsHere = Object.values(state.items).filter(
    (item) => item.location.kind === "room" && item.location.roomId === room.id
  );
  if (itemsHere.length > 0) {
    console.log(`\x1b[35m[物品: ${itemsHere.map((item) => item.name).join("  ")}]\x1b[0m`);
  }
  const npcsHere = Object.values(state.npcs).filter(
    (n) => n.roomId === state.player.roomId && n.alive
  );
  if (npcsHere.length > 0) {
    console.log(`在场：${npcsHere.map((n) => n.name).join("，")}`);
  }
  console.log();
}

interface CharacterSetup {
  playerName?: string;
  profile?: ProtagonistProfile;
}

async function chooseWorldPack(defaultWorldPack: string, cliWorldPack?: string): Promise<string> {
  if (cliWorldPack?.trim()) return cliWorldPack.trim();

  // Non-interactive runs use .env/default config and avoid blocking stdin.
  if (!process.stdin.isTTY) return defaultWorldPack;

  const worlds = await listWorldPacks();
  if (worlds.length === 0) throw new Error("No world packs found in worlds/");

  const defaultIndex = Math.max(0, worlds.findIndex((w) => w.id === defaultWorldPack)) + 1;
  const rl = createPromptInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      print("\n选择剧本：");
      worlds.forEach((world, index) => {
        const marker = world.id === defaultWorldPack ? "（默认）" : "";
        print(`  ${index + 1}. ${world.name}${marker} [${world.id}]`);
      });

      const answer = (await rl.question(`选择剧本 [${defaultIndex || 1}]: `)).trim();
      const index = answer ? Number(answer) - 1 : Math.max(0, defaultIndex - 1);
      const selected = worlds[index];
      if (!selected) {
        print("无效选择，请重新输入。");
        continue;
      }
      return selected.id;
    }
  } finally {
    rl.close();
  }
}

async function chooseCharacterSetup(
  config: Config,
  worldPack: string,
  cliPlayerName?: string
): Promise<CharacterSetup> {
  const summary = await loadWorldPackSummary(worldPack);
  const defaultProfile =
    summary.protagonists.find((p) => p.id === summary.defaultProtagonistId) ??
    summary.protagonists[0];

  // Non-interactive runs keep the old behavior and avoid blocking stdin.
  if (!process.stdin.isTTY) {
    return { playerName: cliPlayerName, profile: defaultProfile };
  }

  print(`\n角色创建：${summary.name}`);
  const rl = createPromptInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      if (summary.protagonists.length > 0) {
        print("\n可选预设主角：");
        summary.protagonists.forEach((p, index) => {
          const marker = p.id === summary.defaultProtagonistId ? "（默认）" : "";
          print(`  ${index + 1}. ${p.name}${marker} — ${p.summary}`);
        });
      } else {
        print("\n这个世界包还没有预设主角。");
      }
      print("  C. 输入自己的角色描述，由 AI 生成候选主角");

      const defaultIndex = defaultProfile
        ? Math.max(0, summary.protagonists.findIndex((p) => p.id === defaultProfile.id)) + 1
        : undefined;
      const answer = (await rl.question(`选择主角编号，或直接输入姓名使用默认主角 [${defaultIndex ?? "C"}]: `)).trim();
      const choice = answer || (defaultIndex ? String(defaultIndex) : "C");

      if (choice.toLowerCase() === "c") {
        const custom = await createCustomCharacter(config, worldPack, rl, cliPlayerName);
        if (custom) return custom;
        continue;
      }

      const numericChoice = Number(choice);
      if (!Number.isInteger(numericChoice)) {
        const nameResult = validatePlayerName(choice);
        if (nameResult.ok && nameResult.value) {
          if (defaultProfile) {
            return { playerName: nameResult.value, profile: defaultProfile };
          }
          return { playerName: nameResult.value };
        }
        print(nameResult.reason ?? "请输入主角编号，或输入 C 创建自定义角色。");
        continue;
      }

      const index = numericChoice - 1;
      const selected = summary.protagonists[index];
      if (!selected) {
        print("无效选择，请输入列表中的编号，或输入 C 创建自定义角色。");
        continue;
      }

      const playerName = await askPlayerName(rl, cliPlayerName, selected.name);
      return { playerName, profile: selected };
    }
  } finally {
    rl.close();
  }
}

async function createCustomCharacter(
  config: Config,
  worldPack: string,
  rl: ReturnType<typeof createPromptInterface>,
  cliPlayerName?: string
): Promise<CharacterSetup | null> {
  while (true) {
    const requestedName = await askPlayerName(rl, cliPlayerName, "");
    const description = (await rl.question(
      "描述你想扮演的角色（例如：一个逃避过去的调查员 / 想回家的通勤者；留空返回）: "
    )).trim();
    if (!description) return null;

    print("\nAI 正在根据世界观生成候选主角...");
    let candidates: ProtagonistProfile[];
    try {
      candidates = await runWithDiagnosticContext({
        worldId: "_bootstrap",
        requestId: crypto.randomUUID(),
        channel: "cli",
      }, () => generateProtagonistCandidates(
        config,
        worldPack,
        description,
        requestedName,
        3
      ));
    } catch (e: any) {
      print(`\x1b[31m生成失败：${e.message}\x1b[0m`);
      const fallback = (await rl.question("使用你的描述创建基础自定义角色？[Y/n]: ")).trim().toLowerCase();
      if (fallback !== "n") {
        return {
          playerName: requestedName,
          profile: createFallbackCustomProfile(requestedName, description),
        };
      }
      const retry = (await rl.question("重新输入描述？[Y/n]: ")).trim().toLowerCase();
      if (retry === "n") return null;
      continue;
    }

    print("\nAI 生成的候选主角：");
    candidates.forEach((p, index) => {
      print(`  ${index + 1}. ${p.name} — ${p.summary}`);
      print(`     动机：${p.motivation}`);
    });
    print("  R. 重新输入描述");
    print("  B. 返回预设主角列表");

    while (true) {
      const answer = (await rl.question("选择候选 [1]: ")).trim().toLowerCase() || "1";
      if (answer === "r") break;
      if (answer === "b") return null;
      const selected = candidates[Number(answer) - 1];
      if (!selected) {
        print("无效选择，请重新输入。");
        continue;
      }
      return { playerName: selected.name, profile: selected };
    }
  }
}

function createFallbackCustomProfile(
  requestedName: string | undefined,
  description: string
): ProtagonistProfile {
  const name = validatePlayerName(requestedName ?? "").value || "自定义旅人";
  return {
    id: "custom_player",
    name,
    summary: description,
    background: `你带着这个身份进入故事：${description}`,
    motivation: "找出自己来到这里的原因，并决定接下来要成为什么样的人。",
    initialStats: {},
    initialInventory: [],
    openingHook: `${name}站在故事的入口，关于自己的答案还没有写完。`,
  };
}

async function askPlayerName(
  rl: ReturnType<typeof createPromptInterface>,
  cliPlayerName: string | undefined,
  defaultName: string
): Promise<string | undefined> {
  if (cliPlayerName?.trim()) {
    const result = validatePlayerName(cliPlayerName);
    if (!result.ok) throw new Error(`--name 无效：${result.reason}`);
    return result.value;
  }

  const suffix = defaultName ? `（留空使用：${defaultName}）` : "（可留空让 AI 命名）";
  while (true) {
    const answer = await rl.question(`输入玩家姓名${suffix}: `);
    const result = validatePlayerName(answer);
    if (result.ok) return result.value;
    print(`\x1b[31m${result.reason}\x1b[0m`);
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  print("\x1b[1m");
  print("  ╔══════════════════════════════════╗");
  print("  ║         M U D - P I              ║");
  print("  ║   AI-Driven Text Adventure       ║");
  print("  ╚══════════════════════════════════╝");
  print("\x1b[0m");

  // Load config
  let config;
  try {
    config = loadConfig();
  } catch (e: any) {
    print(`\x1b[31m配置错误：${e.message}\x1b[0m`);
    print("请复制 .env.example 为 .env 并填写配置。");
    process.exit(1);
  }

  // Load or create save
  let state: WorldState;
  const isNewGame = !args.saveId;

  if (args.saveId) {
    print(`载入存档：${args.saveId}`);
    const loaded = await loadState(args.saveId);
    if (!loaded) {
      print(`\x1b[31m存档不存在：${args.saveId}\x1b[0m`);
      process.exit(1);
    }
    state = loaded;
    print(`继续游戏（第 ${state.turn} 轮）`);
  } else {
    const worldPack = await chooseWorldPack(config.worldPack, args.worldPack);
    print(`创建新游戏：世界包 [${worldPack}]`);
    const character = await chooseCharacterSetup(config, worldPack, args.playerName);
    state = await loadWorldPack(worldPack, {
      fallbackPlayerName: config.defaultPlayerName,
      playerName: character.playerName,
      protagonistProfile: character.profile,
      seed: args.seed,
    });
    await initSave(state);
    print(`玩家：${state.player.name}`);
    if (state.player.profile) print(`主角：${state.player.profile.summary}`);
    print(`存档ID：${state.worldId}`);
  }

  const storyOutcomes = await loadStoryOutcomes(state.worldPack);

  // Init AI
  print("\n初始化 AI 会话（使用 Pi 配置）...");
  const dm = new DmSession();
  const interpreter = new Interpreter();
  const npcSessions = new NpcSessionRegistry();
  npcSessions.init(config, state.worldId);
  const [dmInit] = await Promise.all([
    dm.init({
      config,
      worldId: state.worldId,
      worldPack: state.worldPack,
      resume: !isNewGame,
    }),
    interpreter.init(config),
  ]);

  if (dmInit.recoveryNeeded) {
    print("检测到旧存档或缺失的 DM Session，正在从权威存档恢复 Pi 上下文...");
    const turns = await loadTurns(state.worldId);
    await runWithDiagnosticContext({
      worldId: state.worldId,
      requestId: crypto.randomUUID(),
      channel: args.tui ? "tui" : args.telnet ? "telnet" : "cli",
      turn: state.turn,
      revision: state.revision,
    }, () => dm.ask(buildDmRecoveryPrompt(state, turns.slice(-20))));
  }
  print(`DM：${backendLabel(config, "dm")}`);
  print(`指令解析：${backendLabel(config, "interpreter")}`);
  print(`角色生成：${backendLabel(config, "character")}`);

  // Show starting room
  printRoom(state);
  print(`输入 help 查看指令，输入 status 查看属性`);

  const conflictResolver = await loadWorldConflictResolver(state.worldPack, state.conflictScript);
  const runtime = new GameRuntime({
    state,
    storyOutcomes,
    interpreter,
    dm,
    npcSessions,
    dmModelLabel: backendLabel(config, "dm"),
    conflictResolver,
    channel: args.tui ? "tui" : args.telnet ? "telnet" : "cli",
  });

  // Only a new game gets an opening turn. It uses the same authoritative
  // settlement, correction, Journal, Outbox and TurnRecord path as later turns.
  let openingOutputs: GameOutput[] = [];
  if (isNewGame) {
    print("\nDM 正在开场...\n");
    const opening = await runtime.processOpening();
    openingOutputs = opening.outputs;
    if (!args.tui && !args.telnet) {
      for (const output of openingOutputs) renderGameOutput(output, state);
    }
  }

  if (args.telnet) {
    const server = startTelnetServer({
      runtime,
      hostname: args.host ?? "127.0.0.1",
      port: args.port ?? 4000,
      onLog: print,
      initialOutputs: openingOutputs,
    });
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        resolve();
      };
      process.on("SIGINT", stop);
    });
    server.stop(true);
    await runtime.save();
    dm.dispose();
    npcSessions.dispose();
    return;
  }

  if (args.tui) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("--tui 需要交互式终端");
    }
    await runMudTui(runtime, {
      title: `mud-pi · ${state.worldPack}`,
      initialOutputs: openingOutputs,
    });
    await runtime.save();
    dm.dispose();
    npcSessions.dispose();
    return;
  }

  // ── Input loop ─────────────────────────────────────────────
  const rl = createLineInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[1m> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    rl.pause();
    const input = line.trim();
    if (!input) { rl.resume(); rl.prompt(); return; }

    try {
      await processInput(runtime, state, input);
    } catch (e: any) {
      print(`\x1b[31m[错误] ${e.message}\x1b[0m`);
    }

    if (process.stdin.readable) {
      rl.resume();
      rl.prompt();
    }
  });

  rl.on("close", () => {
    print("\n再见。");
    dm.dispose();
    npcSessions.dispose();
    process.exit(0);
  });
}

// ── Process one player input ───────────────────────────────────────────────

async function processInput(
  runtime: GameRuntime,
  state: WorldState,
  input: string
): Promise<void> {
  process.stdout.write("\x1b[2m");
  const result = await runtime.processInput(input);
  process.stdout.write("\x1b[0m");

  if (result.quit) {
    print("存档已保存，再见。");
    process.exit(0);
  }

  for (const output of result.outputs) renderGameOutput(output, state);
  if (!result.turnAdvanced) return;

  const effectiveStats = effectivePlayerStats(state);
  const statSummary = state.schema.defs
    .filter((def) => def.display !== "hidden")
    .map((def) => `${def.label}: ${effectiveStats[def.key] ?? def.default}/${state.player.maxStats[`${def.key}Max`] ?? def.max}`)
    .join(" | ");
  print(`\x1b[2m[${statSummary} | ${state.player.lifecycle} | 第 ${state.turn} 轮]\x1b[0m`);
}

function renderGameOutput(output: GameOutput, state: WorldState): void {
  switch (output.kind) {
    case "direct_reply":
      print(output.text);
      break;
    case "narration":
      print(`\n\x1b[32m${output.text}\x1b[0m`);
      break;
    case "objective_completed":
      print(`\x1b[33m✓ 目标完成：${output.title}\x1b[0m`);
      break;
    case "story_outcome":
      print(`\n\x1b[1;35m故事结果：${output.outcome.title}\x1b[0m`);
      print(output.outcome.summary);
      break;
    case "room_changed":
      printRoom(state);
      break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
