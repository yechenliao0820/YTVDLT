# M4-3 报告 · 快照持久化与恢复

> 版本 v1.0 ／ 2026-11-06 ／ 对应原始验收 ②、`docs/M3-HANDOFF.md` §10.4

## 1. 完成了什么（逐条对照）

| 验收条目 | 实现 | 证据 |
|---|---|---|
| **原子写快照** | `TaskStore.save()` → `ports.fs.writeTextAtomic()`（tmp+rename），`<configDir>/tasks.json`；损坏/缺失 → 空快照回退，不抛异常 | `task-store.test.ts` 既有 4 例仍绿 |
| **下载中也要有快照**（本轮补的真空洞） | M2 只在任务**结束时**持久化，强杀会丢掉整条任务。新增按时间节流的进度持久化（默认 500 ms，`persistIntervalMs:0` 可每事件写） | `M4-3 · mid-download snapshot`：Running 状态下文件里已有 37% |
| **启动恢复** | `restoreTasks(queue, store)` = `load → countInterrupted → recover → queue.restore`；返回 `{restored, interrupted, skipped, empty}` | `restore after a hard kill`：5 条任务全部回来，`interrupted=2` |
| **运行中/解析中 → `Canceled`** | `TaskStore.recover()` 原规则不变；`TaskQueue.restore()` **再防御一次**（调用方忘了 recover 也不会把 `Running` 带进内存） | `restores every task…` + 持久化回写断言 |
| **保留上次进度** | `lastPercent` / `mediaInfo` / `request` / `artifacts` 全保留；`updatedAt` 刷新 | `lastPercent=42`、`mediaInfo.id='fixture'` |
| **可重试** | 恢复后的 `Canceled` 直接 `restart()`：有 `mediaInfo` 走 `ReadyWithInfo→Running`（不重新 probe），无则 `Idle→FetchingInfo` | 「a restored Canceled task is retryable and completes」：`probeCalls=0` |
| **启动不自动下载** | `restore()` 不调用 `pump()`，恢复的任务**不占槽、不自动开始** | `downloadCalls=0`、`activeTaskIds=[]` |
| **生产接线** | `apps/desktop/src/main/task-host.ts`：ConfigStore 读 `general.concurrency`（1..8 夹取）→ TaskStore → TaskQueue → restoreTasks | `task-host.test.ts` 5 例（默认 3 / 配置 5 / 0→1 / 99→8 / 覆盖优先） |

## 2. 验收证据

```text
$ node node_modules/vitest/vitest.mjs run tests/unit/task-recovery.test.ts tests/unit/task-host.test.ts
 Test Files  2 passed (2)
      Tests  12 passed (12)

$ npm test
 Test Files  37 passed (37)
      Tests  503 passed (503)
```

**完整场景复现**（`tests/unit/task-recovery.test.ts`）：
1. 会话 A 以 `hang` 引擎下载 `live`，进度 37% → 文件里出现 `{state:'Running', lastPercent:37}`；
2. 丢弃会话 A（等强度于强杀）→ 会话 B 用同一份文件启动；
3. `restoreTasks` → `{restored:1, interrupted:1}`，任务仍在、显示 37%、状态 `Canceled`；
4. `restart('live')` → `Completed`。

## 3. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/core/src/task-queue/task-queue.ts` | 修改 | `restore(snapshot)`；进度节流持久化；`persistIntervalMs` 依赖 |
| `packages/core/src/task-store/task-store.ts` | 修改 | `loadRecovered()`、`snapshotPath` getter |
| `packages/core/src/task-store/bootstrap.ts` | 新增 | `restoreTasks` / `countInterrupted` / `INTERRUPTED_STATES` |
| `packages/core/src/task-store/index.ts` | 修改 | 导出上述符号 |
| `apps/desktop/src/main/task-host.ts` | 新增 | 生产接线：配置并发 + 快照恢复 |
| `tests/unit/task-recovery.test.ts` | 新增 | 7 例（含强杀场景全链路） |
| `tests/unit/task-host.test.ts` | 新增 | 5 例（并发配置 + 启动恢复） |
| `docs/M4-3-REPORT.md` | 新增 | 本报告 |
| `docs/DECISIONS.md` | 修改 | 追加 D-49 |

## 4. 偏离与风险

- **D-49**：进度持久化用**时间节流**（默认 500 ms）而非「每 5% 写一次」。理由：慢速下载可能几分钟涨 1%，按百分比会长期没有新快照；按时间最多丢 0.5 秒进度。
- `restoreTasks` 依赖 `store.recover()` 是纯函数（无 I/O），因此 `load` 与 `recover` 之间不存在竞态；写回发生在 `queue.restore()` 内。
- 风险：快照文件是明文 JSON，含 URL 与标题；**不含** `MediaFormat.url` 凭据（`TaskRecord.mediaInfo` 由 probe DTO 而来，M3 已 `omitUrl`）。仍建议 M5 在私密模式下把该文件纳入脱敏清单，已记入待办。
- 不声称已做「真实进程强杀 → 真实 Electron 重启」的 L2；本轮是 L0 级真实文件读写的等价复现（真实 JSON 落盘、真实新实例加载）。

## 5. 回归状态

| 项 | 结果 |
|---|---|
| `npm test` | 37 files / **503 passed** / 覆盖率四维门控通过 |
| `pnpm turbo run typecheck` | 5/5 |
| `check-layering` | `violationsCount=0` |
| M3 acceptance | 未触碰验收脚本；48/48 基线仍成立 |

## 6. 下一步

M4-4 · 播放列表批量入队（`probePlaylist()` 真实实现 + `enqueueBatch()` + UI 接入）。
