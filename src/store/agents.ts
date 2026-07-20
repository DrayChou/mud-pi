// ─────────────────────────────────────────────────────────────
// agents.ts — save-local registry for Pi's native session JSONL files
// ─────────────────────────────────────────────────────────────

import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentManifest } from "../types/agents.ts";
import { emptyAgentManifest } from "../types/agents.ts";

function saveDir(worldId: string): string {
  return join(import.meta.dir, "../../saves", worldId);
}

export function agentDir(worldId: string): string {
  return join(saveDir(worldId), "agents");
}

export function agentSessionDir(worldId: string): string {
  return join(agentDir(worldId), "sessions");
}

function manifestFile(worldId: string): string {
  return join(agentDir(worldId), "manifest.json");
}

export async function ensureAgentSessionDir(worldId: string): Promise<string> {
  const dir = agentSessionDir(worldId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function loadAgentManifest(worldId: string): Promise<AgentManifest> {
  const file = Bun.file(manifestFile(worldId));
  if (!(await file.exists())) return emptyAgentManifest();

  try {
    const parsed = await file.json() as Partial<AgentManifest>;
    if (parsed.version !== 1) {
      console.warn(`[agents] unsupported manifest version for ${worldId}; using an empty manifest`);
      return emptyAgentManifest();
    }
    return {
      version: 1,
      dm: parsed.dm,
      npcs: parsed.npcs ?? {},
    };
  } catch {
    console.warn(`[agents] corrupt manifest for ${worldId}; using an empty manifest`);
    return emptyAgentManifest();
  }
}

export async function saveAgentManifest(worldId: string, manifest: AgentManifest): Promise<void> {
  const file = manifestFile(worldId);
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, JSON.stringify(manifest, null, 2));
}

export function toAgentRelativePath(worldId: string, sessionFile: string): string {
  const base = resolve(agentDir(worldId));
  const target = resolve(sessionFile);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Pi session file is outside the save agent directory: ${sessionFile}`);
  }
  return rel;
}

export function resolveAgentSessionPath(worldId: string, storedPath: string): string {
  if (isAbsolute(storedPath)) {
    // Compatibility with early/local manifests; new writes always use relative paths.
    return storedPath;
  }

  const base = resolve(agentDir(worldId));
  const target = resolve(base, storedPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Invalid agent session path in manifest: ${storedPath}`);
  }
  return target;
}
