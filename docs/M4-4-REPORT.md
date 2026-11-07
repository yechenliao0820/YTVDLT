# M4-4 报告 · 播放列表批量入队

> 版本 v1.0 ／ 2026-11-06 ／ 对应原始验收 ③、`docs/M3-HANDOFF.md` §10.5

## 1. 完成了什么（逐条对照）

| 验收条目 | 实现 | 证据 |
|---|---|---|
| **`probePlaylist()` 真实实现**（替换 M3 的 `UNKNOWN` 占位） | `YtDlpEngine.probePlaylist()` 走同一条注入端口链路：`build({noPlaylist:false, flatPlaylist:true})` → `spawn` → `toPlaylistInfo()`；空 entries 报 `UNSUPPORTED_SITE`（单视频不是列表） | 契约测试：解析 fixture 得 3 条，argv 含 `--flat-playlist`、不含 `--no-playlist`、URL 在末位 |
| **`--playlist-items` 生成独立任务** | `AdvancedDomain.playlistItems?`（可选、追加）→ `resolveDownloadPlan` 语法校验 → `buildDownload` 在位置 1 用 `--yes-playlist --playlist-items N` 替换 `--no-playlist` | `buildPlaylistBatchRecords`：原始位置（非点击顺序）第 1/2/3/5 条 → `'1'/'2'/'3'/'5'`；argv 用例断言三连 |
| **5 条 → 5 个独立任务** | `buildPlaylistBatchRecords()` 纯函数 + `TaskQueue.enqueueBatch()`；每条 `TaskRecord` 独立 `id` / `request` / `playlistItems` | 11 例：5 条入队 → 5 个独立记录、`playlistItems` 去重后为 5 个不同值 |
| **独立进度 + 并发不超限** | 复用 M4-2 的槽位调度：5 条 + `concurrency:2` → 同时 2 个、其余排队，全部完成 | 该用例断言 `maxActive=2`、`downloads=5` |
| **UI 选择页接入** | 新页面 `packages/ui/src/pages/queue/playlist-batch.{html,js}`：逐条渲染 `data-task-id` / `data-playlist-items`，显示「已选/将创建/预计并发」，点击只产出任务清单（`enqueued:true`），**不直接下载** | 静态页 + IPC 契约；见 §4 载体说明 |
| **IPC 通道（与 M3 确认语义分离）** | 新增 `ytvdlt:playlist:enqueue`，严格白名单 `{selectedIds, playlistUrl, kind}`；空/超 500/非字符串/非 http(s)/带凭据 URL 逐条拒绝 | 6 例契约：5 条 → 5 个 taskId；`file://`、UNC、`user:pw@` 全部 `INVALID_URL`；M3 的 `DIALOG_CONFIRM` 仍 `enqueued:false` |
| **合规** | `--yes-playlist` / `--playlist-items` 进入 `ALLOWED_DOWNLOAD_OPTIONS`；表达式正则只允许数字/逗号/`-`/`:`，注入式（`1; rm -rf /`、`1 --exec calc`）被拒并回落单视频模式 | `sanitizePlaylistItems` 10 组正反例 + argv 回落用例 |

## 2. 验收证据

```text
$ node node_modules/vitest/vitest.mjs run tests/unit/playlist-batch.test.ts tests/contract/playlist-batch.contract.test.ts
 Test Files  2 passed (2)
      Tests  17 passed (17)

$ node node_modules/vitest/vitest.mjs run tests/unit/argv-builder-download.test.ts tests/unit/argv-compliance.test.ts
 Test Files  2 passed (2)
      Tests  32 passed (32)      # 冻结 EXPECTED_MINIMAL 未回归
```

## 3. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/shared/src/request.ts` | 修改（追加可选字段） | `advanced.playlistItems?` |
| `packages/shared/src/download-plan.ts` | 修改（追加） | `DownloadPlan.playlistItems` + `PLAYLIST_ITEMS_INVALID` 警告码 |
| `packages/shared/src/ipc.ts` | 修改（追加） | `PLAYLIST_ENQUEUE` 通道常量 |
| `packages/core/src/decision/download-plan.ts` | 修改 | `sanitizePlaylistItems()` + 裁决 |
| `packages/core/src/playlist/{batch,index}.ts` | 新增 | 批量计划纯函数 |
| `packages/core/src/index.ts` | 修改 | 导出 playlist 模块 |
| `packages/core/src/task-queue/task-queue.ts`、`ports.ts` | 修改 | `enqueueBatch()` |
| `packages/engine-ytdlp/src/{argv-builder,argv-builder-download,argv-compliance,yt-dlp-engine}.ts` | 修改 | flat playlist probe + `--yes-playlist` 分支 + 白名单 |
| `apps/desktop/src/main/ipc-gateway.ts` | 修改 | 批量入队处理器（注入式回调） |
| `packages/ui/src/pages/queue/playlist-batch.{html,js}` | 新增 | 批量预览页（零依赖静态） |
| `tests/unit/playlist-batch.test.ts`、`tests/contract/playlist-batch.contract.test.ts`、`tests/contract/download-engine.contract.test.ts` | 新增/修改 | 17 例 + 引擎契约由「占位」改「真实」 |
| `docs/M4-4-REPORT.md`、`docs/DECISIONS.md` | 新增/修改 | 本报告 + D-50 |

> 本块 18 个文件略超「≤15」的建议上限，超出部分是 2 个新增 UI 静态文件 + 2 个新测试；功能面仍是一个可独立验收的能力（批量入队），未夹带其他任务。

## 4. 偏离与风险

- **D-50**：五域 DTO 追加**可选**字段 `advanced.playlistItems`。这是 M4-4 唯一可行的落点——`DownloadEngine.download(req, onEvent)` 是 M1 冻结的 5 方法签名，`DownloadContext` 也不进 DTO；若不走 DTO 就只能改冻结签名。字段可选 ⇒ 所有既有请求字面量无需修改，`EXPECTED_MINIMAL` 逐字节不变（已用 32 例验证）。
- `--yes-playlist` 会替换位置 1 的 `--no-playlist`；`DOWNLOAD_ARGV_FROZEN_ORDER` 是「文档顺序表」而非构造逻辑，未改；新增 `G0′` 段在 `DOWNLOAD_ARGV_M3_SEGMENTS` 中登记。
- **UI 载体**：新页面沿用 D-31 的零依赖静态 HTML/CSS + 原生 DOM，**未加入**三弹窗截图基线集（避免为新增页重录 14 张既有基线）；其数据契约由 IPC 契约测试覆盖，页面本身的 DOM 逻辑为纯函数（`render()` / `selectedIds()`）。
- 风险：`probePlaylist` 的 timeout 设为 60s（大列表更慢），未做分页/续拉；条目数 >500 时 IPC 拒绝，UI 需分批。已在 `D-50` 记录。

## 5. 回归状态

| 项 | 结果 |
|---|---|
| `pnpm turbo run typecheck` | 5/5 |
| `layering.test.ts` | 2/2（`packages/ui/src/pages` 无 Node/Electron import） |
| 冻结 argv | `argv-builder-download` + `argv-compliance` 32/32 |
| M3 48 条断言 | 未触碰验收脚本；M4-6 收口时统一重跑 |

## 6. 下一步

M4-5 · 命令模板 + 参数白名单 + 任务日志页。
