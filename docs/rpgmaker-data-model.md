# RPG Maker 式参数、装备与道具数据模型

## 参考结论

RPG Maker MZ 将角色数据拆为基础参数、附加参数、倍率、traits、装备槽和物品 effects，而不是让每个物品直接改写角色基础数据库。

- Battler 维护独立的 `_paramPlus` 附加值；有效基础值先计算 `paramBase + paramPlus`：[`rmmz_objects.js#L2636-L2638`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_objects.js#L2636-L2638)、[`#L2831-L2841`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_objects.js#L2831-L2841)
- Actor 的装备参数会叠加到 `paramPlus`，但不会改写职业或角色的基础参数：[`rmmz_objects.js#L4458-L4469`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_objects.js#L4458-L4469)
- Actor 的 traits 来自状态、角色、职业和全部装备对象的聚合：[`rmmz_objects.js#L2796-L2816`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_objects.js#L2796-L2816)、[`#L4431-L4439`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_objects.js#L4431-L4439)
- 装备使用由数据库定义的槽位，并要求物品装备类型与槽位匹配：[`rmmz_objects.js#L4191-L4204`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_objects.js#L4191-L4204)、[`#L4238-L4252`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_objects.js#L4238-L4252)
- 消耗品 effects 是数据列表，再由统一 action 层分派恢复参数、状态、buff、成长等效果：[`rmmz_objects.js#L2040-L2081`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_objects.js#L2040-L2081)

mud-pi 借鉴的是数据分层，不复制 RPG Maker 固定的 MHP/ATK/DEF 八参数含义。

## mud-pi 参数原则

- 参数 ID、数量、名称和描述由世界包定义。
- Engine 将参数视为 `Record<string, number>`，不应依赖 `hp/attack/luck` 等名字。
- 基础参数保存在实体上；装备只提供 `parameterModifiers`，不永久改写基础参数。
- 有效值按“基础值 + add 修正，再乘 rate 修正”派生。
- UI、DM Prompt、GMCP 和冲突脚本读取有效值。
- 存档保存基础值和装备关系；有效值可随时重算。

## 道具数据

```ts
interface ItemDef {
  kind?: "item" | "equipment" | "key" | "scenery";
  equipSlot?: string;
  parameterModifiers?: ParameterModifier[];
  traits?: DataTrait[];
  effects?: ItemEffect[];
}
```

### 参数修正

```json
{
  "parameterId": "strength",
  "operation": "add",
  "value": 2
}
```

```json
{
  "parameterId": "health",
  "operation": "rate",
  "value": 1.1
}
```

### Trait

Trait 是世界包脚本解释的通用元数据：

```json
{
  "code": "damage_dice",
  "dataId": "1d6",
  "value": 1
}
```

Engine 不硬编码 `damage_dice` 的含义；D&D 世界的冲突脚本可以使用它，其他世界可以忽略。

### Effect

```json
{
  "code": "recover_parameter",
  "parameterId": "hp",
  "value": 2,
  "dice": { "count": 2, "sides": 4 }
}
```

Effect 是使用物品时提交给世界规则脚本的声明，不应由 DM 直接修改状态。

## 后续迁移

当前已完成装备槽、参数修正、traits/effects、有效参数派生，以及第二阶段的参数语义解耦：

- `StatDef` 已删除战斗 `role` 和 `onDeplete`；
- 生命周期改由参数自身声明的通用 `thresholds` 驱动；
- 冲突参数绑定保存在每个世界包的 `conflictRules.parameters`，Engine 不再按属性名称或 role 猜测；
- UI、Prompt 和状态命令展示全部世界包可见参数，不再只找所谓 pool。

世界包冲突脚本阶段也已完成：

- 每个内置世界都有自己的 `worlds/{pack}/conflict.ts`；
- `world.json` 通过 `conflictScript: "./conflict.ts"` 指定脚本；
- 未声明时使用本地 `defaultConflictResolver`；
- 脚本只收到结构化克隆的 Schema、actor、target、规则、options 和 seed；
- Engine 校验脚本返回的实体 ID、有限数值、非负结果和展示帧上限，再生成 Mutation；
- 脚本路径必须是世界目录内的 `./` 相对路径，不能使用 `../` 或远程 URL。

道具使用和 trait 聚合阶段也已完成：

- `use <物品>` 将物品、有效参数、聚合 traits、seed 和 options 交给世界脚本的 `useItem()`；
- 世界脚本返回参数 delta 和是否消耗，Engine 校验参数 ID 与有限数值后转换为 Mutation；
- 消耗品产生 `engine/item_consumed` 和 `item_consumed` GameEvent；
- 角色自身 traits 与全部装备 traits 由 `effectivePlayerTraits()` 聚合后传给世界脚本；
- D&D 治愈药水已使用 2d4+2 世界脚本 effect，并在使用后销毁。

后续独立任务：

1. 用通用 `conflict_result` 替换目前偏战斗语义的输出类型；
2. 将共享的 gauge helper 降级为可选规则库，由各世界自由替换为 d20、2d6 或完全自定义结果；
3. 如需加载第三方不可信世界包，将脚本迁移到受限 Worker/子进程沙箱。
