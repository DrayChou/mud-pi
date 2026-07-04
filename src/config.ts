// ─────────────────────────────────────────────────────────────
// config.ts — load and validate all settings from .env
// Pi/Codex auth and model access are configured by the user locally.
// ─────────────────────────────────────────────────────────────

export type AiBackendName = "pi" | "codex";

export interface Config {
  // Backend routing
  dmBackend: AiBackendName;
  interpreterBackend: AiBackendName;
  characterBackend: AiBackendName;

  // DM model — strong model for narrative + world building (Pi backend)
  dmProvider: string;
  dmModel: string;
  dmThinking: "off" | "minimal" | "low" | "medium" | "high";

  // Interpreter model — cheap stateless command parsing (Pi backend)
  interpreterProvider: string;
  interpreterModel: string;

  // Codex models. Undefined means use the user's Codex default model.
  codexDmModel: string | undefined;
  codexInterpreterModel: string | undefined;
  codexCharacterModel: string | undefined;

  // Game
  worldPack: string;
  defaultPlayerName: string;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalMaybe(name: string, fallback?: string): string | undefined {
  const value = process.env[name] || fallback;
  return value?.trim() || undefined;
}

const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high"]);
const VALID_BACKENDS = new Set(["pi", "codex"]);

function backend(name: string, value: string): AiBackendName {
  if (!VALID_BACKENDS.has(value)) {
    throw new Error(`${name} must be one of: ${[...VALID_BACKENDS].join(", ")}`);
  }
  return value as AiBackendName;
}

export function loadConfig(): Config {
  const thinking = optional("DM_THINKING", "low");
  if (!VALID_THINKING.has(thinking)) {
    throw new Error(`DM_THINKING must be one of: ${[...VALID_THINKING].join(", ")}`);
  }

  const defaultBackend = backend("AI_BACKEND", optional("AI_BACKEND", "pi"));

  return {
    dmBackend: backend("DM_BACKEND", optional("DM_BACKEND", defaultBackend)),
    interpreterBackend: backend(
      "INTERPRETER_BACKEND",
      optional("INTERPRETER_BACKEND", defaultBackend)
    ),
    characterBackend: backend("CHARACTER_BACKEND", optional("CHARACTER_BACKEND", defaultBackend)),

    dmProvider: optional("DM_PROVIDER", "openai-proxy"),
    dmModel: optional("DM_MODEL", "claude-sonnet-4.6"),
    dmThinking: thinking as Config["dmThinking"],

    interpreterProvider: optional("INTERPRETER_PROVIDER", "openai-proxy"),
    interpreterModel: optional("INTERPRETER_MODEL", "gpt-5.4-mini"),

    codexDmModel: optionalMaybe("CODEX_DM_MODEL", optionalMaybe("CODEX_MODEL")),
    codexInterpreterModel: optionalMaybe(
      "CODEX_INTERPRETER_MODEL",
      optionalMaybe("CODEX_MODEL")
    ),
    codexCharacterModel: optionalMaybe("CODEX_CHARACTER_MODEL", optionalMaybe("CODEX_MODEL")),

    worldPack: optional("WORLD_PACK", "station-dream"),
    defaultPlayerName: optional("DEFAULT_PLAYER_NAME", "旅行者"),
  };
}
