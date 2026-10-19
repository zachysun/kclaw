# ADR-0004：不给模型提供 goal 工具（循环控制全在 daemon 侧）

状态：已取代（2026-10-19 起模型侧三件工具，见文末更新）

## 背景

目标循环有一组控制动作：设目标、查状态、暂停/恢复/停止、报告完成。这些动作可以做成工具暴露给干活模型（模型自己 `goal_complete` / `goal_pause`），也可以完全收在 daemon 侧（REST 路由 + `/goal` 命令，模型侧一个工具都没有）。

## 决策

**模型侧零 goal 工具**。全部控制面是人类入口：REST 路由族（`/sessions/:id/goal` 一族）、CLI `/goal` 命令、WebUI 目标面板。模型对循环的全部感知是注入的用户文本（`<goal-start>` / `<goal-continue round=N>` / `<goal-wrapup>` 标签 + 判定意见 + 验收输出）与消息上的 `note(kind:"goal")` 出处行；模型影响循环的唯一方式是把活干到验收命令通过（然后判定器裁决，见 [ADR-0003](./0003-goal-judging-at-run-boundary.md)）。

## 理由

1. **控制权是用户的**：暂停/停止/改写目标是对"花多少钱、跑多久"的决策，交给模型等于把 budget 阀门交给被评判的一方。自报完成工具尤其危险——它直接绕过独立判定。
2. **注入已够用**：判定意见、验收输出、剩余约束都在续跑注入里，模型不需要额外工具获得信息。
3. **工具清单干净**：不注册工具就不进清单、不占 system 提示词、不参与权限判定，子会话/普通会话无差别。

## 后果

- 模型不能主动"认输"提前终态；它的出路是在回复里说明不可达，判定器读到证据后判 `impossible`。
- goal 循环与权限系统解耦：不新增任何工具权限项，权限文档零改动。
- 未来若出现真实用例（如模型请求延长 budget），再按"第二个真实用例才引入抽象"的原则单独评估。

## 更新（2026-10-19）：模型侧 goal 工具已引入（三件，照抄行业集合）

Master 2026-10-18 定案否决本 ADR 的"零工具"决策：goal 控制交给模型，工具集合与两家对标实现同形——`create_goal`（sensitive）、`get_goal`（safe）、`update_goal`（sensitive；动作 complete/pause/resume/stop）。三条硬约束（见 [ADR-0003](./0003-goal-judging-at-run-boundary.md) 与 [ADR-0002](./0002-goal-armed-is-process-local.md)，均不动摇）：

1. `create_goal`/`update_goal` 恒 sensitive：审批卡就是"用户明说"的机制化——模型不经 prompting 不得启动或操控花费循环。
2. `update_goal action=complete` 只请求立即判定，不写终态：判定器独立裁决 met/not_met/impossible（对比的两家让模型自证完成，本仓库明确拒绝）。
3. armed 仍进程内（ADR-0002）；工具只是既有 host 路径的投影，goal 引擎零改动。

原"零工具"时期的其余论证（注入已够用、工具清单干净）对 get_goal 一类只读工具不再适用；控制权与 budget 仍归用户的原则由 sensitive 档承接。
