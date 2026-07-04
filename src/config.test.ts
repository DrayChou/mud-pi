import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("loadConfig AI backends", () => {
  test("defaults every AI role to Pi", () => {
    delete process.env.AI_BACKEND;
    delete process.env.DM_BACKEND;
    delete process.env.INTERPRETER_BACKEND;
    delete process.env.CHARACTER_BACKEND;

    const config = loadConfig();

    expect(config.dmBackend).toBe("pi");
    expect(config.interpreterBackend).toBe("pi");
    expect(config.characterBackend).toBe("pi");
  });

  test("AI_BACKEND=codex switches all roles to Codex", () => {
    process.env.AI_BACKEND = "codex";
    process.env.CODEX_MODEL = "gpt-5.1";

    const config = loadConfig();

    expect(config.dmBackend).toBe("codex");
    expect(config.interpreterBackend).toBe("codex");
    expect(config.characterBackend).toBe("codex");
    expect(config.codexDmModel).toBe("gpt-5.1");
    expect(config.codexInterpreterModel).toBe("gpt-5.1");
    expect(config.codexCharacterModel).toBe("gpt-5.1");
  });

  test("role-specific backend and Codex model overrides win", () => {
    process.env.AI_BACKEND = "pi";
    process.env.INTERPRETER_BACKEND = "codex";
    process.env.CODEX_MODEL = "default-codex";
    process.env.CODEX_INTERPRETER_MODEL = "small-codex";

    const config = loadConfig();

    expect(config.dmBackend).toBe("pi");
    expect(config.interpreterBackend).toBe("codex");
    expect(config.characterBackend).toBe("pi");
    expect(config.codexDmModel).toBe("default-codex");
    expect(config.codexInterpreterModel).toBe("small-codex");
  });

  test("rejects unknown backend names", () => {
    process.env.AI_BACKEND = "unknown";
    expect(() => loadConfig()).toThrow("AI_BACKEND must be one of");
  });
});
