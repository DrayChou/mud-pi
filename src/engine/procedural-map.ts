import type {
  ProceduralRoomRole,
  RoomDef,
  WorldGenerationState,
} from "../types/world.ts";

export const PROCEDURAL_MAP_VERSION = "seeded-mst-v1";

export interface ProceduralRoomTemplate {
  title: string;
  desc: string;
  tags?: string[];
}

export interface ProceduralMapConfig {
  generator: typeof PROCEDURAL_MAP_VERSION;
  totalRooms: { min: number; max: number };
  loopChance: number;
  attachTo: string;
  templates: ProceduralRoomTemplate[];
}

export interface GenerateProceduralMapInput {
  seed: string;
  config: ProceduralMapConfig;
  staticRooms: Record<string, RoomDef>;
}

export interface GeneratedProceduralMap {
  rooms: Record<string, RoomDef>;
  generation: WorldGenerationState;
}

const DIRECTION_PAIRS = [
  ["north", "south"],
  ["east", "west"],
  ["up", "down"],
] as const;

interface Edge {
  a: number;
  b: number;
  weight: number;
}

/** Generate a connected graph using a seeded constrained Kruskal MST plus optional loops. */
export function generateProceduralMap(input: GenerateProceduralMapInput): GeneratedProceduralMap {
  const { config, staticRooms } = input;
  if (config.generator !== PROCEDURAL_MAP_VERSION) {
    throw new Error(`Unsupported procedural map generator: ${config.generator}`);
  }
  if (!staticRooms[config.attachTo]) {
    throw new Error(`Procedural map attachTo references missing room: ${config.attachTo}`);
  }
  if (config.templates.length === 0) throw new Error("Procedural map requires at least one room template");

  const random = createSeededRandom(input.seed);
  const min = Math.max(Object.keys(staticRooms).length, Math.floor(config.totalRooms.min));
  const max = Math.max(min, Math.floor(config.totalRooms.max));
  const targetTotal = min + Math.floor(random() * (max - min + 1));
  const generatedCount = Math.max(0, targetTotal - Object.keys(staticRooms).length);
  const rooms = structuredClone(staticRooms);
  const generatedIds = Array.from({ length: generatedCount }, (_, index) => `proc_${String(index + 1).padStart(2, "0")}`);
  const collision = generatedIds.find((id) => rooms[id]);
  if (collision) throw new Error(`Procedural room id collides with static room: ${collision}`);

  for (const [index, id] of generatedIds.entries()) {
    const template = config.templates[Math.floor(random() * config.templates.length)]!;
    rooms[id] = {
      id,
      title: template.title.replaceAll("{n}", String(index + 1)),
      desc: template.desc.replaceAll("{n}", String(index + 1)),
      exits: {},
      tags: [...(template.tags ?? []), "procedural"],
      source: "procedural",
      discovered: false,
    };
  }

  const nodeIds = [config.attachTo, ...generatedIds];
  const edges = completeEdges(nodeIds.length, random);
  const connected = new DisjointSet(nodeIds.length);
  let mstEdges = 0;
  for (const edge of edges) {
    if (connected.find(edge.a) === connected.find(edge.b)) continue;
    if (!connectRooms(rooms[nodeIds[edge.a]!]!, rooms[nodeIds[edge.b]!]!, random)) continue;
    connected.union(edge.a, edge.b);
    mstEdges++;
    if (mstEdges === nodeIds.length - 1) break;
  }

  // Degree constraints can make an arbitrary Kruskal edge unavailable. Deterministically
  // connect any remaining component to the growing component using the first free pair.
  for (let index = 1; index < nodeIds.length; index++) {
    if (connected.find(0) === connected.find(index)) continue;
    let attached = false;
    for (let anchor = 0; anchor < nodeIds.length && !attached; anchor++) {
      if (connected.find(anchor) !== connected.find(0)) continue;
      if (connectRooms(rooms[nodeIds[anchor]!]!, rooms[nodeIds[index]!]!, random)) {
        connected.union(anchor, index);
        mstEdges++;
        attached = true;
      }
    }
    if (!attached) throw new Error("Unable to connect procedural map within direction constraints");
  }

  let loopEdges = 0;
  const targetLoops = Math.round(Math.max(0, Math.min(1, config.loopChance)) * Math.max(0, targetTotal - 1));
  for (const edge of edges) {
    if (loopEdges >= targetLoops) break;
    const a = rooms[nodeIds[edge.a]!]!;
    const b = rooms[nodeIds[edge.b]!]!;
    if (areConnected(a, b.id) || !connectRooms(a, b, random)) continue;
    loopEdges++;
  }

  const roomRoles = assignSemanticRoles(rooms, config.attachTo, generatedIds, random);
  for (const [roomId, role] of Object.entries(roomRoles)) {
    const room = rooms[roomId];
    if (room && room.source === "procedural") room.tags = [...(room.tags ?? []), `role:${role}`];
  }

  return {
    rooms,
    generation: {
      seed: input.seed,
      generatorVersion: PROCEDURAL_MAP_VERSION,
      targetRoomCount: targetTotal,
      generatedRoomIds: generatedIds,
      roomRoles,
      mstEdges,
      loopEdges,
    },
  };
}

function assignSemanticRoles(
  rooms: Record<string, RoomDef>,
  entranceId: string,
  generatedIds: string[],
  random: () => number
): Record<string, ProceduralRoomRole> {
  const roles: Record<string, ProceduralRoomRole> = { [entranceId]: "entrance" };
  for (const id of generatedIds) roles[id] = "transit";
  if (generatedIds.length === 0) return roles;

  const distances = roomDistances(rooms, entranceId);
  const farthestFirst = [...generatedIds].sort(
    (a, b) => (distances.get(b) ?? 0) - (distances.get(a) ?? 0) || a.localeCompare(b)
  );
  const bossId = farthestFirst.shift()!;
  roles[bossId] = "boss";

  const remaining = farthestFirst
    .map((id) => ({ id, weight: random() }))
    .sort((a, b) => a.weight - b.weight || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
  const treasureId = remaining.shift();
  const specialId = remaining.shift();
  if (treasureId) roles[treasureId] = "treasure";
  if (specialId) roles[specialId] = "special";
  return roles;
}

function roomDistances(rooms: Record<string, RoomDef>, startId: string): Map<string, number> {
  const distances = new Map<string, number>([[startId, 0]]);
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const distance = distances.get(id)!;
    for (const targetId of Object.values(rooms[id]?.exits ?? {})) {
      if (distances.has(targetId)) continue;
      distances.set(targetId, distance + 1);
      queue.push(targetId);
    }
  }
  return distances;
}

function completeEdges(count: number, random: () => number): Edge[] {
  const edges: Edge[] = [];
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) edges.push({ a, b, weight: random() });
  }
  return edges.sort((left, right) => left.weight - right.weight || left.a - right.a || left.b - right.b);
}

function connectRooms(a: RoomDef, b: RoomDef, random: () => number): boolean {
  const choices = DIRECTION_PAIRS.flatMap(([forward, backward]) => [
    [forward, backward] as const,
    [backward, forward] as const,
  ]).filter(([from, to]) => !a.exits[from] && !b.exits[to]);
  if (choices.length === 0) return false;
  const [from, to] = choices[Math.floor(random() * choices.length)]!;
  a.exits[from] = b.id;
  b.exits[to] = a.id;
  return true;
}

function areConnected(room: RoomDef, targetId: string): boolean {
  return Object.values(room.exits).includes(targetId);
}

/** xmur3 string hashing followed by mulberry32; deterministic across JS runtimes. */
export function createSeededRandom(seed: string): () => number {
  let hash = 1779033703 ^ seed.length;
  for (let index = 0; index < seed.length; index++) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 3432918353);
    hash = hash << 13 | hash >>> 19;
  }
  hash = Math.imul(hash ^ hash >>> 16, 2246822507);
  hash = Math.imul(hash ^ hash >>> 13, 3266489909);
  let value = (hash ^ hash >>> 16) >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ result >>> 15, result | 1);
    result ^= result + Math.imul(result ^ result >>> 7, result | 61);
    return ((result ^ result >>> 14) >>> 0) / 4294967296;
  };
}

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(value: number): number {
    const parent = this.parent[value]!;
    if (parent !== value) this.parent[value] = this.find(parent);
    return this.parent[value]!;
  }

  union(a: number, b: number): void {
    this.parent[this.find(b)] = this.find(a);
  }
}
