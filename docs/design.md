# mud-pi 设计文档

## 概览

mud-pi 是一个由可配置 AI backend（Pi SDK 或 Codex CLI）驱动的文字 MUD 引擎。世界观只提供开场设定，后续地图、剧情、NPC 全部由 DM（AI）在游戏中动态生成和累积。

---

## 角色分工

```
玩家输入
   │
   ▼
[Interpreter]  ← 便宜小模型（haiku / flash），无状态，无历史
   │              职责：自然语言 → ParsedCommand { verb, args }
   ▼
[Engine]       ← 纯 TypeScript 代码
   │              职责：执行游戏规则，产生 EngineMutation[]
   ▼
[DM]           ← AI backend，强模型（Pi 或 Codex）
   │              职责：接收世界快照+事件 → 叙事文字 + WorldUpdate JSON
   ▼
[apply + persist]
                  职责：应用所有 mutation，写 state.json + turns.jsonl
```

---

## 数据变更原则

**所有状态变更必须经过 `applyMutation()`，没有例外。**

变更来源只有两个：

| 来源 | 类型前缀 | 触发时机 |
|------|----------|----------|
| 游戏引擎（玩家行动） | `engine/*` | 解析指令后，引擎执行时 |
| DM 返回 | `dm/*` | 解析 `<WORLD_UPDATE>` JSON 后 |

引擎 mutation 决定"能不能发生"，DM mutation 决定"世界如何响应"。

---

## Engine Mutations（引擎变更）

```typescript
engine/player_moved       { toRoomId }
engine/player_hp_changed  { delta }         // 负数=扣血
engine/item_picked_up     { itemId }
engine/item_dropped       { itemId, roomId }
engine/item_equipped      { itemId, slot }
engine/npc_killed         { npcId }
engine/turn_advanced                        // 每轮最后执行
```

---

## DM Mutations（DM 变更）

```typescript
dm/room_added          { room: RoomDef }             // DM 创造新房间
dm/room_exit_added     { roomId, direction, toRoomId } // 打通新出口
dm/room_desc_updated   { roomId, descAppend }         // 追加描述变化
dm/npc_added           { npc: NpcDef }               // DM 创造新 NPC
dm/npc_moved           { npcId, toRoomId }
dm/npc_killed          { npcId }
dm/fact_added          { text, tile }                // tile=null 全局可见
dm/fact_removed        { text }
dm/plot_updated        { id, title?, status?, summary? }
```

---

## 数据文件

```
saves/{worldId}/
├── state.json     ← 当前世界完整快照（每轮覆写）
└── turns.jsonl    ← 轮次日志（只追加，永不修改）
```

### state.json 结构

```json
{
  "worldId": "station-dream-001",
  "worldPack": "station-dream",
  "turn": 42,
  "player": {
    "id": "player1",
    "name": "旅行者",
    "roomId": "Compartment3",
    "hp": 85, "maxHp": 100,
    "inventory": ["rusty_knife", "ticket"],
    "equipment": { "weapon": "rusty_knife" }
  },
  "rooms": {
    "StationHall": {
      "id": "StationHall",
      "title": "车站入口大厅",
      "desc": "...",
      "exits": { "east": "Platform" },
      "source": "static"
    },
    "MysteriousTunnel": {
      "source": "dm_generated",
      "createdTurn": 38,
      "..."
    }
  },
  "npcs": { "ticket_clerk": { "roomId": "StationHall", "alive": true, "..." } },
  "items": { "ticket": { "name": "车票", "..." } },
  "plotThreads": {
    "locked_door": {
      "id": "locked_door",
      "title": "铁门之谜",
      "status": "active",
      "summary": "铁门有感知，锁孔形状特殊，可能需要车票",
      "updatedTurn": 40
    }
  },
  "worldFacts": [
    { "text": "售票员已等候数百年", "tile": null, "createdTurn": 1 },
    { "text": "铁门锁孔形状异常", "tile": "Compartment3", "createdTurn": 15 }
  ]
}
```

### turns.jsonl 结构（每行一轮）

```jsonl
{"turn":42,"ts":1751615784,"playerInput":"检查铁门","parsed":{"verb":"examine","args":{"target":"铁门"},"confidence":0.95},"engineMutations":[{"kind":"engine/turn_advanced"}],"dmMutations":[{"kind":"dm/fact_added","text":"铁门锁孔形状异常","tile":"Compartment3"}],"narration":"铁门在你指尖微微颤抖...","dmModel":"claude-sonnet-4.6"}
```

---

## DM 上下文窗口

DM backend 接收三层上下文。Pi backend 使用长会话并可自动压缩；Codex backend 通过每轮 `codex exec --ephemeral` 调用，因此主要依赖外部 state 注入保持连续性：

```
┌──────────────────────────────────────────────────────┐
│  SYSTEM PROMPT（永久）                                │
│  lore.md 世界观 + DM 行为指令 + 输出格式要求          │
├──────────────────────────────────────────────────────┤
│  CONVERSATION HISTORY（backend 相关）                 │
│  Pi: 长会话 + 自动压缩；Codex: 每轮 one-shot           │
│  事实连续性不依赖内部记忆，见外部记忆策略              │
├──────────────────────────────────────────────────────┤
│  CURRENT TURN PROMPT（每轮从 state.json 构建）        │
│  见下方                                               │
└──────────────────────────────────────────────────────┘
```

### 每轮注入给 DM 的 prompt 结构

```
[世界事实]                         ← 来自 state.worldFacts（按 tile 过滤）
• 售票员已等候数百年
• 铁门锁孔形状异常（位置：Compartment3）

[活跃剧情线]                       ← 来自 state.plotThreads（status=active）
• 🔴 铁门之谜：铁门有感知，可能需要车票

[当前房间状态]                     ← 来自 state.rooms[player.roomId]
位置：列车第三节车厢（Compartment3）
出口：south → Compartment2, dream → DreamWorkshop
房间内：阴影（alive），铁门

[主角设定]                         ← 来自 state.player.profile（存档快照）
姓名：林舟
身份概括：想回家的乘客
背景：你不确定自己为什么在车站醒来...
动机：找到回家的站台

[玩家状态]                         ← 来自 state.player
姓名：林舟
生命: 85/100 | 背包: [锈铁刀, 车票]

[本轮引擎事件]                     ← 来自本轮 engineMutations
- 玩家检查了铁门

[任务]
描述本轮发生的事，决定世界如何响应。
返回 <NARRATION> 和 <WORLD_UPDATE>。
```

### DM 返回格式

```xml
<NARRATION>
铁门在你指尖微微颤抖，似乎在另一侧有东西感知到你...
</NARRATION>

<WORLD_UPDATE>
{
  "worldFacts": [
    { "text": "铁门对接触者有感知反应", "tile": "Compartment3" }
  ],
  "plotThreads": [
    { "id": "locked_door", "status": "active", "summary": "铁门有感知，会对接触者反应" }
  ],
  "roomsAdded": [],
  "exitsAdded": [],
  "npcsAdded": []
}
</WORLD_UPDATE>
```

---

## 外部记忆策略

游戏事实**不依赖** AI backend 的内部记忆。Pi backend 可以保留长会话并自动压缩；Codex backend 是 one-shot CLI 调用。为了两者都稳定，`worldFacts`、`plotThreads`、`roomState`、`player.profile` 每轮都从 `state.json` 重注入：

```
backend 内部上下文（可能压缩或不存在）  +  外部记忆（每轮重注入）
───────────────────────────────  +  ─────────────────────────
叙事连续性、情感氛围                  worldFacts（具体事实）
角色关系的"感觉"                      plotThreads（剧情线状态）
DM 的创作风格                          roomState + player.profile
```

两层互补：backend 负责"感觉对"，外部记忆负责"事实准确"。

---

## 世界包格式

```
worlds/{pack-name}/
├── world.json    ← 初始房间、NPC、物品、出生点
└── lore.md       ← 世界观文档，直接注入 Pi system prompt
```

启动时 `--world station-dream` 加载对应世界包，创建新存档。

---

## AI backend 抽象

DM、Interpreter、CharacterGenerator 都通过统一 `AiBackend` 接口调用模型：

```typescript
interface AiBackend {
  createSession(options: AiSessionOptions): Promise<AiSession>;
  ask(options: AiPromptOptions): Promise<string>;
}
```

当前实现：

- `PiBackend`：使用 Pi SDK、Pi auth/model registry、无工具模式；DM 可保留长会话。
- `CodexBackend`：使用本地 Codex CLI，执行 `codex exec --ephemeral --ignore-rules --sandbox read-only --ask-for-approval never`；每次调用只读、临时、不会修改项目文件。

配置方式：

- `AI_BACKEND=pi|codex` 设置默认 backend。
- `DM_BACKEND`、`INTERPRETER_BACKEND`、`CHARACTER_BACKEND` 可按角色覆盖。
- Pi backend 使用 `DM_PROVIDER`/`DM_MODEL` 和 `INTERPRETER_PROVIDER`/`INTERPRETER_MODEL`。
- Codex backend 使用 `CODEX_MODEL` 或角色级 `CODEX_DM_MODEL`、`CODEX_INTERPRETER_MODEL`、`CODEX_CHARACTER_MODEL`；留空则使用 Codex 默认模型。

---

## 角色创建与故事包主角设定

新游戏启动后进入角色创建流程，而不是通过启动参数塞入主角信息。世界包可以提供预设主角列表；用户也可以输入自己的姓名和角色描述，由 AI 按世界观生成候选主角，再从候选中选择。

```json
{
  "defaultProtagonistId": "lost_commuter",
  "protagonists": [
    {
      "id": "lost_commuter",
      "name": "迟归的通勤者",
      "summary": "每天搭乘末班车的人，却忘了自己要回哪里。",
      "background": "你总觉得自己错过了一站，但车票上没有目的地。",
      "motivation": "找回自己真正想回去的地方。",
      "initialStats": { "hp": 100, "attack": 6, "defense": 3 },
      "initialInventory": ["ticket"],
      "openingHook": "你在空白时刻表前醒来，手里攥着一张没有目的地的旧车票。"
    }
  ]
}
```

开局流程：

1. 加载世界包摘要与 `protagonists[]`。
2. 展示故事包预设主角，默认选中 `defaultProtagonistId`。
3. 用户可输入自己的玩家姓名覆盖预设名。
4. 用户也可选择“输入自己的角色描述”，由 AI 生成 2-3 个符合世界观的候选主角。
5. 用户从 AI 候选中再次选择，或返回重新输入描述。
6. 最终主角作为 `state.player.profile` 快照保存，并在每轮 DM prompt 中注入。

存档保存的是创建时的主角快照，而不是只保存 `protagonistId`，这样故事包更新不会改变旧存档。

---

## 世界包校验

`loadWorldPackSummary()` 和 `loadWorldPack()` 都会先校验世界包，避免启动后才在运行时崩溃。校验项包括：

- `bornPoint` 必须指向存在的 room。
- room exits 必须指向存在的 room。
- NPC `roomId` 必须存在。
- item `inRoom` 必须存在。
- `defaultProtagonistId` 必须存在于 `protagonists[]`。
- protagonist id、room id、NPC id、item id、stat key 必须唯一。
- `playerStats`、NPC stats、protagonist `initialStats` 只能使用 schema 中定义的 stat key，或 `{stat}Max` 形式的最大值 override。
- stat 当前值必须落在 `min` 和对应最大值之间；若需要强 NPC，可显式写 `hpMax` / `mpMax` / `sanMax` 等 override。
- protagonist `initialInventory` 只能引用存在的 item id。

---

## 项目目录结构

```
mud-pi/
├── src/
│   ├── types/
│   │   ├── world.ts        # WorldState, RoomDef, NpcDef...
│   │   └── mutations.ts    # EngineMutation, DmMutation, TurnRecord
│   ├── store/
│   │   ├── apply.ts        # applyMutation() — 唯一变更入口
│   │   └── persist.ts      # loadState/saveState/appendTurn
│   ├── engine/
│   │   ├── commands.ts     # verb → EngineMutation[]
│   │   └── world-loader.ts # worlds/*.json → 初始 WorldState
│   ├── ai/
│   │   ├── backend.ts             # AI backend 抽象与路由
│   │   ├── pi-backend.ts          # Pi SDK backend
│   │   ├── codex-backend.ts       # Codex CLI backend
│   │   ├── character-generator.ts # 用户描述 → 主角候选
│   │   ├── interpreter.ts         # 小模型：input → ParsedCommand
│   │   ├── dm-session.ts          # DM 会话封装
│   │   ├── dm-prompt.ts           # state → DM prompt 字符串
│   │   └── dm-parser.ts           # DM 返回 → DmMutation[]
│   └── server/
│       └── telnet.ts       # TCP/Telnet 服务器
├── worlds/
│   └── station-dream/
│       ├── world.json
│       └── lore.md
├── saves/                  # 运行时生成
│   └── {worldId}/
│       ├── state.json
│       └── turns.jsonl
├── docs/
│   └── design.md           # 本文档
└── package.json
```

---

## 一轮完整流程

```
1. 玩家发送文字输入
2. Interpreter（小模型）→ ParsedCommand { verb, args }
3. Engine 根据 verb 执行规则 → EngineMutation[]
4. applyMutations(state, engineMutations)  [先应用引擎变更]
5. buildDmPrompt(state, engineEvents)      [构建本轮 DM prompt]
6. DM（Pi）→ <NARRATION> + <WORLD_UPDATE>
7. parseDmResponse() → DmMutation[]
8. applyMutations(state, dmMutations)      [应用 DM 变更]
9. applyMutation(state, engine/turn_advanced)
10. saveState(state)                       [覆写 state.json]
11. appendTurn(worldId, turnRecord)        [追加 turns.jsonl]
12. 发送 narration 给玩家
```
