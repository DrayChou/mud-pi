# AI 判定的 NPC / 任务道具奖励

## 目标

任何有 AI 决策能力的 NPC 都可以根据自己亲历的事件、任务完成状态、身份、动机、信任和交换关系，判断是否应向玩家发放奖励。DM 也可以代表普通 NPC 或任务结算提出奖励。

AI 只决定：

- 是否发放；
- 选择哪个世界奖励模板；
- 世界观名称；
- 描述、别名和交付台词。

AI 不能决定：

- 任意属性 ID；
- 任意数值修正；
- 任意骰子；
- 装备槽；
- traits/effects 的实际机械规则；
- 绕过冷却、次数和位置限制。

## 世界包模板

世界包通过 `itemRewardRules` 声明允许的奖励：

```json
{
  "itemRewardRules": {
    "maxGrantedPerTurn": 2,
    "templates": [
      {
        "id": "minor_healing_draught",
        "label": "次级治疗饮剂",
        "guidance": "适合作为救助、委托完成或合理交易的奖励。",
        "kind": "item",
        "effects": [
          {
            "code": "recover_parameter",
            "parameterId": "hp",
            "value": 2,
            "dice": { "count": 2, "sides": 4 }
          }
        ],
        "consumable": true,
        "cooldownTurns": 3,
        "maxPerGrantor": 2
      }
    ]
  }
}
```

模板由 World Validator 校验，并随新游戏或旧存档恢复加载。

## NPC 意图

独立 NPC 可以返回：

```json
{
  "thought": "玩家确实完成了我关心的事",
  "action": {
    "verb": "give_item",
    "content": "这是你应得的。",
    "templateId": "minor_healing_draught",
    "itemId": "blacksmith_draught_turn_8",
    "name": "铁匠的暖炉药酒",
    "desc": "粗陶瓶仍带着炉火余温。",
    "aliases": ["药酒"]
  }
}
```

`executeNpcDecision()` 会再次检查：

- NPC 存活；
- 决策回合未过期；
- NPC 位置未变化；
- 房间可见实体未变化；
- 玩家与 NPC 同房间；
- 模板存在；
- item ID 合法且唯一；
- 本回合奖励预算；
- 模板冷却；
- 单赠予者发放上限。

## DM 奖励

DM 使用 `itemsAdded`：

```json
{
  "id": "clerk_tea_turn_5",
  "name": "温热的站务茶",
  "desc": "纸杯上印着已经停运的线路。",
  "placement": "inventory",
  "rewardTemplateId": "small_recovery",
  "grantedByNpcId": "ticket_clerk"
}
```

任何 `placement: "inventory"` 都必须提供 `rewardTemplateId`。没有模板的直接背包注入会被解析层拒绝。普通 AI 场景物品仍使用 `placement: "room"`。

## 权威生成

`decideItemRewardGrant()` 根据模板生成最终 `ItemDef`。AI 输出中即使附带自定义 `parameterModifiers`、traits 或 effects，也不会覆盖模板。

最终道具记录：

```ts
{
  location: { kind: "inventory", ownerId: player.id },
  rewardTemplateId: template.id,
  grantedByEntityId: npc.id,
  createdTurn: state.turn
}
```

并产生：

```text
item_created
item_granted
```

奖励消耗品可以通过 `use` 交给世界脚本解释；奖励装备可以通过 `equip` 装入模板声明的槽位。

## 任务时序

玩家行动产生的 Objective 会在唤醒 NPC 前先结算，因此 NPC 在同一轮 Prompt 中可以看到刚完成的目标，并自行判断是否奖励。Objective 仍只负责确定性完成，不硬编码必掉奖励。

```text
玩家行动
→ Engine Events
→ Objective 结算
→ NPC 看到最新目标和已结算事件
→ NPC 可选择 give_item
→ Engine 奖励判定
→ 道具进入背包
→ GameEvent / DM / UI
```

这保持了“任务进度是权威事实、奖励是否合理由 AI 判断、奖励机械规则由世界包控制”的三层边界。
