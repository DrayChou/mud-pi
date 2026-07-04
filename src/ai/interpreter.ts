// ─────────────────────────────────────────────────────────────
// interpreter.ts — cheap Pi SDK model: text → ParsedCommand
// Fresh session per parse keeps command classification stateless.
// ─────────────────────────────────────────────────────────────

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";

export interface ParsedCommand {
  verb: string;
  args: Record<string, string>;
  confidence: number;
  raw: string;
}

const SYSTEM = `你是一个文字MUD游戏的指令解析器。
将玩家输入解析为结构化指令，只返回JSON，不要解释。

支持的动词：
  look   — 查看（目标可选）
  go     — 移动，需要 direction: north/south/east/west/up/down 或中文方向
  say    — 对话，需要 message
  attack — 攻击，需要 target
  get    — 拾取，需要 item
  drop   — 丢弃，需要 item
  equip  — 装备，需要 item
  inv    — 查看背包
  status — 查看状态
  help   — 帮助
  quit   — 退出

方向中文映射：东=east 西=west 南=south 北=north 上=up 下=down

输出格式：
{"verb":"go","args":{"direction":"east"},"confidence":0.95}

无法解析时返回：
{"verb":"unknown","args":{},"confidence":0.1}`;

export class Interpreter {
  private config!: Config;
  private authStorage!: ReturnType<typeof AuthStorage.create>;
  private modelRegistry!: ReturnType<typeof ModelRegistry.create>;

  async init(config: Config): Promise<void> {
    this.config = config;
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

  async parse(input: string): Promise<ParsedCommand> {
    if (!this.config) throw new Error("Interpreter not initialized — call init() first");
    // Fast path: single-word exact matches
    const fast = fastParse(input.trim().toLowerCase());
    if (fast) return { ...fast, raw: input };

    try {
      const result = await callInterpreterModel(
        this.config,
        this.authStorage,
        this.modelRegistry,
        input
      );
      return { ...result, raw: input };
    } catch (e) {
      console.warn("[interpreter] model error, fallback:", e);
      return { verb: "unknown", args: {}, confidence: 0, raw: input };
    }
  }
}

// ── Fast path for common single-word commands ──────────────────────────────

const DIRECTION_MAP: Record<string, string> = {
  east: "east", e: "east", 东: "east",
  west: "west", w: "west", 西: "west",
  south: "south", s: "south", 南: "south",
  north: "north", n: "north", 北: "north",
  up: "up", u: "up", 上: "up",
  down: "down", d: "down", 下: "down",
};

function fastParse(
  input: string
): Omit<ParsedCommand, "raw"> | null {
  if (["inv", "i", "背包", "inventory"].includes(input))
    return { verb: "inv", args: {}, confidence: 1 };
  if (["look", "l", "环顾", "查看", "看"].includes(input))
    return { verb: "look", args: {}, confidence: 1 };
  if (["status", "st", "hp", "状态"].includes(input))
    return { verb: "status", args: {}, confidence: 1 };
  if (["help", "h", "帮助", "?"].includes(input))
    return { verb: "help", args: {}, confidence: 1 };
  if (["quit", "exit", "bye", "退出", "离开"].includes(input))
    return { verb: "quit", args: {}, confidence: 1 };

  const dir = DIRECTION_MAP[input];
  if (dir) return { verb: "go", args: { direction: dir }, confidence: 1 };

  return null;
}

// ── LLM call through Pi SDK ────────────────────────────────────────────────

async function callInterpreterModel(
  config: Config,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  input: string
): Promise<Omit<ParsedCommand, "raw">> {
  const available = await modelRegistry.getAvailable();
  const model = available.find(
    (m) =>
      m.provider === config.interpreterProvider &&
      (m.id === config.interpreterModel || m.name === config.interpreterModel)
  );
  if (!model) {
    const names = available.map((m) => `${m.provider}/${m.id}`).join(", ");
    throw new Error(
      `Interpreter model not found: ${config.interpreterProvider}/${config.interpreterModel}\n` +
        `Available: ${names || "(none — install/login to Pi first)"}`
    );
  }

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => SYSTEM,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
    }),
  });

  let response = "";
  const unsub = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      response += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(input);
  } finally {
    unsub();
    session.dispose();
  }

  return parseModelJson(response);
}

function parseModelJson(text: string): Omit<ParsedCommand, "raw"> {
  const jsonText = extractJson(text);
  if (!jsonText) return { verb: "unknown", args: {}, confidence: 0 };

  try {
    const parsed = JSON.parse(jsonText);
    return {
      verb: String(parsed.verb ?? "unknown"),
      args: parsed.args && typeof parsed.args === "object" ? parsed.args : {},
      confidence: Number(parsed.confidence ?? 0.5),
    };
  } catch {
    return { verb: "unknown", args: {}, confidence: 0 };
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
