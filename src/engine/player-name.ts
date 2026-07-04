// ─────────────────────────────────────────────────────────────
// player-name.ts — player name validation and normalization
// ─────────────────────────────────────────────────────────────

export const PLAYER_NAME_MAX_CHARS = 16;

const SENTENCE_MARKERS = /[?？!！。；;：:，,、]/;
const DESCRIPTION_PHRASES = /(你知道|我是|我就是|主角|里面的|扮演|一个|一名|来自|想要|希望|角色|描述)/;

export interface PlayerNameValidationResult {
  ok: boolean;
  value?: string;
  reason?: string;
}

export function normalizePlayerName(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

export function validatePlayerName(input: string): PlayerNameValidationResult {
  const value = normalizePlayerName(input);
  if (!value) return { ok: true, value: undefined };

  if ([...value].length > PLAYER_NAME_MAX_CHARS) {
    return {
      ok: false,
      reason: `姓名最多 ${PLAYER_NAME_MAX_CHARS} 个字符；角色背景请写到下一步“角色描述”里。`,
    };
  }

  if (SENTENCE_MARKERS.test(value)) {
    return {
      ok: false,
      reason: "姓名里不要包含问号、句号、逗号等整句标点；角色背景请写到下一步“角色描述”里。",
    };
  }

  if (DESCRIPTION_PHRASES.test(value)) {
    return {
      ok: false,
      reason: "这看起来像角色描述，不像姓名；可以留空让 AI 命名，或输入一个简短姓名。",
    };
  }

  return { ok: true, value };
}

export function safeGeneratedName(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const value = normalizePlayerName(input);
  if (!value) return fallback;
  if ([...value].length <= PLAYER_NAME_MAX_CHARS && !SENTENCE_MARKERS.test(value)) {
    return value;
  }

  return [...value]
    .filter((ch) => !SENTENCE_MARKERS.test(ch))
    .slice(0, PLAYER_NAME_MAX_CHARS)
    .join("")
    .trim() || fallback;
}
