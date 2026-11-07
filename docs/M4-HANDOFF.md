# YTVDLT · M4 交付与 M5 接手交接包

> 版本 v1.0 ／ 2026-11-06 ／ **代码基线以 `git log --oneline -1` 为准**（本文自身也会产生提交）
> 给谁看：接手 M5 的 AI / 开发者。读完本文 + 跑通 §4 的命令即可开工，不需要翻聊天记录。
> 权威优先级不变：`YTVDLT_HANDOFF.md` > `PRD-M1/M3` > `ARCHITECTURE-M2/M3` > `DECISIONS.md` > 本文。

## 0. 三十秒速览

| 项 | 值 |
|---|---|
| 项目根 | `C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\ytvdlt` |
| M4 状态 | **7 个块全部完成**（M4-0 收口 + M4-1…M4-6），每块一个 commit + 一份 `docs/M4-<n>-REPORT.md` |
| M4 验收 | `9/9` 断言（含 A-M4-09 生产装配）+ `10/10` gates + `4/4` 原始验收，`allGreen=true` |
| 回归 | M3 `48/48 + 12/12 + 4/4` 仍 green；`npm test` **583/583**（unit+contract，44 files） |
| 下一步 | **未获甲方放行，不进入 M5**；放行后按 `M5-1 → M5-6` 逐块推进 |
| 依赖 | **零新增 npm 依赖**；`pnpm-lock.yaml` / `package.json` 自 M2 起零改动 |
| 冻结契约 | `request.ts` 仅追加一个**可选**字段 `advanced.playlistItems?`（D-50），`EXPECTED_MINIMAL` 逐字节未变 |

## 1. 七个 commit

| commit | 主题 | 关键产出 |
|---|---|---|
| `64575e9` | M4-0 QA 收口 | legacy 证据脚本化（D3）、`A-4.3-04` 补分支（D1）、`ABR_FIELD` 单一数据源（D2）、逐条计时（D4） |
| `4a02b33` | M4-1 7 态状态机 | `STATE_ORDINAL` / `transitionMatrix` / `legalTargets`；15 例（49 组合 + 36 非法逐条） |
| `2ccf438` | M4-2 并发调度 | `pump()` 槽位 + `concurrency 1..8` + 自动补位；11 例 |
| `0066618` | M4-3 快照恢复 | 进度节流写盘 + `restoreTasks()` + `TaskHost` 接线；12 例（含强杀全链路） |
| `d040146` | M4-4 播放列表批量 | 真实 `probePlaylist` + `--playlist-items` 独立任务 + IPC/UI；17 例 |
| `7e9cbab` | M4-5 命令模板 | 正向白名单 + 16 类恶意输入拒绝 + 日志页；29 例 |
| `bad43ce` | M4-6 托盘/详情/报告 | 四类通知 + 7 项操作 + 脱敏报告 + `--milestone M4`；21 例 |

## 2. M4 新增的不可破坏约定（动 M5 代码前必读）

1. **DTO 只追加可选字段**：`AdvancedDomain.playlistItems?: string | null`（D-50）。默认请求仍生成 `--no-playlist`；批量任务用 `--yes-playlist --playlist-items N` **替换位置 1**，`DOWNLOAD_ARGV_FROZEN_ORDER` 未改。
2. **13 条合法转移不变**：`Idle → Canceled` **不是**合法边（D-48）。排队任务取消 = 移出队列 + 删除记录，无 `state-changed`；运行中取消才走 `Running→Canceled`。
3. **启动不自动下载**：`TaskQueue.restore()` 只入内存 + `Running/FetchingInfo→Canceled` + 回写快照，**不 `pump()`**（D-49）。
4. **进度持久化按时间节流**（默认 500 ms，`persistIntervalMs: 0` 表示每事件写）。
5. **自定义命令是安全边界**：`validateTemplateArgs()` 正向白名单（23 选项）+ 逐选项值语法；`buildCustomDownload()` 末尾再跑 `assertNoForbiddenOptions()`；`--` 恒 1 个且在倒数第二位（D-51）。
6. **凭据掩码有两套**：`redactText()`（日志/ stderr 的 `Cookie`/`Authorization`/bearer）+ `maskUrlSecrets()`（URL 查询串的 `token/sig/expire/key/po_token`）。**不要**把 `redactText()` 直接套在 URL 上——它会吞掉 `&` 后面的参数（M4-6 已踩过）。
7. **通知节流**：进度 ≥10% 或 ≥5s；终态按 `(kind, taskId)` 去重；`forget(id)` 后才允许复用。
8. **断言 ID 只续号**：M4 新增 `A-M4-01…08` 与 `M4-ACCEPT-1…4`；M3 的 48 条一条未改。

## 3. 代码地图（M4 增量）

| 包 / 目录 | 新增或变更 |
|---|---|
| `packages/core/src` | `task-queue/{state-machine,task-queue}.ts`（并发/恢复）、`task-store/{task-store,bootstrap}.ts`、`playlist/batch.ts`、`command-template/{validate,store}.ts`、`task-log/task-log-buffer.ts`、`notifications/notification-center.ts`、`task-detail/task-detail.ts`、`error-report/error-report.ts` |
| `packages/engine-ytdlp/src` | `argv-builder.ts`（flat playlist）、`argv-builder-download.ts`（G0′ 段）、`argv-builder-custom.ts`（新）、`argv-compliance.ts`（白名单追加）、`yt-dlp-engine.ts`（`probePlaylist` 真实实现） |
| `packages/ui/src` | `pages/queue/playlist-batch.{html,js}`、`pages/task-log/{index.html,task-log.js}`、`pages/task-detail/{index.html,task-detail.js}` |
| `apps/desktop/src/main` | `task-host.ts`（配置并发 + 恢复）、`tray.ts`、`notifications.ts`、`ipc-gateway.ts`（`PLAYLIST_ENQUEUE`） |
| `scripts` | `lib/legacy-closure.mjs`（新）、`acceptance.mjs`（`--milestone M4` + 逐条计时 + knownIds） |
| `tests` | 9 个新文件：`state-machine-m4`、`task-queue-concurrency`、`task-recovery`、`task-host`、`playlist-batch`、`playlist-batch.contract`、`command-template`、`task-detail`、`notifications` |

## 4. 命令清单

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt
npm test                                      # unit+contract：42 files / 571 passed，四维 >=70
# 注意：acceptance 内部的 vitest 还包含 tests/integration/offline 的 5 个文件，总数是 577——两个口径不要混为一谈
node scripts/acceptance.mjs --milestone M4    # 9/9 + 10/10 + 4/4, allGreen=true
node scripts/acceptance.mjs --milestone M3    # 48/48 + 12/12 + 4/4, allGreen=true
pnpm turbo run typecheck                      # 5 successful
node scripts/check-layering.mjs --json        # violationsCount = 0
node scripts/lib/legacy-closure.mjs           # 5 files / 129 tests（从 vitest 报告重生成）
```

## 5. 已知边界 / SKIPPED（**不许当成已完成**）

| 项 | 状态 | 归属 |
|---|---|---|
| 真实 Electron 托盘图标 / 系统通知 | **SKIPPED**：`node_modules/electron/dist` 无二进制，只交付决策层 + 注入式适配器 + no-op 降级 | M5-4 打包后补 L2 |
| 三个新 UI 页的截图回归 | **未纳入** M3 的三弹窗基线集（避免重录 14 张既有基线）；数据契约由 17 例 IPC/纯函数测试覆盖 | M5-3 统一三态时一起纳入 |
| `PLAYLIST_ENQUEUE` 生产接线 | 通道与处理器已实现，`enqueuePlaylistBatch` 由宿主注入；当前 `createM3Host` **未注入**，生产环境返回 `enqueued:false` | M5 体验阶段接 `TaskHost` |
| `createTaskHost` 是否被入口调用 | **否**：`createM4Host` 已装配队列/详情/通知，但 `index.ts` 仍未调用它 | M5-0 |
| 模板/详情/任务列表 IPC | **无通道**：服务已就绪，UI 调不到 | M5-0 |
| 命令模板 IPC | core + engine 已完整，**尚未**加 IPC 通道（模板 CRUD 目前只能经 core 调用） | M5-1 或 M5-3 前补 |
| 通知中心与队列的生产订阅 | `NotificationCenter.handle()` 已就绪，宿主未订阅 `queue.onEvent` | M5 体验阶段接 |
| D-28 / D-39（M3 遗留） | 仍 SKIPPED | M5-4 / M5-5 |

## 6. 给 M5 的建议顺序

1. **M5-1 主题三态**（离线）：`packages/ui/src/styles/**` + `theme-bridge.ts`；三个新页面沿用 `ytvdlt.css`，切主题时应一并覆盖。
2. **M5-2 快捷键 + i18n**：core 已给 `stateLabelKey()` 与通知的 `titleKey/bodyKey`，直接换资源即可，**不要改 core 文案结构**。
3. **M5-3 三态统一**：顺手把 `pages/queue`、`pages/task-log`、`pages/task-detail` 纳入截图基线（`run-e2e.mjs --update-baselines`）。
4. **M5-4 打包**：**硬前置**是 `electron` dist 二进制 + 联网；必须先告知甲方。
5. **M5-5 更新 + 干净 VM**、**M5-6 合规 + L3 + SHA256** 按原拆解。

## 7. 停止声明

**M4 已交付，未获甲方放行，不进入 M5。**

> 说明：本轮按甲方「自主完成、可组队分工」的指令，**未在每块之间停下等批准**（与 M3-HANDOFF §12.1 的逐块停止不同）；替代保障是：每块独立 commit、独立报告、独立验收，且 M3/M4 验收在收口时各连跑 3 次全绿。
