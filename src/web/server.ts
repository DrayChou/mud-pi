import index from "./index.html";
import { WebGameManager } from "./game-manager.ts";

const manager = new WebGameManager();
const port = Number(Bun.env.WEB_PORT ?? 3000);
const hostname = Bun.env.WEB_HOST ?? "0.0.0.0";

const server = Bun.serve({
  hostname,
  port,
  routes: {
    "/": index,
    "/api/worlds": {
      GET: async () => json(await manager.worlds()),
    },
    "/api/games": {
      POST: async (request) => route(async () => {
        const body = await request.json() as Record<string, unknown>;
        return await manager.createGame({
          worldPack: String(body.worldPack ?? "station-dream"),
          playerName: typeof body.playerName === "string" ? body.playerName : undefined,
          protagonistId: typeof body.protagonistId === "string" ? body.protagonistId : undefined,
          seed: typeof body.seed === "string" ? body.seed : undefined,
        });
      }),
    },
    "/api/games/:worldId": {
      GET: (request) => route(() => manager.resume(request.params.worldId, bearer(request))),
    },
    "/api/games/:worldId/input": {
      POST: (request) => route(async () => {
        const body = await request.json() as Record<string, unknown>;
        const input = String(body.input ?? "").trim();
        if (!input || input.length > 2000) throw new Error("请输入 1–2000 字的行动");
        return await manager.input(request.params.worldId, bearer(request), input);
      }),
    },
  },
  development: Bun.env.NODE_ENV !== "production" ? { hmr: true, console: true } : false,
});

console.log(`mud-pi Web：http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${server.port}`);

async function route<T>(handler: () => Promise<T>): Promise<Response> {
  try {
    return json(await handler());
  } catch (error) {
    console.error("[web]", error);
    const message = error instanceof Error ? error.message : String(error);
    const status = /凭证|不存在/.test(message) ? 404 : 400;
    return json({ error: message }, status);
  }
}

function bearer(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  if (!value.startsWith("Bearer ")) throw new Error("存档访问凭证无效");
  return value.slice(7);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

const shutdown = async () => {
  await manager.shutdown();
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
