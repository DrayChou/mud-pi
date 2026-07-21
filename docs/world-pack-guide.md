# 世界包开发指南

世界包是 `mud-pi` 的规则书与冒险模组。它定义开场客观事实、参数、角色、地点、道具、目标、结局边界和可复现规则；Pi DM 负责理解玩家没有被预写的行动，并在这些边界内主持故事。

> 世界包描述“世界里有什么、哪些状态必须权威保存”，不要把它写成要求玩家猜中的命令菜单或固定流程。

## 1. 目录结构

在 `worlds/` 下创建一个稳定的英文 ID：

```text
worlds/my-world/
├── world.json
├── lore.md
└── conflict.ts   # 可选，仅加载可信本地代码
```

启动：

```bash
bun start --world my-world
```

交互式新游戏会自动枚举包含 `world.json` 的目录。非交互环境可以设置：

```env
WORLD_PACK=my-world
```

## 2. 最小世界包

`world.json` 至少需要名称、出生点、参数 schema、房间、NPC 和道具数组：

```json
{
  "name": "雾中灯塔",
  "bornPoint": "HarborRoad",
  "schema": {
    "defs": [
      {
        "key": "hp",
        "label": "生命",
        "min": 0,
        "max": 20,
        "default": 10,
        "display": "bar",
        "thresholds": [
          {
            "operator": "lte",
            "value": 0,
            "effect": { "kind": "set_lifecycle", "value": "dead" }
          }
        ]
      },
      {
        "key": "focus",
        "label": "专注",
        "min": 0,
        "max": 10,
        "default": 5,
        "display": "number"
      }
    ]
  },
  "playerStats": {
    "hp": 10,
    "focus": 5
  },
  "defaultProtagonistId": "night_courier",
  "protagonists": [
    {
      "id": "night_courier",
      "name": "夜班信使",
      "summary": "在封港前送出最后一封信的人。",
      "background": "你沿着海岸公路来到灯塔镇。",
      "motivation": "找到收信人，并弄清港口为何突然封闭。",
      "initialStats": { "hp": 10, "focus": 6 },
      "initialInventory": ["sealed_letter"],
      "openingHook": "灯塔熄灭时，你听见信封里传来敲击声。"
    }
  ],
  "rooms": [
    {
      "id": "HarborRoad",
      "title": "港口公路",
      "desc": "潮湿石路通向一座没有灯光的港镇。",
      "exits": { "north": "OldSquare" },
      "tags": ["start", "outdoor"]
    },
    {
      "id": "OldSquare",
      "title": "旧广场",
      "desc": "紧闭的店铺环绕着一口干涸水井。",
      "exits": { "south": "HarborRoad" }
    }
  ],
  "npcs": [],
  "items": [
    {
      "id": "sealed_letter",
      "name": "封蜡信",
      "desc": "没有署名的厚纸信封，深蓝封蜡上刻着灯塔。",
      "kind": "key",
      "inInventory": true
    }
  ]
}
```

`lore.md` 提供世界背景与主持边界：

```markdown
# 雾中灯塔

这是一个关于失踪、承诺和海上怪光的悬疑故事。

- 镇民知道灯塔昨夜熄灭，但不知道守塔人去了哪里。
- 超自然现象应先通过声音、影子和物理痕迹表现。
- 不替玩家决定是否打开封蜡信。
- 未注册的可携带线索必须在同轮创建为权威物品。
```

## 3. 参数 Schema

参数没有内置 D&D 语义。世界包可以定义生命、理智、士气、信誉或其他数值：

```json
{
  "key": "resolve",
  "label": "意志",
  "description": "承受恐惧与精神压力的能力。",
  "min": 0,
  "max": 12,
  "default": 6,
  "display": "bar"
}
```

`display`：

```text
bar     以进度条展示
number  以数值展示
hidden  不在普通玩家状态中展示
```

生命周期 threshold 示例：

```json
{
  "operator": "lte",
  "value": 0,
  "effect": {
    "kind": "set_lifecycle",
    "value": "incapacitated"
  }
}
```

生命周期值：

```text
active
incapacitated
dead
```

规则：

- `key` 在一个世界包中唯一；
- default 和初始值必须在 min/max 内；
- NPC 或主角需要超过 schema max 时，可显式提供 `hpMax` 这类 `{key}Max`；
- 物品、Condition、冲突脚本引用的 parameterId 必须存在。

## 4. 房间与出口

```json
{
  "id": "LighthouseBase",
  "title": "灯塔底层",
  "desc": "盐水从门缝渗入，旋梯消失在黑暗中。",
  "exits": {
    "south": "CliffPath",
    "up": "LampRoom"
  },
  "tags": ["indoor", "key_location"]
}
```

规则：

- `bornPoint` 必须引用存在的房间；
- 所有静态出口必须引用存在的房间；
- 建议手动声明合理的返回出口；
- `desc` 写可复用的客观环境，不写强制玩家已经做出的选择；
- `tags` 是世界内容数据，Engine 不应硬编码具体故事 tag；
- 新房间和出口也可以由 Pi 在游戏中提出，但必须经过权威操作提交。

方向 key 可以是：

```text
north south east west up down
```

也可以使用世界包自定义字符串，但精确方向快捷命令主要适合常见方向。地点式自然语言导航由 Pi 结合当前地图裁定。

## 5. NPC

普通 DM 控制 NPC：

```json
{
  "id": "harbor_guard",
  "name": "港口守卫",
  "roomId": "OldSquare",
  "personality": "疲惫、警惕，但愿意听取有证据的解释",
  "hostile": false,
  "stats": {
    "hp": 12,
    "focus": 4
  }
}
```

`hostile: false` 只表示 NPC 当前不主动敌对，不代表玩家不能攻击。

### 持久 Pi NPC

只有真正需要独立长期人格、私人记忆和连续判断的重要 NPC 才使用：

```json
{
  "id": "lighthouse_keeper",
  "name": "守塔人",
  "roomId": "LampRoom",
  "personality": "寡言、谨慎、对海雾怀有复杂敬畏",
  "controller": "pi_session",
  "persona": {
    "background": "你独自维护灯塔多年，知道最近怪光的来源，但不信任陌生人。",
    "speechStyle": "短句，常用潮汐和航线作比喻。",
    "goals": ["阻止怪光引导船只触礁", "判断玩家是否值得信任"],
    "constraints": ["不知道自己没有亲历或被告知的远处事件", "不读取玩家内心"]
  },
  "storyRole": {
    "importance": "critical",
    "deathPolicy": "ai_evaluate",
    "notes": "死亡后故事应评估替代线索，而不是自动结束。"
  },
  "hostile": false,
  "stats": {
    "hp": 10,
    "focus": 8
  }
}
```

Controller：

```text
dm          由 DM 统一主持，默认值
pi_session  懒加载独立持久 Session
rule        由确定性规则控制
```

`pi_session` 必须提供 `persona`。不要给背景路人批量创建独立 Session。

## 6. 道具

### 场景物品

```json
{
  "id": "rusted_key",
  "name": "锈蚀钥匙",
  "desc": "齿纹间塞满干燥的海盐。",
  "kind": "key",
  "inRoom": "OldSquare"
}
```

### 初始背包物品

```json
{
  "id": "sealed_letter",
  "name": "封蜡信",
  "desc": "尚未拆开的信。",
  "kind": "key",
  "inInventory": true
}
```

主角仍应通过 `initialInventory` 明确引用自己的初始物品。加载时会把选择主角的初始背包放入玩家 inventory。

### 装备

```json
{
  "id": "oilskin_coat",
  "name": "油布外套",
  "desc": "厚重但防风。",
  "kind": "equipment",
  "equipSlot": "body",
  "parameterModifiers": [
    { "parameterId": "focus", "operation": "add", "value": 1 }
  ],
  "inRoom": "HarborRoad"
}
```

Modifier：

```text
add   加法修正
rate  倍率修正；必须大于 0
```

### 消耗品

```json
{
  "id": "hot_tea",
  "name": "热茶",
  "desc": "带着烟熏和薄荷气味。",
  "kind": "item",
  "consumable": true,
  "effects": [
    {
      "code": "recover_parameter",
      "parameterId": "focus",
      "value": 1,
      "dice": { "count": 1, "sides": 4 }
    }
  ],
  "inRoom": "OldSquare"
}
```

常用 effect code 由世界脚本解释；公开示例主要使用：

```text
recover_parameter
parameter_delta
```

物品引用的参数必须在 schema 中声明。权威随机必须来自 Engine 提供的确定性 seed，不使用 `Math.random()`。

### Scenery 兼容类型

`kind: "scenery"` 或不可携带陈设可以用于检查，但不要把门、楼梯和家具误当作普通背包物品。当前开放式场景交互优先交给 Pi 裁定；只有跨回合需要查询的状态才应结构化。

## 7. Condition

Condition 是世界定义的跨回合状态容器，Engine 不硬编码“中毒”“恐惧”等语义：

```json
{
  "conditions": [
    {
      "id": "salt_chill",
      "label": "盐雾寒意",
      "description": "湿冷暂时影响专注。",
      "stacking": "refresh",
      "maxStacks": 1,
      "defaultDurationTurns": 3,
      "parameterModifiers": [
        { "parameterId": "focus", "operation": "add", "value": -1 }
      ],
      "traits": [
        { "code": "coast.cold_sensitive", "value": 1 }
      ]
    }
  ]
}
```

Stacking：

```text
replace  重新应用时替换
refresh  刷新持续时间
stack    增加 stacks，受 maxStacks 限制
```

一次性疼痛、气味或印象不需要做成 Condition。

## 8. Objective

确定性目标：

```json
{
  "objectives": [
    {
      "id": "reach_lighthouse",
      "title": "抵达灯塔",
      "description": "沿海崖路找到熄灭的灯塔。",
      "completion": {
        "kind": "visit_room",
        "roomId": "LighthouseBase"
      }
    },
    {
      "id": "meet_keeper",
      "title": "找到守塔人",
      "description": "了解灯塔熄灭前发生的事。",
      "requires": ["reach_lighthouse"],
      "completion": {
        "kind": "talk_to_npc",
        "npcId": "lighthouse_keeper"
      }
    }
  ]
}
```

Completion 类型：

```text
visit_room
talk_to_npc
acquire_item
defeat_entity
```

开放式任务可以设置：

```json
"gmCompletionAllowed": true
```

这只允许 Pi 提议完成；Engine 仍校验 objective ID、前置条件、状态和 revision。Objective 是里程碑，不应被用来强制唯一流程。

## 9. StoryOutcome

```json
{
  "outcomes": [
    {
      "id": "beacon_restored",
      "type": "success",
      "title": "灯火重燃",
      "summary": "灯塔重新为海上的船只指明航线。",
      "criteria": "灯塔光源已被权威恢复，港口主要威胁已经解除，且玩家没有死亡。",
      "terminal": true
    },
    {
      "id": "lost_to_the_fog",
      "type": "failure",
      "title": "雾中失踪",
      "summary": "玩家成为下一位没有归港的人。",
      "criteria": "玩家已经死亡，或明确进入不可返回的雾区且没有任何成立的撤离路径。",
      "terminal": true
    }
  ]
}
```

Outcome type：

```text
success
failure
death
transformation
abandonment
softlock
custom
```

`criteria` 是给 Pi 的世界包判定契约，不是自动执行的任意代码。Pi 只能提出世界包已声明的 Outcome，Engine 校验 ID、回合和是否已经到达结果。

不要仅凭乐观或悲观文风宣告结局。criteria 应尽量引用可验证的：

```text
物品位置
NPC lifecycle
Objective 状态
房间位置
已提交事实
玩家明确表达
```

## 10. AI 判定奖励

先声明模板：

```json
{
  "itemRewardRules": {
    "maxGrantedPerTurn": 1,
    "templates": [
      {
        "id": "warming_draught",
        "label": "保暖饮剂",
        "guidance": "只在获得明显信任、完成救援或合理交换后发放。",
        "kind": "item",
        "consumable": true,
        "effects": [
          {
            "code": "recover_parameter",
            "parameterId": "focus",
            "value": 1,
            "dice": { "count": 1, "sides": 4 }
          }
        ],
        "cooldownTurns": 3,
        "maxPerGrantor": 1
      }
    ]
  }
}
```

再由 Objective 开放奖励资格：

```json
{
  "id": "help_keeper",
  "title": "协助守塔人",
  "description": "用玩家选择的方法解决眼前危机。",
  "gmCompletionAllowed": true,
  "completion": {
    "kind": "talk_to_npc",
    "npcId": "lighthouse_keeper"
  },
  "reward": {
    "mode": "ai_judged",
    "guidance": "完成目标不保证奖励；依据实际帮助、信任或交换判断。",
    "allowedTemplateIds": ["warming_draught"],
    "eligibleGrantorNpcIds": ["lighthouse_keeper"],
    "maxAwards": 1
  }
}
```

AI 只决定是否奖励，以及创作名称、描述和别名。机械效果来自世界包模板。Engine 校验目标状态、模板、赠予者位置、冷却和次数。

详细契约见 [`ai-item-rewards.md`](ai-item-rewards.md)。

## 11. 冲突规则

### 不使用数值冲突

```json
{
  "conflictRules": { "mode": "none" }
}
```

### 骰子检定

```json
{
  "conflictRules": {
    "mode": "dice_check",
    "dice": { "count": 2, "sides": 6 },
    "criticalSuccess": "all_max",
    "criticalFailure": "all_min"
  }
}
```

### 自动冲突

```json
{
  "conflictRules": {
    "mode": "auto_combat",
    "algorithm": "gauge-random-v1",
    "parameters": {
      "pool": "hp",
      "attack": "attack",
      "defense": "defense",
      "speed": "speed",
      "luck": "luck",
      "accuracy": "accuracy"
    }
  },
  "conflictScript": "./conflict.ts"
}
```

最小 `conflict.ts`：

```ts
import { simulateCombat } from "../../src/engine/combat.ts";
import { defaultConflictResolver, type ConflictResolver } from "../../src/engine/conflict-script.ts";

export const conflictResolver: ConflictResolver = {
  id: "my-world-conflict",
  version: 1,
  resolve(context) {
    if (context.rules.mode !== "auto_combat") {
      throw new Error("my-world expects auto combat rules");
    }
    return simulateCombat(
      context.schema,
      context.actor,
      context.target,
      context.rules,
      context.seed
    );
  },
  useItem: defaultConflictResolver.useItem,
};
```

安全边界：

- `conflictScript` 必须是世界包目录内的安全 `./` 路径；
- 脚本必须返回受验证的结构化结果；
- 脚本不能直接修改 `WorldState`；
- 当前只应加载可信本地脚本；
- 权威随机必须使用 context seed。

更多背景见 [`conflict-resolution-research.md`](conflict-resolution-research.md)。

## 12. 程序化地图

当前内置生成器：

```text
seeded-mst-v1
```

示例：

```json
{
  "proceduralMap": {
    "generator": "seeded-mst-v1",
    "totalRooms": { "min": 8, "max": 12 },
    "loopChance": 0.15,
    "attachTo": "HarborRoad",
    "templates": [
      {
        "title": "雾中仓库 {n}",
        "desc": "木箱在潮湿地面上留下拖动痕迹。",
        "tags": ["warehouse", "fog"]
      }
    ]
  }
}
```

规则：

- `attachTo` 必须是静态房间；
- min 不得小于静态房间数量；
- max 不得小于 min，且不超过 64；
- `loopChance` 在 0–1；
- 相同 seed 和版本产生相同地图。

启动时传入 seed：

```bash
bun start --world my-world --seed lighthouse-001
```

## 13. 校验与测试

启动世界包时 Loader 会自动校验。开发时运行：

```bash
bun run typecheck
bun test src/engine/world-validator.test.ts
bun test
```

公开内置世界包会被 `world-validator.test.ts` 全部枚举和加载。

常见错误：

```text
bornPoint 指向不存在的房间
出口指向不存在的房间
NPC 位于不存在的房间
主角初始背包引用不存在的物品
Objective 引用不存在的 Room/NPC/Item
参数 modifier/effect 引用不存在的 parameter
pi_session NPC 缺少 persona
equipment 缺少 equipSlot
conflictScript 使用 ../ 逃逸世界包目录
Outcome 缺少 criteria 或 terminal
```

建议为复杂世界包增加专用测试，至少覆盖：

- 世界包可加载；
- 所有预设主角可创建；
- 关键 Objective 的依赖顺序；
- StoryOutcome ID 与 criteria；
- 冲突脚本确定性；
- 关键道具可拾取、装备或使用；
- Journal replay 后状态一致。

## 14. 内容设计边界

### 应进入权威状态

- 玩家/NPC 的位置和生命周期；
- 可拾取、装备、交付、消耗或销毁的物品；
- 已开放出口；
- 参数和跨回合 Condition；
- Objective 与 StoryOutcome；
- 后续规则必须引用的事实。

### 可以只留在叙述

- 一次性的气味、光线和环境印象；
- 不影响后续规则的微小动作；
- NPC 当下的语气和停顿；
- 玩家没有要求携带的普通背景陈设；
- 不需要跨回合查询的短暂后果。

### 不应写进通用 Engine

- 特定角色名、地点名和世界观术语；
- 某个故事唯一的婚礼、仪式或密码流程；
- 特定作品的技能和法术枚举；
- 要求玩家依次触发的硬编码剧情阶段；
- 只在一个世界出现的专用动作命令。

如果一个开放动作可以由 Pi 根据当前 fiction 裁定，就优先复用现有桌面操作，而不是增加专用 verb。

## 15. 提交世界包前检查

```bash
bun run typecheck
bun test
git diff --check
```

人工检查：

- 所有可交互人物已注册为 NPC；
- 所有可携带线索已注册为 Item；
- 叙述不会声称尚未提交的位置、出口、死亡或结局；
- `hostile: false` 没有被误解为不可攻击；
- 关键 NPC 死亡后有合理继续或失败边界；
- Outcome criteria 可由 committed state 支持；
- lore 是事实与主题边界，不是固定命令列表；
- 没有 API key、真实用户数据、绝对本地路径或运行存档。
