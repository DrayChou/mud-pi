import { describe, expect, test } from "bun:test";
import { buildCodexCommand, buildCodexPrompt } from "./codex-backend.ts";

describe("CodexBackend command safety", () => {
  test("builds codex exec with read-only ephemeral safety flags", () => {
    const cmd = buildCodexCommand(
      {
        role: "dm",
        systemPrompt: "system",
        model: "gpt-test",
      },
      "/tmp/out.txt"
    );

    expect(cmd.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(cmd).toContain("--ephemeral");
    expect(cmd).toContain("--ignore-rules");
    expect(cmd).toContain("--sandbox");
    expect(cmd[cmd.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(cmd).toContain("--ask-for-approval");
    expect(cmd[cmd.indexOf("--ask-for-approval") + 1]).toBe("never");
    expect(cmd).toContain("--output-last-message");
    expect(cmd[cmd.indexOf("--output-last-message") + 1]).toBe("/tmp/out.txt");
    expect(cmd).toContain("--model");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("gpt-test");
    expect(cmd).not.toContain("workspace-write");
    expect(cmd).not.toContain("danger-full-access");
    expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd.at(-1)).toBe("-");
  });

  test("omits --model when Codex should use its own default", () => {
    const cmd = buildCodexCommand(
      {
        role: "interpreter",
        systemPrompt: "system",
      },
      "/tmp/out.txt"
    );

    expect(cmd).not.toContain("--model");
  });

  test("adds JSON-only instruction when requested", () => {
    const prompt = buildCodexPrompt(
      {
        role: "interpreter",
        systemPrompt: "Return JSON",
        jsonOnly: true,
      },
      "go east"
    );

    expect(prompt).toContain("<SYSTEM_PROMPT>");
    expect(prompt).toContain("Return JSON");
    expect(prompt).toContain("<USER_PROMPT>");
    expect(prompt).toContain("go east");
    expect(prompt).toContain("只能输出可解析 JSON");
  });
});
