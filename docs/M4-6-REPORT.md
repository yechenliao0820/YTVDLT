# M4-6 报告 · 托盘通知 + 任务详情 + 错误报告（M4 收口）

> 版本 v1.0 ／ 2026-11-06 ／ 对应 `docs/M3-HANDOFF.md` §10.7；M4 全部功能块到此完成

## 1. 完成了什么（逐条对照）

| 验收条目 | 实现 | 证据 |
|---|---|---|
| **托盘常驻模型** | `apps/desktop/src/main/tray.ts`：`buildTrayMenu()` 7 项（显示主窗口 / 新建下载 / 取消全部（动态计数）/ 打开下载目录 / 退出）+ `trayTooltip()` + `canQuit()` | `notifications.test.ts`「builds a menu whose cancel entry reflects the queue」 |
| **四类通知** | `NotificationCenter.handle(event)`：`progress` / `completed` / `error` / `canceled`；错误 `urgency=critical`、进度 `silent` | 「progress / completed / error / canceled each produce one notification」 |
| **通知节流与去重** | 进度双重节流（≥10% **或** ≥5s）；终态按 `(kind, taskId)` 去重；`forget(id)` 允许复用 id；历史上限 200 | 「progress is throttled by percent step OR time window」「terminal notifications are deduped」 |
| **关窗最小化** | `shouldHideToTray({action, minimizeToTray, active})`：设置为开 → close/minimize 都隐藏；否则 close 真退出 | 「close/minimize hide to tray only when the setting is on」 |
| **Electron 适配层** | `ElectronNotificationAdapter`：`Notification` 构造器注入，转发 title/body/silent/urgency + click；`Notification=null` 时安全降级为 no-op（D-39 环境） | 「forwards title/body/silent/urgency and click events」「is a safe no-op when Electron is absent」 |
| **任务详情 7 项操作** | `TaskDetailService`：`open-file` / `open-folder` / `copy-url` / `copy-error-report` / `cancel` / `remove` / `retry`；open 前先 `fs.exists`，缺失返回 `FILE_MISSING` 而不是让系统报错 | 9 例：7 操作全覆盖 + 未知任务 + 缺文件/无产物 |
| **错误报告面板** | `buildErrorReport()`：OS / 应用版本 / 引擎版本 / URL / 状态 / 错误码 / 进度 / argv / 完整 stderr（上限 400 行）；`maskUrlSecrets()` 掩码 `token/sig/expire/key/po_token` 等签名参数与 URL userinfo；`formatErrorReport()` 生成可粘贴文本 | 「copy-error-report writes a redacted report…」断言不含 `SID=abc` / `Bearer xyz` / `SECRET` |
| **UI 页面** | `packages/ui/src/pages/task-detail/{index.html,task-detail.js}`：7 个按钮，禁用态按状态推导（运行中不可删除、非 Error/Canceled 不可重试、无 errorCode 不可复制报告）；只产出动作 JSON | 页面逻辑 `availability()` 与服务端规则一一对应 |
| **分层** | 三个新模块均为纯 core / 注入式 adapter，`packages/ui` 无 Node/Electron import | `check-layering` 0 违规 |

## 2. 验收证据

```text
$ node node_modules/vitest/vitest.mjs run tests/unit/task-detail.test.ts tests/unit/notifications.test.ts
 Test Files  2 passed (2)
      Tests  21 passed (21)

$ npm test
 Test Files  42 passed (42)
      Tests  571 passed (571)        # unit+contract；验收自带 vitest 含 integration 共 577
```

## 3. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/core/src/notifications/notification-center.ts`（+`index.ts`） | 新增 | 四类通知 + 节流 + 去重 + 历史上限 |
| `packages/core/src/task-detail/task-detail.ts`（+`index.ts`） | 新增 | 7 项操作服务 |
| `packages/core/src/error-report/error-report.ts`（+`index.ts`） | 新增 | 报告构建 + 凭据掩码 + 文本渲染 |
| `packages/core/src/index.ts` | 修改 | 导出三个模块 |
| `apps/desktop/src/main/tray.ts` | 新增 | 托盘菜单/提示/退出策略（纯函数） |
| `apps/desktop/src/main/notifications.ts` | 新增 | Electron 通知适配（构造器注入） |
| `packages/ui/src/pages/task-detail/{index.html,task-detail.js}` | 新增 | 详情页（零依赖静态） |
| `tests/unit/task-detail.test.ts`、`tests/unit/notifications.test.ts` | 新增 | 21 例 |
| `scripts/acceptance.mjs` | 修改 | 新增 `--milestone M4`（9 条断言 + 4 条原始验收 + 10 道 gate） |
| `docs/M4-6-REPORT.md`、`docs/DECISIONS.md` | 新增/修改 | 本报告 + D-52 |

## 4. 装配补口（M4 审计后追加，A-M4-09）

| 文件 | 说明 |
|---|---|
| `packages/core/src/request-builder/build-request.ts` | 五域请求装配纯函数：ConfigStore 域 + 默认值 → 完整 `DownloadRequest`（此前全仓库缺失，批量入队无法落地） |
| `apps/desktop/src/main/m4-host.ts` | `createM4Host()`：串起恢复、队列、批量回调、通知订阅、任务详情、命令模板、IPC 网关；**不 import electron** |
| `tests/unit/request-builder.test.ts`（6 例）、`tests/unit/m4-host.test.ts`（7 例） | 装配链路测试：真实 IPC 通道 → 3 个任务 → 通知 → 详情复制脱敏 URL |

## 5. 集成边界（审计后补充，必须如实看待）

| 能力 | 代码/测试 | 生产装配 |
|---|---|---|
| 并发队列 / 快照恢复 | ✅ 完整 | ✅ `createM4Host()` 已装配（boot 恢复 + 队列），但入口 `index.ts` 仍未调用（无窗口） |
| 播放列表批量 | ✅ 核心 + IPC | ✅ `createM4Host` 注入了真实回调（probe → build → enqueueBatch），有 12 例装配测试 |
| 命令模板 | ✅ core + argv 构造 | ⚠️ 已在 host 中 `init()`，但**无 IPC 通道**，UI 仍调不到 |
| 任务详情 7 操作 | ✅ 服务 + 页面 | ⚠️ 服务已在 host 装配，**无 IPC 通道** |
| 托盘 / 通知 | ✅ 决策层 + 适配器 | ✅ 已订阅 `queue.onEvent`；托盘真实图标仍 SKIPPED（D-52） |

> 结论：**M4 交付的是「可测试的核心能力 + 主进程装配（host 层）」，仍不是「装好即用的成品」**。四条原始验收是在 L0/L1 用注入端口验证的，**不是**在真实 Electron 应用里点出来的；入口调用、IPC 表面、窗口与托盘属于 M5-0，已写入 `M5-HANDOFF.md` §3。

## 6. 偏离与风险

- **D-52**：托盘与通知的「真实展示」仍未在真实 Electron 窗口中跑过（`node_modules/electron/dist` 无二进制，D-39 延续）。本轮交付的是**可测试的决策层**（菜单模型、节流去重、适配器契约），并以 `Notification=null` 的降级用例证明不会崩。真实托盘图标 / 点击聚焦留 M5 打包后补 L2。
- 通知文案当前为中文常量 + 同时带 `titleKey/bodyKey`（M5-2 i18n 直接换 key 即可，不改 core）。
- `copy-error-report` 只允许有 `error` 的任务；`Completed` 任务的「复制错误报告」按钮在 UI 上置灰，服务层也会返回 `NO_ERROR`（双保险）。
- 风险：`TaskDetailService` 的 shell 为 `undefined` 时 `open-file`/`open-folder` 返回 `SHELL_UNAVAILABLE`；生产装配必须注入 `ElectronShellPort`（M3 已具备）。

## 7. 回归状态

| 项 | 结果 |
|---|---|
| `npm test` | 44 files / **583 passed**（unit+contract，含装配补口 12 例） |
| `pnpm turbo run typecheck` | 5/5 |
| 分层 | 0 违规 |
| M3 验收 | **48/48 + 12/12 + 4/4，allGreen=true**（M4 与装配补口后重跑） |
| M4 验收 | **9/9 + 10/10 + 4/4，allGreen=true**（见 `reports/acceptance-report-m4.json`） |

## 8. 停止声明

**M4 已全部完成（M4-0…M4-6），未获甲方放行，不进入 M5。**

下一步建议：`M5-1 主题三态 + 强调色 + 跟随系统`（离线可做），M5-4 打包前需先补 `electron` dist 并告知甲方切网络。
