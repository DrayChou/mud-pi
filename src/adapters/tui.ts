import {
  Input,
  Key,
  matchesKey,
  ProcessTerminal,
  TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { GameRuntime } from "../runtime/game-runtime.ts";
import type { GameOutput } from "../runtime/game-output.ts";
import { formatTextMap } from "../engine/map.ts";
import { effectivePlayerStats } from "../engine/parameters.ts";
import type { WorldState } from "../types/world.ts";

const RESET = "\x1b[0m";
const BOLD = (text: string) => `\x1b[1m${text}${RESET}`;
const DIM = (text: string) => `\x1b[2m${text}${RESET}`;
const CYAN = (text: string) => `\x1b[36m${text}${RESET}`;
const GREEN = (text: string) => `\x1b[32m${text}${RESET}`;
const YELLOW = (text: string) => `\x1b[33m${text}${RESET}`;
const MAGENTA = (text: string) => `\x1b[35m${text}${RESET}`;
const RED = (text: string) => `\x1b[31m${text}${RESET}`;

export async function runMudTui(
  runtime: GameRuntime,
  options: { title?: string; initialOutputs?: GameOutput[] } = {}
): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  terminal.setTitle(options.title ?? "mud-pi");
  terminal.clearScreen();

  await new Promise<void>((resolve) => {
    const component = new MudTuiComponent(runtime, tui, () => {
      tui.stop();
      resolve();
    }, options.initialOutputs);
    tui.addChild(component);
    tui.setFocus(component);
    tui.start();
  });

  await terminal.drainInput(200, 30);
}

export class MudTuiComponent implements Component, Focusable {
  private readonly runtime: GameRuntime;
  private readonly tui: TUI;
  private readonly input = new Input();
  private readonly onQuit: () => void;
  private log: string[] = [];
  private busy = false;
  private version = 0;
  private cachedVersion = -1;
  private cachedWidth = 0;
  private cachedLines: string[] = [];
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(runtime: GameRuntime, tui: TUI, onQuit: () => void, initialOutputs: GameOutput[] = []) {
    this.runtime = runtime;
    this.tui = tui;
    this.onQuit = onQuit;
    const state = runtime.getSnapshot();
    const room = state.rooms[state.player.roomId];
    this.log.push(GREEN(room ? `${room.title}\n${room.desc}` : "故事开始。"));
    for (const output of initialOutputs) this.appendOutput(output);
    this.input.onSubmit = (value) => void this.submit(value);
    this.input.onEscape = () => this.onQuit();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.onQuit();
      return;
    }
    if (this.busy) return;
    this.input.handleInput(data);
    this.invalidate();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = 0;
    this.input.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedVersion === this.version) return this.cachedLines;
    const state = this.runtime.getSnapshot();
    const contentWidth = Math.max(40, width);
    const lines = contentWidth >= 100
      ? this.renderWide(state, contentWidth)
      : this.renderNarrow(state, contentWidth);
    this.cachedLines = lines.map((line) => truncateToWidth(line, contentWidth, ""));
    this.cachedWidth = width;
    this.cachedVersion = this.version;
    return this.cachedLines;
  }

  private async submit(raw: string): Promise<void> {
    const value = raw.trim();
    if (!value || this.busy) return;
    this.input.setValue("");
    this.log.push(CYAN(`> ${value}`));
    this.busy = true;
    this.version++;
    this.tui.requestRender();

    try {
      const result = await this.runtime.processInput(value);
      if (result.quit) {
        this.onQuit();
        return;
      }
      for (const output of result.outputs) this.appendOutput(output);
    } catch (error) {
      this.log.push(RED(`[错误] ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      this.busy = false;
      this.version++;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private appendOutput(output: GameOutput): void {
    switch (output.kind) {
      case "direct_reply":
        this.log.push(output.text);
        break;
      case "narration":
        this.log.push(GREEN(output.text));
        break;
      case "objective_completed":
        this.log.push(YELLOW(`✓ 目标完成：${output.title}`));
        break;
      case "story_outcome":
        this.log.push(MAGENTA(`故事结果：${output.outcome.title}\n${output.outcome.summary}`));
        break;
      case "room_changed": {
        const state = this.runtime.getSnapshot();
        const room = state.rooms[output.roomId];
        if (room) this.log.push(BOLD(YELLOW(`[${room.title}]`)));
        break;
      }
      case "combat_warning":
        this.log.push(RED(`⚠ ${output.text}`));
        break;
      case "combat_result": {
        const result = output.result;
        this.log.push(BOLD(
          `战斗模拟：${result.player.name} ${result.player.poolBefore}→${result.player.poolAfter} ｜ ` +
          `${result.npc.name} ${result.npc.poolBefore}→${result.npc.poolAfter} ｜ ` +
          `胜者：${result.winner === "player" ? result.player.name : result.npc.name}`
        ));
        break;
      }
    }
  }

  private renderWide(state: WorldState, width: number): string[] {
    const leftWidth = 25;
    const rightWidth = 31;
    const centerWidth = Math.max(40, width - leftWidth - rightWidth - 2);
    const height = 23;
    const left = panel("玩家 / 目标", this.leftLines(state), leftWidth, height);
    const center = panel("叙事", this.narrativeLines(centerWidth - 2, height - 2), centerWidth, height);
    const right = panel("房间 / 地图", this.rightLines(state), rightWidth, height);
    const rows = left.map((line, index) => `${line} ${center[index] ?? ""} ${right[index] ?? ""}`);
    return [this.header(state, width), ...rows, ...this.inputLines(width)];
  }

  private renderNarrow(state: WorldState, width: number): string[] {
    const narrative = panel("叙事", this.narrativeLines(width - 2, 13), width, 15);
    const status = panel("状态", [...this.leftLines(state), "", ...this.rightLines(state)], width, 12);
    return [this.header(state, width), ...narrative, ...status, ...this.inputLines(width)];
  }

  private header(state: WorldState, width: number): string {
    const text = ` mud-pi │ ${state.worldPack} │ ${state.player.name} │ 第 ${state.turn} 轮 │ ${state.player.lifecycle} `;
    const fill = Math.max(0, width - visibleWidth(text));
    return BOLD(CYAN(text)) + DIM("─".repeat(fill));
  }

  private leftLines(state: WorldState): string[] {
    const effectiveStats = effectivePlayerStats(state);
    const stats = state.schema.defs
      .filter((def) => def.display !== "hidden")
      .map((def) => {
        const current = effectiveStats[def.key] ?? def.default;
        const max = state.player.maxStats[`${def.key}Max`] ?? def.max;
        return `${def.label}: ${def.display === "bar" ? `${current}/${max}` : current}`;
      });
    const objectives = Object.values(state.objectives)
      .filter((objective) => !objective.hidden || objective.status === "completed")
      .map((objective) => `${objective.status === "completed" ? "✓" : "○"} ${objective.title}`);
    const inventory = state.player.inventory.map((id) => state.items[id]?.name ?? id);
    return [
      ...stats,
      `阶段: ${state.player.lifecycle}`,
      "",
      BOLD("目标"),
      ...(objectives.length > 0 ? objectives : [DIM("无")]),
      "",
      BOLD("背包"),
      ...(inventory.length > 0 ? inventory.map((item) => `• ${item}`) : [DIM("空")]),
    ];
  }

  private rightLines(state: WorldState): string[] {
    const room = state.rooms[state.player.roomId];
    const npcs = Object.values(state.npcs).filter((npc) => npc.alive && npc.roomId === state.player.roomId);
    const items = Object.values(state.items).filter(
      (item) => item.location.kind === "room" && item.location.roomId === state.player.roomId
    );
    const mapLines = formatTextMap(this.runtime.getMapSnapshot()).split("\n").slice(1);
    return [
      BOLD(room?.title ?? state.player.roomId),
      `出口: ${room ? Object.keys(room.exits).join(" ") || "无" : "无"}`,
      `NPC: ${npcs.map((npc) => npc.name).join("、") || "无"}`,
      `物品: ${items.map((item) => item.name).join("、") || "无"}`,
      "",
      BOLD("地图"),
      ...mapLines,
    ];
  }

  private narrativeLines(width: number, height: number): string[] {
    const wrapped = this.log.flatMap((entry) =>
      entry.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)))
    );
    return wrapped.slice(-height);
  }

  private inputLines(width: number): string[] {
    const status = this.busy ? YELLOW(" DM 与 NPC 正在思考…") : DIM(" Enter 发送 │ Esc/Ctrl+C 退出 ");
    const inputWidth = Math.max(1, width - 3);
    const rendered = this.input.render(inputWidth);
    return [status, ...rendered.map((line) => `> ${line}`)];
  }
}

function panel(title: string, content: string[], width: number, height: number): string[] {
  const innerWidth = Math.max(1, width - 2);
  const titleText = ` ${title} `;
  const top = `┌${titleText}${"─".repeat(Math.max(0, innerWidth - visibleWidth(titleText)))}┐`;
  const bodyHeight = Math.max(0, height - 2);
  const body: string[] = [];
  for (let index = 0; index < bodyHeight; index++) {
    const value = content[index] ?? "";
    const clipped = truncateToWidth(value, innerWidth, "");
    body.push(`│${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}│`);
  }
  return [DIM(top), ...body, DIM(`└${"─".repeat(innerWidth)}┘`)];
}
