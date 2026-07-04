// ─────────────────────────────────────────────────────────────
// main.ts — CLI entry point
// Usage: bun run src/main.ts [--world <pack>] [--name <player>] [--save <id>]
// ─────────────────────────────────────────────────────────────

import { createInterface as createLineInterface } from "node:readline";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { loadWorldPack, loadWorldPackSummary } from "./engine/world-loader.ts";
import { loadState, saveState, appendTurn, initSave } from "./store/persist.ts";
import { applyMutations, applyMutation } from "./store/apply.ts";
import { executeCommand } from "./engine/commands.ts";
import { Interpreter } from "./ai/interpreter.ts";
import { DmSession } from "./ai/dm-session.ts";
import { buildDmPrompt } from "./ai/dm-prompt.ts";
import { parseDmResponse } from "./ai/dm-parser.ts";
import { generateProtagonistCandidates } from "./ai/character-generator.ts";
import { backendLabel } from "./ai/backend.ts";
import type { ProtagonistProfile, WorldState } from "./types/world.ts";
import type { EngineMutation } from "./types/mutations.ts";

// ── Parse CLI args ─────────────────────────────────────────────────────────

function parseArgs(): { worldPack?: string; playerName?: string; saveId?: string } {
  const args = process.argv.slice(2);
  const result: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--world" && args[i + 1]) result.worldPack = args[++i];
    if (args[i] === "--name" && args[i + 1]) result.playerName = args[++i];
    if (args[i] === "--save" && args[i + 1]) result.saveId = args[++i];
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
      const answer = (await rl.question(`选择主角 [${defaultIndex ?? "C"}]: `)).trim();
      const choice = answer || (defaultIndex ? String(defaultIndex) : "C");

      if (choice.toLowerCase() === "c") {
        const custom = await createCustomCharacter(config, worldPack, rl, cliPlayerName);
        if (custom) return custom;
        continue;
      }

      const index = Number(choice) - 1;
      const selected = summary.protagonists[index];
      if (!selected) {
        print("无效选择，请重新输入。");
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
      candidates = await generateProtagonistCandidates(
        config,
        worldPack,
        description,
        requestedName,
        3
      );
    } catch (e: any) {
      print(`\x1b[31m生成失败：${e.message}\x1b[0m`);
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

async function askPlayerName(
  rl: ReturnType<typeof createPromptInterface>,
  cliPlayerName: string | undefined,
  defaultName: string
): Promise<string | undefined> {
  if (cliPlayerName?.trim()) return cliPlayerName.trim();
  const suffix = defaultName ? `（留空使用：${defaultName}）` : "（可留空让 AI 命名）";
  const answer = (await rl.question(`输入玩家姓名${suffix}: `)).trim();
  return answer || undefined;
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

  const worldPack = args.worldPack ?? config.worldPack;

  // Load or create save
  let state: WorldState;

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
    print(`创建新游戏：世界包 [${worldPack}]`);
    const character = await chooseCharacterSetup(config, worldPack, args.playerName);
    state = await loadWorldPack(worldPack, {
      fallbackPlayerName: config.defaultPlayerName,
      playerName: character.playerName,
      protagonistProfile: character.profile,
    });
    await initSave(state);
    print(`玩家：${state.player.name}`);
    if (state.player.profile) print(`主角：${state.player.profile.summary}`);
    print(`存档ID：${state.worldId}`);
  }

  // Init AI
  print("\n初始化 AI 会话（使用 Pi 配置）...");
  const dm = new DmSession();
  const interpreter = new Interpreter();
  await Promise.all([
    dm.init(config, worldPack),
    interpreter.init(config),
  ]);
  print(`DM：${backendLabel(config, "dm")}`);
  print(`指令解析：${backendLabel(config, "interpreter")}`);
  print(`角色生成：${backendLabel(config, "character")}`);

  // Show starting room
  printRoom(state);
  print(`输入 help 查看指令，输入 status 查看属性`);

  // First turn: DM opens the scene
  print("\nDM 正在开场...\n");
  const openingPrompt = buildDmPrompt(state, "开始游戏，玩家刚刚进入世界", []);
  const openingRaw = await dm.ask(openingPrompt);
  const opening = parseDmResponse(openingRaw, state.schema);
  applyMutations(state, opening.mutations);
  await saveState(state);
  print(`\x1b[32m${opening.narration}\x1b[0m\n`);

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
      await processInput(state, input, dm, interpreter);
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
    process.exit(0);
  });
}

// ── Process one player input ───────────────────────────────────────────────

async function processInput(
  state: WorldState,
  input: string,
  dm: DmSession,
  interpreter: Interpreter
): Promise<void> {
  // 1. Parse input
  const parsed = await interpreter.parse(input);

  // 2. Execute engine command
  const result = executeCommand(state, parsed);

  // 3. Direct replies bypass DM (errors, inv, status, help)
  if (result.directReply !== undefined) {
    if (result.directReply === "__QUIT__") {
      print("存档已保存，再见。");
      await saveState(state);
      process.exit(0);
    }
    print(result.directReply);
    return;
  }

  // 4. Apply engine mutations (before DM sees the world)
  const engineMuts = result.mutations as EngineMutation[];
  applyMutations(state, engineMuts);

  // 5. Ask DM to narrate + expand world
  process.stdout.write("\x1b[2m");
  const dmPrompt = buildDmPrompt(state, input, engineMuts, result.combatContext);
  const dmRaw = await dm.ask(dmPrompt);
  process.stdout.write("\x1b[0m");

  // 6. Parse DM response → DmMutations
  const dmResponse = parseDmResponse(dmRaw, state.schema);

  // 7. Apply DM mutations
  applyMutations(state, dmResponse.mutations);

  // 8. Advance turn
  applyMutation(state, { kind: "engine/turn_advanced" });

  // 9. Persist
  await saveState(state);
  await appendTurn(state.worldId, {
    turn: state.turn,
    ts: Date.now(),
    playerInput: input,
    parsed: {
      verb: parsed.verb,
      args: parsed.args,
      confidence: parsed.confidence,
    },
    engineMutations: engineMuts,
    dmMutations: dmResponse.mutations,
    narration: dmResponse.narration,
    dmModel: "dm",
  });

  // 10. Display narration
  print(`\n\x1b[32m${dmResponse.narration}\x1b[0m`);

  // Show room header after movement
  const moved = engineMuts.some((m) => m.kind === "engine/player_moved");
  if (moved) printRoom(state);

  // Build a short stat summary using schema
  const statSummary = state.schema.defs
    .filter((d) => d.role === 'pool' && d.display !== 'hidden')
    .map((d) => `${d.label}: ${state.player.stats[d.key] ?? d.default}/${state.player.maxStats[d.key + 'Max'] ?? d.max}`)
    .join(' | ');
  print(`\x1b[2m[${statSummary} | 第 ${state.turn} 轮]\x1b[0m`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
