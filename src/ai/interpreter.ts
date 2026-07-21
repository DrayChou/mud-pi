// ─────────────────────────────────────────────────────────────
// interpreter.ts — cheap stateless model: text → ParsedCommand
// ─────────────────────────────────────────────────────────────

import type { Config } from "../config.ts";
import { backendForRole, createBackend, modelForRole } from "./backend.ts";

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
  say    — 对话，需要 message；若玩家明确点名对象，附加 target
  attack — 攻击，需要 target；若明确使用武器，附加 weapon
  get    — 拾取，需要 item
  drop   — 丢弃，需要 item
  equip  — 装备，需要 item
  use    — 使用物品，需要 item
  inv    — 查看背包
  status — 查看状态
  objectives — 查看目标、任务或当前进度
  map    — 查看已探索地图
  help   — 帮助
  quit   — 退出

方向中文映射：东=east 西=west 南=south 北=north 上=up 下=down

输出格式：
{"verb":"go","args":{"direction":"east"},"confidence":0.95}
{"verb":"say","args":{"target":"售票员","message":"这张票能去哪里？"},"confidence":0.95}
{"verb":"attack","args":{"target":"深渊之物","weapon":"左轮手枪"},"confidence":0.95}

无法解析时返回：
{"verb":"unknown","args":{},"confidence":0.1}`;

export class Interpreter {
  private config!: Config;

  async init(config: Config): Promise<void> {
    this.config = config;
  }

  async parse(input: string): Promise<ParsedCommand> {
    if (!this.config) throw new Error("Interpreter not initialized — call init() first");
    // Fast path: exact commands and common compound physical actions.
    const fast = fastParse(input.trim().toLowerCase());
    if (fast) return { ...fast, raw: input };

    try {
      const result = await callInterpreterModel(this.config, input);
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
  if (["objectives", "objective", "goals", "quests", "目标", "任务", "进度"].includes(input))
    return { verb: "objectives", args: {}, confidence: 1 };
  if (["map", "m", "地图", "路线"].includes(input))
    return { verb: "map", args: {}, confidence: 1 };
  if (["help", "h", "帮助", "?"].includes(input))
    return { verb: "help", args: {}, confidence: 1 };
  if (["quit", "exit", "bye", "退出", "离开"].includes(input))
    return { verb: "quit", args: {}, confidence: 1 };

  const dir = DIRECTION_MAP[input];
  if (dir) return { verb: "go", args: { direction: dir }, confidence: 1 };

  const pickupItem = extractPickupItem(input);
  if (pickupItem) return { verb: "get", args: { item: pickupItem }, confidence: 0.96 };

  return null;
}

function extractPickupItem(input: string): string | null {
  if (!/(捡起|拾取|拿起|拿起来|放进(?:我的)?背包|收到(?:我的)?背包)/.test(input)) return null;
  const beforeAction = input.split(/拿起来|拿起|捡起|拾取|放进(?:我的)?背包|收到(?:我的)?背包/, 1)[0]
    ?.replace(/^.*?(?:地上(?:的)?|桌上(?:的)?|旁边(?:的)?)\s*/, "")
    .replace(/(?:上面|里面)(?:写着|是什么|有什么)?[\s\S]*$/, "")
    .replace(/[，,。！？!?：:]\s*$/, "")
    .trim();
  if (beforeAction && beforeAction.length <= 40) return beforeAction;
  const afterAction = input.match(/(?:捡起|拾取|拿起(?:来)?)\s*([^，,。！？!?]{1,40})/)?.[1]?.trim();
  return afterAction || null;
}

// ── LLM call through configured backend ───────────────────────────────────

async function callInterpreterModel(
  config: Config,
  input: string
): Promise<Omit<ParsedCommand, "raw">> {
  const backend = createBackend(backendForRole(config, "interpreter"));
  const { provider, model } = modelForRole(config, "interpreter");
  const response = await backend.ask({
    role: "interpreter",
    systemPrompt: SYSTEM,
    userPrompt: input,
    provider,
    model,
    thinkingLevel: "off",
    jsonOnly: true,
  });

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
