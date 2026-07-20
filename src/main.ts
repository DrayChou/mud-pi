// ─────────────────────────────────────────────────────────────
// main.ts — CLI entry point
// Usage: bun run src/main.ts [--world <pack>] [--name <player>] [--save <id>]
// ─────────────────────────────────────────────────────────────

import { createInterface as createLineInterface } from "node:readline";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { listWorldPacks, loadStoryOutcomes, loadWorldPack, loadWorldPackSummary } from "./engine/world-loader.ts";
import { loadState, loadTurns, saveState, appendTurn, initSave } from "./store/persist.ts";
import { validatePlayerName } from "./engine/player-name.ts";
import { applyMutations, applyMutation } from "./store/apply.ts";
import { executeCommand } from "./engine/commands.ts";
import { executeNpcDecision } from "./engine/npc-intents.ts";
import { deriveGameEvents } from "./engine/game-events.ts";
import { evaluateProgress } from "./engine/progress.ts";
import { Interpreter } from "./ai/interpreter.ts";
import { DmSession } from "./ai/dm-session.ts";
import { NpcSessionRegistry } from "./ai/npc-session-registry.ts";
import { buildDmPrompt, buildDmRecoveryPrompt } from "./ai/dm-prompt.ts";
import { parseDmResponse } from "./ai/dm-parser.ts";
import { generateProtagonistCandidates } from "./ai/character-generator.ts";
import { backendLabel } from "./ai/backend.ts";
import type { NpcPublicAction } from "./types/npc.ts";
import type { ProtagonistProfile, StoryOutcomeDef, WorldState } from "./types/world.ts";
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
      candidates = await generateProtagonistCandidates(
        config,
        worldPack,
        description,
        requestedName,
        3
      );
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
    await dm.ask(buildDmRecoveryPrompt(state, turns.slice(-20)));
  }
  print(`DM：${backendLabel(config, "dm")}`);
  print(`指令解析：${backendLabel(config, "interpreter")}`);
  print(`角色生成：${backendLabel(config, "character")}`);

  // Show starting room
  printRoom(state);
  print(`输入 help 查看指令，输入 status 查看属性`);

  // Only a new game gets an opening turn. A resumed Pi session continues as-is.
  if (isNewGame) {
    print("\nDM 正在开场...\n");
    const openingPrompt = buildDmPrompt(state, "开始游戏，玩家刚刚进入世界", [], undefined, [], storyOutcomes);
    const openingRaw = await dm.ask(openingPrompt);
    const opening = parseDmResponse(openingRaw, state.schema, state.player.roomId, storyOutcomes);
    applyMutations(state, opening.mutations);
    await saveState(state);
    print(`\x1b[32m${opening.narration}\x1b[0m\n`);
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
      await processInput(state, input, dm, interpreter, npcSessions, storyOutcomes);
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
  state: WorldState,
  input: string,
  dm: DmSession,
  interpreter: Interpreter,
  npcSessions: NpcSessionRegistry,
  storyOutcomes: StoryOutcomeDef[]
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
      dm.dispose();
      npcSessions.dispose();
      process.exit(0);
    }
    print(result.directReply);
    return;
  }

  // 4. Apply engine mutations (before DM sees the world)
  const stateBeforeTurn = structuredClone(state);
  const engineMuts = result.mutations as EngineMutation[];
  applyMutations(state, engineMuts);

  // 5. Let an addressed important NPC respond through its own persistent session.
  const npcDecisions = parsed.verb === "say"
    ? await npcSessions.respondToPlayerSay(
        state,
        parsed.args.message ?? input,
        parsed.args.target
      )
    : [];
  const npcActions: NpcPublicAction[] = [];
  const npcMutations: EngineMutation[] = [];
  for (const decision of npcDecisions) {
    const npcResult = executeNpcDecision(state, decision);
    applyMutations(state, npcResult.mutations);
    npcMutations.push(...npcResult.mutations);
    npcActions.push(npcResult.action);
  }

  // 6. Ask DM to narrate the player action and already-decided NPC response.
  process.stdout.write("\x1b[2m");
  const dmPrompt = buildDmPrompt(
    state,
    input,
    engineMuts,
    result.combatContext,
    npcActions,
    storyOutcomes
  );
  const dmRaw = await dm.ask(dmPrompt);
  process.stdout.write("\x1b[0m");

  // 7. Parse DM response → DmMutations
  const dmResponse = parseDmResponse(dmRaw, state.schema, state.player.roomId, storyOutcomes);

  // 8. Apply DM mutations
  applyMutations(state, dmResponse.mutations);

  // A DM may register a concrete object introduced by earlier narration only when
  // the player first tries to take it. Retry the validated pickup after registration
  // so narration and authoritative inventory stay in sync in the same turn.
  const postDmEngineMuts: EngineMutation[] = [];
  if (parsed.verb === "get" && !engineMuts.some((m) => m.kind === "engine/item_picked_up")) {
    const retry = executeCommand(state, parsed);
    if (retry.directReply === undefined) {
      postDmEngineMuts.push(...retry.mutations);
      applyMutations(state, retry.mutations);
    }
  }

  const speechTarget = parsed.verb === "say"
    ? parsed.args.target
      ? Object.values(stateBeforeTurn.npcs).find(
          (npc) =>
            npc.roomId === stateBeforeTurn.player.roomId &&
            (npc.id.includes(parsed.args.target!) || npc.name.includes(parsed.args.target!))
        )?.id
      : npcDecisions[0]?.npcId
    : undefined;
  const gameEvents = deriveGameEvents(
    stateBeforeTurn,
    [...engineMuts, ...npcMutations, ...dmResponse.mutations, ...postDmEngineMuts],
    state,
    parsed.verb === "say"
      ? { playerSpeech: { message: parsed.args.message ?? input, targetId: speechTarget } }
      : undefined
  );
  const progressMutations = evaluateProgress(state, gameEvents);
  applyMutations(state, progressMutations);

  // 9. Advance turn
  applyMutation(state, { kind: "engine/turn_advanced" });

  // 10. Persist
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
    engineMutations: [...engineMuts, ...postDmEngineMuts, ...progressMutations],
    dmMutations: dmResponse.mutations,
    gameEvents,
    npcActions,
    narration: dmResponse.narration,
    dmModel: "dm",
  });

  // 11. Display narration
  print(`\n\x1b[32m${dmResponse.narration}\x1b[0m`);
  for (const mutation of progressMutations) {
    if (mutation.kind === "engine/objective_completed") {
      const objective = state.objectives[mutation.objectiveId];
      if (objective) print(`\x1b[33m✓ 目标完成：${objective.title}\x1b[0m`);
    }
  }
  if (!stateBeforeTurn.outcome && state.outcome) {
    print(`\n\x1b[1;35m故事结果：${state.outcome.title}\x1b[0m`);
    print(state.outcome.summary);
  }

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
