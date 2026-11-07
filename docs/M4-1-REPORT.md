# M4-1 报告 · 7 态状态机

> 版本 v1.0 ／ 2026-11-06 ／ 对应原始验收 ⑤、`docs/M3-HANDOFF.md` §10.2

## 1. 完成了什么（逐条对照）

| 验收条目 | 实现 | 证据 |
|---|---|---|
| 七态齐全：`Idle / FetchingInfo / ReadyWithInfo / Running / Completed / Error / Canceled` | `TASK_STATES` 固定 7 项、顺序不变（M2 已建立，本轮**不改签名**） | `state-machine-m4.test.ts`「exposes exactly the 7 documented states in order」 |
| 合法转移矩阵**全覆盖** | 13 条合法边 + `transitionMatrix()` 7×7 布尔矩阵；`legalTargets()` 与矩阵行逐一相等 | 「transitionMatrix() has 13 true cells and 36 false cells」 |
| **非法转移逐条拒绝** | 36 条非法边逐条 `assertTransition` → `IllegalTaskTransitionError`（含 `from` / `to` / `message`），7 条自环单独覆盖 | 「every one of the 36 illegal pairs is rejected individually」+「self-loops are illegal for all 7 states」 |
| **优先级按状态 ordinal** | 新增 `STATE_ORDINAL`（0…6 唯一）、`statePriority()`、`compareStatePriority()`；`sort(compareStatePriority)` 得到固定顺序 | 「pins the 7 ordinals to unique 0…6 values」+「sorting by priority is stable and total」 |
| 终态与重启语义 | `Completed` 零出边；`isSettled` = Completed/Error/Canceled；`isRestartable` = Error/Canceled 且各自存在合法重启边 | 「Completed is terminal」「isRestartable is the subset…」 |
| UI 可用的稳定标签键 | `stateLabelKey()` → `task.state.<State>`（core 不带显示文案，留给 M5 i18n） | 「every state has a deterministic i18n key」 |

> 实现是**追加（append-only）**：`canTransition` / `assertTransition` / `isTerminal` / `isRestartable` / `allTransitions` 签名与语义一字未改，M2 的 `A-M2-01` 仍然独立成立。

## 2. 验收证据

```text
$ node node_modules/vitest/vitest.mjs run tests/unit/state-machine-m4.test.ts
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

覆盖分布：
- 七态与 13 条合法边：3 例；
- 49 组合矩阵 / 36 条非法逐条 / 自环：4 例；
- ordinal 优先级（含 49 组反对称性）：3 例；
- 谓词与标签键：4 例；
- 终态与重启语义：1 例。

## 3. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/core/src/task-queue/state-machine.ts` | 修改（追加） | `STATE_ORDINAL` / `statePriority` / `compareStatePriority` / `legalTargets` / `transitionMatrix` / `isActive` / `isSettled` / `stateLabelKey` |
| `tests/unit/state-machine-m4.test.ts` | 新增 | 15 例，手写期望矩阵（不引用实现常量） |
| `docs/M4-1-REPORT.md` | 新增 | 本报告 |
| `docs/DECISIONS.md` | 修改 | 追加 D-47 |

## 4. 偏离与风险

- **D-47**：`STATE_ORDINAL` 把 `Error`(5) / `Canceled`(6) 排在 `Completed`(4) 之后。理由：ordinal 表达的是「列表/托盘的展示优先级」，失败与取消需要排在完成之上以吸引注意；**它不是状态机拓扑顺序**，不影响任何转移合法性。
- 风险：ordinal 一旦被 UI 排序依赖即不可重排；已用 15 条断言钉死数值。

## 5. 回归状态

- `pnpm turbo run typecheck` → **5/5 successful**。
- M2 的 `A-M2-01`（49 组合走查 + 串行队列）未改动，仍全绿（M4-2 会显式传 `concurrency:1` 保住串行断言）。
- M3 验收不受影响（`48/48 + 12/12 + 4/4`，见 M4-0 记录）。

## 6. 下一步

M4-2 · 并发调度内核（`task-queue.ts` 并发上限 + 自动补位 + 上限 1 严格串行）。
