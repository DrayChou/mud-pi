# mud-pi

AI 驱动的文字 MUD 引擎。世界观只提供开场设定，地图、剧情、NPC 由 DM（Pi AI）在游戏中动态生成。

## 项目地址

- GitHub: <https://github.com/DrayChou/mud-pi>

## 前置条件

使用本项目之前，用户需要先安装并配置好 [Pi](https://pi.dev)，并在 Pi 里完成大模型 provider 的登录或 API key 配置。本项目不会提交、保存或要求你把密钥写进仓库；这里只读取 Pi 已经配置好的模型能力。

### 1. 安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

也可以参考 Bun 官方文档：<https://bun.sh/docs/installation>

### 2. 安装 Pi（官方方式）

Pi 官方 README 当前推荐的 npm 安装方式：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

官方安装脚本方式：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

更多说明见 Pi 官网和官方文档：

- <https://pi.dev>
- <https://www.npmjs.com/package/@earendil-works/pi-coding-agent>

### 3. 配置 Pi 的大模型访问

先打开 Pi 并完成登录或 API key 配置：

```bash
pi
```

在 Pi 里可以使用：

```text
/login   # 选择 provider 并登录
/model   # 查看或切换模型
```

也可以通过环境变量/API key 使用 Pi 支持的 provider。模型列表和自定义 provider 配置请参考 Pi 官方文档中的 Providers & Models / Custom Models。

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 复制配置模板
cp .env.example .env

# 3. 编辑 .env：只需要配置要使用的大模型和小模型名称
#    大模型负责 DM 叙事与世界推进；小模型负责玩家指令解析。

# 4. 启动
bun start
```

开发模式：

```bash
bun run dev
```

启动选项：

```bash
bun start --world station-dream   # 指定世界包
bun start --name 旅行者            # 指定玩家名
bun start --save station-dream-001 # 读取存档
```

## 配置说明（.env）

本项目通过 Pi SDK 调用模型。请先在 Pi 中完成 provider 登录或模型配置，然后在 `.env` 里填写要使用的 provider/model 名称即可。

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DM_PROVIDER` | DM 大模型 provider | `openai-proxy` |
| `DM_MODEL` | DM 大模型名称，负责叙事和世界推进 | `claude-sonnet-4.6` |
| `INTERPRETER_PROVIDER` | 指令解析小模型 provider | `openai-proxy` |
| `INTERPRETER_MODEL` | 指令解析小模型名称，负责把玩家输入解析为结构化命令 | `gpt-5.4-mini` |
| `DM_THINKING` | DM 思考深度：off/minimal/low/medium/high | `low` |
| `WORLD_PACK` | 默认世界包 | `station-dream` |
| `DEFAULT_PLAYER_NAME` | 默认玩家名 | `旅行者` |

> 提示：可先运行 `pi`，再用 `/model` 查看当前账号可用的 provider 和 model id。`.env` 应保留在本地，不要提交。

## 隐私与安全

- `.env`、本地存档 `saves/`、`node_modules/` 等已在 `.gitignore` 中排除。
- 不要把 API key、OAuth token、cookie、私钥或本地 Pi 登录态提交到仓库。
- Pi 的认证信息通常保存在用户本机的 Pi 配置目录中，本项目只通过 Pi SDK 读取可用模型，不把认证信息写入项目文件。
- 游戏存档可能包含玩家输入、生成剧情和测试内容，默认不提交。

## 游戏指令

```text
look [目标]   查看周围或物品
go <方向>     移动（东/西/南/北）
say <内容>    说话（DM 会让 NPC 响应）
get <物品>    拾取
drop <物品>   丢弃
equip <物品>  装备
attack <目标> 攻击
inv           查看背包
status        查看状态
help          显示帮助
quit          保存并退出
```

## 存档

每局游戏自动保存在本地 `saves/{worldId}/`：

- `state.json` — 当前世界快照
- `turns.jsonl` — 完整轮次日志（追加写入，不修改）

`saves/` 是本地运行数据，默认不提交。

## 添加世界包

在 `worlds/` 下新建目录：

```text
worlds/my-world/
├── world.json   # 初始房间、NPC、物品
└── lore.md      # 世界观（注入给 DM）
```

然后启动：

```bash
bun start --world my-world
```

## 项目结构

```text
src/
├── types/
│   ├── world.ts        # WorldState 数据结构
│   └── mutations.ts    # EngineMutation + DmMutation（所有变更类型）
├── store/
│   ├── apply.ts        # applyMutation() — 唯一变更入口
│   └── persist.ts      # state.json + turns.jsonl 读写
├── engine/
│   ├── commands.ts     # 指令 → EngineMutation[]
│   └── world-loader.ts # 世界包加载
├── ai/
│   ├── interpreter.ts  # 小模型：文本 → ParsedCommand
│   ├── dm-session.ts   # Pi SDK DM 会话
│   ├── dm-prompt.ts    # 构建每轮 DM prompt
│   └── dm-parser.ts    # DM 返回 → DmMutation[]
└── main.ts             # CLI 入口
```

## 下一步开发计划

### 1. 可选 Codex CLI backend

当前版本默认使用 Pi SDK 作为 AI backend。后续计划增加可选的 Codex CLI backend：当用户本地已经安装并登录 Codex 时，可以用 `codex exec` 执行 DM 叙事或指令解析。

设计方向：

- 抽象统一的 `AiBackend` 接口，让 DM 和 Interpreter 不直接绑定 Pi SDK。
- 保留 Pi 为默认 backend，Codex 作为可选 backend。
- Codex 运行时使用非交互模式，例如 `codex exec --ephemeral --sandbox read-only --ask-for-approval never`。
- 指令解析优先使用结构化输出能力，确保仍返回稳定 JSON。
- 文档和配置中明确区分 Pi 模型名与 Codex 模型名，避免混用。

暂不在初始版本启用 Codex，原因是 Codex CLI 是 agent 形态，不是纯 LLM SDK；需要额外验证启动延迟、输出稳定性、sandbox 行为和本地配置影响。

### 2. 世界包主角信息 / 预设主角列表

当前版本只使用 `DEFAULT_PLAYER_NAME` 创建玩家。后续计划让每个故事包提供主角设定，以便 DM 叙事更符合角色背景。

推荐的世界包扩展方向：

```json
{
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

计划支持三种开局方式：

1. `--protagonist <id>`：用户直接选择故事包内的预设主角。
2. 未指定时展示备选主角列表，让用户手动选择。
3. 可选问答模式：用户回答 2-4 个问题，由 AI 推荐一个预设主角或生成轻量变体。

主角信息应注入 DM prompt，使叙事能够稳定参考角色背景、动机、初始物品和开场钩子。存档中应保存最终选定的主角快照，避免故事包后续更新影响旧存档。

## 开发命令

```bash
bun install       # 安装依赖
bun run dev       # watch 模式启动
bun start         # 启动游戏
bun run typecheck # TypeScript 类型检查
```
