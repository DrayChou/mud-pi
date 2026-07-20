import type { WorldState } from "../types/world.ts";

export interface MapExitSnapshot {
  direction: string;
  toRoomId?: string;
  toRoomTitle?: string;
  discovered: boolean;
}

export interface MapRoomSnapshot {
  id: string;
  title: string;
  current: boolean;
  visitedTurn?: number;
  exits: MapExitSnapshot[];
}

export interface MapSnapshot {
  currentRoomId: string;
  rooms: MapRoomSnapshot[];
}

export function buildMapSnapshot(state: WorldState): MapSnapshot {
  const rooms = Object.values(state.rooms)
    .filter((room) => room.discovered)
    .sort((a, b) => (a.visitedTurn ?? Number.MAX_SAFE_INTEGER) - (b.visitedTurn ?? Number.MAX_SAFE_INTEGER))
    .map((room): MapRoomSnapshot => ({
      id: room.id,
      title: room.title,
      current: room.id === state.player.roomId,
      visitedTurn: room.visitedTurn,
      exits: Object.entries(room.exits).map(([direction, toRoomId]) => {
        const target = state.rooms[toRoomId];
        const discovered = target?.discovered === true;
        return {
          direction,
          toRoomId: discovered ? toRoomId : undefined,
          toRoomTitle: discovered ? target.title : undefined,
          discovered,
        };
      }),
    }));

  return { currentRoomId: state.player.roomId, rooms };
}

export function formatTextMap(snapshot: MapSnapshot): string {
  if (snapshot.rooms.length === 0) return "你还没有探索任何地点。";
  const lines = snapshot.rooms.map((room) => {
    const marker = room.current ? "*" : "✓";
    const exits = room.exits.length === 0
      ? "无出口"
      : room.exits.map((exit) =>
          `${exit.direction}→${exit.discovered ? exit.toRoomTitle : "未知区域"}`
        ).join("，");
    return `${marker} ${room.title}\n  ${exits}`;
  });
  return `已探索地图（* 为当前位置）：\n${lines.join("\n")}`;
}
