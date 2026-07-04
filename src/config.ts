// ─────────────────────────────────────────────────────────────
// config.ts — load and validate all settings from .env
// Pi auth/model access is configured by the user in Pi, not in this repo.
// ─────────────────────────────────────────────────────────────

export interface Config {
  // DM model — strong model for narrative + world building
  dmProvider: string;
  dmModel: string;
  dmThinking: "off" | "minimal" | "low" | "medium" | "high";

  // Interpreter model — cheap stateless command parsing
  interpreterProvider: string;
  interpreterModel: string;

  // Game
  worldPack: string;
  defaultPlayerName: string;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high"]);

export function loadConfig(): Config {
  const thinking = optional("DM_THINKING", "low");
  if (!VALID_THINKING.has(thinking)) {
    throw new Error(`DM_THINKING must be one of: ${[...VALID_THINKING].join(", ")}`);
  }

  return {
    dmProvider: optional("DM_PROVIDER", "openai-proxy"),
    dmModel: optional("DM_MODEL", "claude-sonnet-4.6"),
    dmThinking: thinking as Config["dmThinking"],

    interpreterProvider: optional("INTERPRETER_PROVIDER", "openai-proxy"),
    interpreterModel: optional("INTERPRETER_MODEL", "gpt-5.4-mini"),

    worldPack: optional("WORLD_PACK", "station-dream"),
    defaultPlayerName: optional("DEFAULT_PLAYER_NAME", "旅行者"),
  };
}
