import type { Socket } from "bun";
import type { GameRuntime } from "../runtime/game-runtime.ts";
import type { GameOutput } from "../runtime/game-output.ts";
import { formatTextMap } from "../engine/map.ts";

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const GMCP = 201;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TelnetServerOptions {
  runtime: GameRuntime;
  hostname?: string;
  port?: number;
  onLog?: (message: string) => void;
}

interface ConnectionState {
  decoder: TelnetDecoder;
  lineBuffer: string;
  gmcpEnabled: boolean;
  queue: Promise<void>;
  active: boolean;
}

export function startTelnetServer(options: TelnetServerOptions) {
  const runtime = options.runtime;
  const onLog = options.onLog ?? console.log;
  let activeConnection: object | null = null;

  const listener = Bun.listen<ConnectionState>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 4000,
    socket: {
      open(socket) {
        const active = activeConnection === null;
        socket.data = {
          decoder: new TelnetDecoder(),
          lineBuffer: "",
          gmcpEnabled: false,
          queue: Promise.resolve(),
          active,
        };
        socket.write(Uint8Array.from([IAC, WILL, GMCP]));
        if (!active) {
          socket.write("\r\n当前游戏会话已有控制客户端连接。\r\n");
          socket.end();
          return;
        }
        activeConnection = socket;
        onLog(`[telnet] client connected: ${socket.remoteAddress}`);
        sendText(socket, "\x1b[1;36m欢迎来到 mud-pi\x1b[0m");
        sendInitialState(socket, runtime);
      },
      data(socket, data) {
        const decoded = socket.data.decoder.push(data);
        for (const command of decoded.commands) {
          if (command.command === DO && command.option === GMCP) {
            socket.data.gmcpEnabled = true;
            sendGmcpState(socket, runtime);
          }
          if ((command.command === DONT || command.command === WONT) && command.option === GMCP) {
            socket.data.gmcpEnabled = false;
          }
        }
        if (!socket.data.active || !decoded.text) return;
        socket.data.lineBuffer += decoded.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const lines = socket.data.lineBuffer.split("\n");
        socket.data.lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const input = line.trim();
          if (!input) {
            sendPrompt(socket);
            continue;
          }
          socket.data.queue = socket.data.queue
            .then(() => processTelnetInput(socket, runtime, input))
            .catch((error) => sendText(socket, `\x1b[31m[错误] ${error instanceof Error ? error.message : String(error)}\x1b[0m`));
        }
      },
      close(socket) {
        if (activeConnection === socket) activeConnection = null;
        onLog(`[telnet] client disconnected: ${socket.remoteAddress}`);
      },
      error(socket, error) {
        onLog(`[telnet] socket error ${socket.remoteAddress}: ${error.message}`);
      },
    },
  });

  onLog(`[telnet] listening on ${listener.hostname}:${listener.port}`);
  return listener;
}

async function processTelnetInput(
  socket: Socket<ConnectionState>,
  runtime: GameRuntime,
  input: string
): Promise<void> {
  const result = await runtime.processInput(input);
  if (result.quit) {
    sendText(socket, "存档已保存，再见。");
    socket.end();
    return;
  }
  for (const output of result.outputs) sendGameOutput(socket, output, runtime);
  sendGmcpState(socket, runtime);
  sendPrompt(socket);
}

function sendInitialState(
  socket: Socket<ConnectionState>,
  runtime: GameRuntime
): void {
  const state = runtime.getSnapshot();
  const room = state.rooms[state.player.roomId];
  sendText(socket, `\x1b[1;33m${room?.title ?? state.player.roomId}\x1b[0m`);
  if (room) sendText(socket, room.desc);
  sendText(socket, `出口: ${room ? Object.keys(room.exits).join(" ") || "无" : "无"}`);
  sendGmcpState(socket, runtime);
  sendPrompt(socket);
}

function sendGameOutput(
  socket: Socket<ConnectionState>,
  output: GameOutput,
  runtime: GameRuntime
): void {
  switch (output.kind) {
    case "direct_reply":
      sendText(socket, output.text);
      break;
    case "narration":
      sendText(socket, `\x1b[32m${output.text}\x1b[0m`);
      break;
    case "objective_completed":
      sendText(socket, `\x1b[33m✓ 目标完成：${output.title}\x1b[0m`);
      break;
    case "story_outcome":
      sendText(socket, `\x1b[1;35m故事结果：${output.outcome.title}\x1b[0m\r\n${output.outcome.summary}`);
      break;
    case "room_changed": {
      const state = runtime.getSnapshot();
      const room = state.rooms[output.roomId];
      if (room) {
        sendText(socket, `\x1b[1;33m${room.title}\x1b[0m`);
        sendText(socket, room.desc);
        sendText(socket, `出口: ${Object.keys(room.exits).join(" ") || "无"}`);
      }
      break;
    }
  }
}

function sendGmcpState(
  socket: Socket<ConnectionState>,
  runtime: GameRuntime
): void {
  if (!socket.data.gmcpEnabled) return;
  const state = runtime.getSnapshot();
  const room = state.rooms[state.player.roomId];
  const visibleStats = Object.fromEntries(
    state.schema.defs.filter((def) => def.display !== "hidden").map((def) => [
      def.key,
      {
        current: state.player.stats[def.key] ?? def.default,
        max: state.player.maxStats[`${def.key}Max`] ?? def.max,
        label: def.label,
      },
    ])
  );
  sendGmcp(socket, "Char.Vitals", {
    lifecycle: state.player.lifecycle,
    turn: state.turn,
    stats: visibleStats,
  });
  sendGmcp(socket, "Room.Info", {
    id: room?.id,
    name: room?.title,
    exits: room?.exits ?? {},
  });
  sendGmcp(socket, "MudPi.Inventory", {
    items: state.player.inventory.map((id) => ({
      id,
      name: state.items[id]?.name ?? id,
      equipped: Object.values(state.player.equipment).includes(id),
    })),
  });
  sendGmcp(socket, "MudPi.Objectives", {
    objectives: Object.values(state.objectives)
      .filter((objective) => !objective.hidden || objective.status === "completed")
      .map((objective) => ({ id: objective.id, title: objective.title, status: objective.status })),
  });
  sendGmcp(socket, "MudPi.Map", runtime.getMapSnapshot());
  if (state.outcome) sendGmcp(socket, "MudPi.Outcome", state.outcome);
}

function sendText(socket: { write(data: string | Uint8Array): number }, text: string): void {
  socket.write(text.replace(/\r?\n/g, "\r\n") + "\r\n");
}

function sendPrompt(socket: { write(data: string | Uint8Array): number }): void {
  socket.write("\x1b[1m> \x1b[0m");
}

export function encodeGmcp(packageName: string, payload: unknown): Uint8Array {
  const body = encoder.encode(`${packageName} ${JSON.stringify(payload)}`);
  const escaped: number[] = [];
  for (const byte of body) {
    escaped.push(byte);
    if (byte === IAC) escaped.push(IAC);
  }
  return Uint8Array.from([IAC, SB, GMCP, ...escaped, IAC, SE]);
}

function sendGmcp(socket: { write(data: string | Uint8Array): number }, packageName: string, payload: unknown): void {
  socket.write(encodeGmcp(packageName, payload));
}

export interface TelnetCommand {
  command: number;
  option: number;
}

export class TelnetDecoder {
  private pending: number[] = [];

  push(chunk: Uint8Array): { text: string; commands: TelnetCommand[] } {
    const bytes = [...this.pending, ...chunk];
    this.pending = [];
    const text: number[] = [];
    const commands: TelnetCommand[] = [];

    for (let index = 0; index < bytes.length;) {
      const byte = bytes[index]!;
      if (byte !== IAC) {
        text.push(byte);
        index++;
        continue;
      }
      if (index + 1 >= bytes.length) {
        this.pending = bytes.slice(index);
        break;
      }
      const command = bytes[index + 1]!;
      if (command === IAC) {
        text.push(IAC);
        index += 2;
        continue;
      }
      if (command === WILL || command === WONT || command === DO || command === DONT) {
        if (index + 2 >= bytes.length) {
          this.pending = bytes.slice(index);
          break;
        }
        commands.push({ command, option: bytes[index + 2]! });
        index += 3;
        continue;
      }
      if (command === SB) {
        let end = index + 2;
        while (end + 1 < bytes.length && !(bytes[end] === IAC && bytes[end + 1] === SE)) end++;
        if (end + 1 >= bytes.length) {
          this.pending = bytes.slice(index);
          break;
        }
        index = end + 2;
        continue;
      }
      index += 2;
    }

    return { text: decoder.decode(Uint8Array.from(text)), commands };
  }
}
