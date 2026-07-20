// ─────────────────────────────────────────────────────────────
// character-generator.ts — generate world-fitting protagonist candidates
// ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { PLAYER_NAME_MAX_CHARS, safeGeneratedName } from "../engine/player-name.ts";
import type { ProtagonistProfile, StatsSchema } from "../types/world.ts";
import { backendForRole, createBackend, modelForRole } from "./backend.ts";

interface WorldPackForGeneration {
  name: string;
  schema: StatsSchema;
  defaultProtagonistId?: string;
  protagonists?: ProtagonistProfile[];
  items?: Array<{ id: string; name: string; desc: string }>;
}

const SYSTEM = `你是文字 MUD 游戏的角色创建助手。
根据世界观、属性 schema、可用物品和用户描述，生成符合该世界气质的原创主角候选。
必须创作原创角色；不要复刻、扮演、搬运或改名使用任何已有小说、影视、游戏、动漫、TRPG 或其他作品中的角色。
只返回 JSON，不要解释，不要 Markdown。`;

export async function generateProtagonistCandidates(
  config: Config,
  worldPack: string,
  description: string,
  requestedName: string | undefined,
  count = 3
): Promise<ProtagonistProfile[]> {
  const pack = await readWorldPack(worldPack);
  const lore = readLore(worldPack);

  const backend = createBackend(backendForRole(config, "character"));
  const { provider, model } = modelForRole(config, "character");
  const response = await backend.ask({
    role: "character",
    systemPrompt: SYSTEM,
    userPrompt: buildPrompt(pack, lore, description, requestedName, count),
    provider,
    model,
    thinkingLevel: config.dmThinking,
    jsonOnly: true,
  });

  return normalizeCandidates(parseCandidates(response), pack, requestedName, count);
}

async function readWorldPack(worldPack: string): Promise<WorldPackForGeneration> {
  const f = Bun.file(join(import.meta.dir, "../../worlds", worldPack, "world.json"));
  if (!(await f.exists())) throw new Error(`World pack not found: worlds/${worldPack}/world.json`);
  return (await f.json()) as WorldPackForGeneration;
}

function readLore(worldPack: string): string {
  const path = join(import.meta.dir, "../../worlds", worldPack, "lore.md");
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function buildPrompt(
  pack: WorldPackForGeneration,
  lore: string,
  description: string,
  requestedName: string | undefined,
  count: number
): string {
  const statRules = pack.schema.defs.map((d) => ({
    key: d.key,
    label: d.label,
    min: d.min,
    max: d.max,
    default: d.default,
    description: d.description,
  }));
  const itemRules = (pack.items ?? []).map((i) => ({ id: i.id, name: i.name, desc: i.desc }));
  const examples = (pack.protagonists ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    summary: p.summary,
    background: p.background,
    motivation: p.motivation,
  }));

  return `世界名称：${pack.name}

世界观：
${lore || "（无额外 lore）"}

属性 schema（initialStats 只能使用这些 key，数值必须在 min/max 之间）：
${JSON.stringify(statRules, null, 2)}

可作为初始物品的 item id（initialInventory 只能使用这些 id，可以为空）：
${JSON.stringify(itemRules, null, 2)}

已有预设主角风格参考：
${JSON.stringify(examples, null, 2)}

用户想扮演的角色描述：
${description}

${requestedName ? `用户输入的姓名：${requestedName}\n如果生成候选包含 name 字段，必须使用这个姓名。` : `用户未指定姓名，请为候选生成符合世界观的原创姓名；姓名最多 ${PLAYER_NAME_MAX_CHARS} 个字符。`}

原创性要求：
- 用户描述可能提到已有作品或已有角色，只能提取抽象气质和愿望，不能复刻该角色的姓名、身份、能力体系、专有名词或剧情。
- 不要出现用户提到的外部作品名，不要出现外部作品主角名或称号。
- 角色必须自然属于当前世界观。

请生成 ${count} 个候选主角。每个候选必须包含：
- id：小写英文/数字/下划线，唯一
- name：角色显示姓名
- summary：一句话概括
- background：第二人称背景，和世界观强相关
- motivation：角色进入故事的动机
- initialStats：属性覆盖，只包含需要调整的 key
- initialInventory：初始物品 id 数组，只能从可用 item id 中选择
- openingHook：开场钩子，一句话，适合 DM 第一幕使用

返回格式：
{
  "candidates": [
    {
      "id": "...",
      "name": "...",
      "summary": "...",
      "background": "...",
      "motivation": "...",
      "initialStats": {},
      "initialInventory": [],
      "openingHook": "..."
    }
  ]
}`;
}

function parseCandidates(text: string): ProtagonistProfile[] {
  const jsonText = extractJson(text);
  if (!jsonText) throw new Error("Character generator returned no JSON");
  const parsed = JSON.parse(jsonText) as { candidates?: ProtagonistProfile[] } | ProtagonistProfile[];
  const candidates = Array.isArray(parsed) ? parsed : parsed.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Character generator returned no candidates");
  }
  return candidates;
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const object = trimmed.match(/\{[\s\S]*\}/);
  return object?.[0] ?? null;
}

function normalizeCandidates(
  candidates: ProtagonistProfile[],
  pack: WorldPackForGeneration,
  requestedName: string | undefined,
  count: number
): ProtagonistProfile[] {
  const itemIds = new Set((pack.items ?? []).map((i) => i.id));
  const statDefs = new Map(pack.schema.defs.map((d) => [d.key, d]));
  const seen = new Set<string>();

  return candidates.slice(0, count).map((candidate, index) => {
    const fallbackId = `custom_${index + 1}`;
    const rawId = String(candidate.id || fallbackId).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || fallbackId;
    const id = seen.has(rawId) ? `${rawId}_${index + 1}` : rawId;
    seen.add(id);

    const initialStats: Record<string, number> = {};
    for (const [key, value] of Object.entries(candidate.initialStats ?? {})) {
      const def = statDefs.get(key);
      if (!def || typeof value !== "number") continue;
      initialStats[key] = Math.max(def.min, Math.min(def.max, Math.round(value)));
    }

    return {
      id,
      name: requestedName
        ? safeGeneratedName(requestedName, `角色${index + 1}`)
        : safeGeneratedName(String(candidate.name || ""), `角色${index + 1}`),
      summary: String(candidate.summary || "一名被命运带入故事的人。"),
      background: String(candidate.background || "你不知道自己为何来到这里，但这里显然在等待你。"),
      motivation: String(candidate.motivation || "找出自己来到这里的原因。"),
      initialStats,
      initialInventory: (candidate.initialInventory ?? []).filter((id) => itemIds.has(id)),
      openingHook: candidate.openingHook ? String(candidate.openingHook) : undefined,
    };
  });
}
