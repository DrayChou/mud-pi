// ─────────────────────────────────────────────────────────────
// codex-backend.ts — Codex CLI implementation of AiBackend
// ─────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AiBackend, AiPromptOptions, AiSession, AiSessionOptions } from "./backend.ts";

let codexAvailableChecked = false;

export class CodexBackend implements AiBackend {
  readonly name = "codex" as const;

  async createSession(options: AiSessionOptions): Promise<AiSession> {
    assertCodexAvailable();
    return new CodexAiSession(options);
  }

  async ask(options: AiPromptOptions): Promise<string> {
    const session = await this.createSession(options);
    try {
      return await session.ask(options.userPrompt);
    } finally {
      session.dispose();
    }
  }
}

class CodexAiSession implements AiSession {
  constructor(private options: AiSessionOptions) {}

  async ask(prompt: string): Promise<string> {
    return runCodexExec(this.options, prompt);
  }

  dispose(): void {
    // Codex exec is one-shot and --ephemeral, so there is no long-lived session to close.
  }
}

function runCodexExec(options: AiSessionOptions, prompt: string): string {
  const outputFile = join(tmpdir(), `mud-pi-codex-${randomUUID()}.txt`);
  const fullPrompt = buildCodexPrompt(options, prompt);
  const cmd = buildCodexCommand(options, outputFile);

  const result = spawnSync(cmd[0]!, cmd.slice(1), {
    input: fullPrompt,
    encoding: "utf-8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });

  const stdout = (result.stdout ?? "").toString().trim();
  const stderr = (result.stderr ?? "").toString().trim();
  const output = existsSync(outputFile) ? readFileSync(outputFile, "utf-8").trim() : stdout;
  try {
    if (existsSync(outputFile)) unlinkSync(outputFile);
  } catch {
    // Best-effort temp cleanup.
  }

  if (result.status !== 0) {
    const details = [stderr, stdout, result.error?.message].filter(Boolean).join("\n").trim();
    throw new Error(
      `Codex ${options.role} call failed with exit code ${result.status ?? "unknown"}` +
        (details ? `:\n${details}` : "") +
        "\n请确认已安装 Codex CLI 并运行 `codex login` 完成登录。"
    );
  }

  if (!output) {
    throw new Error(`Codex ${options.role} call returned empty output`);
  }
  return output;
}

export function buildCodexCommand(options: AiSessionOptions, outputFile: string): string[] {
  const cmd = [
    "codex",
    "exec",
    "--ephemeral",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--cd",
    process.cwd(),
    "--output-last-message",
    outputFile,
    "--color",
    "never",
  ];

  if (options.model?.trim()) {
    cmd.push("--model", options.model.trim());
  }

  cmd.push("-");
  return cmd;
}

export function buildCodexPrompt(options: AiSessionOptions, userPrompt: string): string {
  const jsonInstruction = options.jsonOnly
    ? "\n\n重要：最终回答只能输出可解析 JSON，不要 Markdown，不要解释。"
    : "";

  return `<SYSTEM_PROMPT>\n${options.systemPrompt}\n</SYSTEM_PROMPT>\n\n<USER_PROMPT>\n${userPrompt}\n</USER_PROMPT>${jsonInstruction}`;
}

function assertCodexAvailable(): void {
  if (codexAvailableChecked) return;

  const result = spawnSync("codex", ["--version"], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      "Codex CLI not found or not runnable. 请先安装 Codex CLI，并运行 `codex login` 完成登录。"
    );
  }
  codexAvailableChecked = true;
}
