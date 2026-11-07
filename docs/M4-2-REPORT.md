# M4-2 报告 · 并发调度内核

> 版本 v1.0 ／ 2026-11-06 ／ 对应原始验收 ①、`docs/M3-HANDOFF.md` §10.3

## 1. 完成了什么（逐条对照）

| 验收条目 | 实现 | 证据 |
|---|---|---|
| **并发上限**（默认 3，可配） | `TaskQueueDeps.concurrency`；`normalizeConcurrency()` 统一夹取 **1..8**（`NaN`/`undefined` → 3，0/-5 → 1，99 → 8，2.9 → 2） | `M4-2 · normalizeConcurrency` 2 例 |
| **自动补位** | FIFO `pending[]` + `pump()`：任务进入终态 → `running.delete()` → `pump()` 立刻取队首补位；`run()` 在第一个 `await` 之前就占槽，循环不可能超发 | 「enqueue 7, never exceeds the limit and eventually completes all 7」：`maxActive=3`、`downloadCalls=7`；「FIFO order」：`t1,t2→t3→t4,t5` |
| **上限 1 严格串行** | `concurrency: 1` 与 M2 行为逐事件一致（M2 的串行用例改为显式传 1，语义不变） | 「concurrency:1 stays strictly serial」`maxActive=1`；`task-queue.test.ts` 原 3 例仍绿 |
| 运行期调整 | `setConcurrency(n)`：调高**立即**启动排队任务；调低**不杀**在跑任务，只停止新启动 | 「raising the limit starts parked tasks immediately」4 槽即刻占满；「lowering… never kills running work」 |
| 队列可观测 | `activeTaskIds` / `pendingCount` / `concurrency` 三个只读视图（IPC 与托盘直接用） | 上述用例均直接断言 |
| 排队任务取消 | `cancel(queued)` 从 FIFO 移除并删除记录，返回 `true`；**不伪造 `Idle→Canceled`**（13 条合法边不含此边） | 「canceling a queued task drops it without touching the matrix」 |
| 删除任务（M4-6 前置） | `remove(id)`：运行中拒绝，终态/排队可删，并持久化快照 | 「remove() refuses a running task and accepts a settled one」 |
| 重复入队 | `enqueue` 先 `dropFromPending`，同一 id 不会在 FIFO 中重复占位 | 「re-enqueueing the same id does not duplicate the FIFO entry」 |

## 2. 验收证据

```text
$ node node_modules/vitest/vitest.mjs run tests/unit/task-queue-concurrency.test.ts tests/unit/task-queue.test.ts
 Test Files  2 passed (2)
      Tests  28 passed (28)

$ npm test
 Test Files  35 passed (35)
      Tests  491 passed (491)
```

- 原始验收 ①：**入队 7 → 同时运行恰 3（峰值 `maxActive=3`）→ 全部自动补位完成**。
- 回归：M2 的 `A-M2-01`（49 组合 + 串行）仍绿；`npm test` 由 464 → **491** 例。

## 3. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/core/src/task-queue/task-queue.ts` | 修改 | 单槽 `runningTaskId` → `running: Set` + `pump()`；新增 `concurrency` / `activeTaskIds` / `pendingCount` / `setConcurrency` / `remove` / `normalizeConcurrency` / `DEFAULT_CONCURRENCY` / `MAX_CONCURRENCY`；`cancel` 支持排队任务 |
| `packages/core/src/task-queue/index.ts` | 修改 | 导出并发常量与归一化函数 |
| `packages/core/src/ports.ts` | 修改（追加） | `ITaskQueue` 增补 5 个成员 |
| `tests/unit/task-queue-concurrency.test.ts` | 新增 | 11 例（含 5 例并发行为、3 例运行期调整） |
| `tests/unit/task-queue.test.ts` | 修改 | 串行用例显式 `concurrency: 1`（保留 A-M2-01 语义） |
| `docs/M4-2-REPORT.md` | 新增 | 本报告 |
| `docs/DECISIONS.md` | 修改 | 追加 D-48 |

## 4. 偏离与风险

- **D-48**：`Idle → Canceled` **不新增**为合法边。排队任务取消 = 从队列移除 + 删除记录（无 `state-changed` 事件）。理由：13 条合法转移是 M2 冻结契约，M4-1 刚用 36 条非法断言钉死；为 UI 方便而扩边会让状态机失去可验证性。UI 侧「取消排队任务」按「移出队列」呈现（M4-6 详情页同样走 `remove`）。
- 风险：`pump()` 依赖「`run()` 同步占槽」这一前提；未来若在 `run()` 首行之前插入 `await`，会出现超发。已在此处留注释，并由 `maxActive` 断言兜底（7 任务 3 槽若超发会立刻 `maxActive>3`）。
- 并发下载对磁盘/网络的实测压测属于 L2/L3，本轮以 L0 假引擎验证调度语义，不声称已做真实多流压测。

## 5. 回归状态

| 项 | 结果 |
|---|---|
| `npm test` | 35 files / **491 passed** / 0 failed |
| `pnpm turbo run typecheck` | 5/5（本块后复跑） |
| M1/M2/M3 acceptance | M3 `48/48 + 12/12 + 4/4`（M4-0 记录）；M4-2 未触碰验收脚本与门控 |

## 6. 下一步

M4-3 · 快照持久化与恢复（`TaskStore` 原子写 + 启动恢复 + 运行中→`Canceled` + 保留上次进度）。
