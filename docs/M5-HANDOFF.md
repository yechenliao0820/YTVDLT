# YTVDLT · M5 交接包（最终成品）

> 版本 v1.1 ／ 2026-11-06 ／ **以工作区当前的本文为准**（不引用 HEAD，避免文档自指）
> **基线说明（避免歧义）**：最后一次**功能**提交是 `847a687`（生产装配补口）；`d98fef6` / `329da0f` / `6e7b857` / `44cab2c` **全部只改文档**，不动代码。以工作区当前的本文为准，**不要**按更早的聊天记录或只含预检的版本。
> 给谁看：接手 M5 的 AI。**本文自包含**：读完 + 跑通 §6 即可开工，不需要翻聊天记录。
> 配套：`docs/M5-PREFLIGHT.md` 是可选附录（更细的阻塞说明），**发本文一个文件即可**。
> 权威优先级：`C:/Users/leolee/WorkBuddy/2026-11-05-07-24-49/YTVDLT_HANDOFF.md`（原始任务书 933 行，**唯一权威**）> `docs/PROJECT-HANDOFF.md`（项目内副本，可能有甲方改动）> `PRD-M1/M3` > `ARCHITECTURE-M2/M3` > `DECISIONS.md` > 本文。**冲突时以更靠前者为准，并在 `DECISIONS.md` 留痕。**
> 环境：Windows 10 22631 / Node **22.22.2** / pnpm **9.15.9** / 无 Electron 二进制 / 无网络依赖可跑 L0–L2。

> **状态更新（2026-11-06 晚，本文升 v1.2）**：已按 §8 完成**离线四块**——M5-0（8 条 IPC 通道 + `createM5Host`/`bootstrap`）、M5-1（主题三态 + 强调色）、M5-2（§6.8 全部快捷键 + zh-CN/en）、M5-3（队列主页 + 四页空/错状态 + 30 例截图基线）。
> 结果：`npm test` 53 files / 670 passed，coverage min 86.94%，`acceptance --milestone M5` = **8 PASS + 2 SKIPPED，10/10 门控**（`reports/acceptance-report-m5.json`）。
> **N1/N2/N3 仍未放行** → §2 的 M5-4/M5-5/M5-6 与 §12 的停止声明继续有效。
> **接手剩余工作请改读 `docs/M5-HANDOFF-V2.md`（v2.2）**：那份是「离线做完之后」的施工单，含逐块命令、网络放行清单（国内 N1/N2 vs 国际 N3）与 17 条排雷；本文保留为「开工前」的原始任务背景。

## 0. 三十秒速览

| 项 | 值 |
|---|---|
| 项目根 | `C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\ytvdlt` |
| 状态 | **M1–M4 全部完成**；M5 **未开始**（本文只做准备与交接） |
| 验收 | M1 `17/17 + 5/5`；M2 `37/37 + 5/5`；M3 `48/48 + 12/12 + 4/4`；M4 `9/9 + 10/10 + 4/4`，四套 `allGreen=true` |
| 测试 | `npm test` **44 files / 583 passed**；验收内部 vitest 含 5 个 L2 integration 文件，总数更多（两套口径不要混） |
| 质量门 | typecheck 5/5；layering 0 违规；`TODO/FIXME` 0 处；`package.json` / `pnpm-lock.yaml` 自 M2 起零改动 |
| 最大阻塞 | `node_modules/electron/dist` **无二进制**、`electron-builder` **未安装**、`apps/desktop/dist` **不存在** → M5-4 前必须装依赖（N1，可用国内镜像） |
| 真实站点 | **从未访问过 YouTube**；L3 烟测需要**国际网络出口（N3）**，且要一个甲方有权保存的公开视频 |
| 停止声明 | **未获甲方放行，不进入 M5** |

## 0.1 网络操作硬规矩（最高优先级，违反即返工）

**任何需要网络的步骤，先停下来问甲方，得到明确同意后再做。** 不许静默重试、不许擅自换代理、不许假设“应该能连”。

请示时必须说清三件事：

1. **哪一类网络**：N1 装依赖 / N2 下代码包 / N3 访问国际站点；
2. **具体命令或 URL**（例如 `pnpm install`、`https://github.com/yt-dlp/yt-dlp/releases/...`、某个 YouTube 链接）；
3. **要多久 / 失败会怎样**（能否离线继续其他块）。

标准请示话术：

> 「这一步需要 **N3 国际网络**：要访问 YouTube 做 L3 烟测，预计 5 分钟。你方便现在开一下吗？不开也可以，我先做 M5-1～M5-3，L3 记 SKIPPED。」

甲方说“可以/已联网”之前：**只做离线块，不发起任何网络请求**。网络失败时：停下、如实报告、等指示，**不得把 SKIPPED 写成 PASS**。

## 0.2 M1–M4 实测基线（2026-11-06，串行跑完）

| 里程碑 | 断言 | 门控 | 原始验收 | allGreen |
|---|---|---|---|---|
| M1 | 17/17 | — | 5/5 | ✅ |
| M2 | 37/37 | 5/5 | — | ✅ |
| M3 | 48/48 + 3/3 复验 | 12/12 | 4/4 | ✅ |
| M4 | 9/9 | 10/10 | 4/4 | ✅ |

公共门：`npm test` 44 files / **583 passed**；`typecheck` 5/5；`layering` 0 违规；`TODO/FIXME` 0 处。
证据：`reports/acceptance-report-m1…m4.json`（`reports/` 不入库，本地生成）。

## 1. M5 要交付什么（原任务书 §9）

1. **UI 打磨**：Light/Dark/System 三态 + 强调色；§6.8 全部快捷键；空/错状态；i18n（zh-CN + en）。
2. **双通道自动更新**：应用 `electron-updater` + NSIS `latest.yml`；引擎更新官方 `yt-dlp.exe`，校验 `SHA2-256SUMS` 后原子替换，stable/nightly + 每周间隔，**更新期间暂停队列**。
3. **打包**：`YTVDLT-Setup-<ver>.exe`（NSIS per-user，免管理员）+ `YTVDLT-Portable-<ver>.exe`（配置写 exe 同目录，不可写回退 `%APPDATA%\YTVDLT`）；运行时进 `extraResources`，**绝不入 asar**。
4. **FFmpeg LGPL 合规**：12 条逐条 + 「关于」框声明；**注意 D-08：实际是 LGPL-3.0，不是 2.1+**。
5. **文档全套**：README / BUILD / ARCHITECTURE / ACCEPTANCE / SHORTCUTS / LICENSE-COMPLIANCE / THIRD_PARTY_NOTICES。
6. **L3 在线烟测**：公开且允许保存的视频（如 Blender demo），真实下载 + C1–C12；网络不可达记 `SKIPPED`，不判 FAIL。

**7 条验收 + 9 条断言**（§9.2/§9.3）：
C13 干净 Win VM 安装版全流程；C14 便携版可运行；C13–C16 运行时完整性/不污染系统/卸载清理；主题与快捷键生效；NOTICE 覆盖 §6.7 全部组件；L0–L2 全绿 + L3 PASS/SKIPPED；产物 SHA256。
断言：`A-4.1-02` `A-4.4-16` `A-4.4-20` `A-4.4-21` `A-4.4-28` `A-4.4-29` `A-4.5-08` `A-4.6-06` `A-4.6-07`。

## 2. M5 拆块（建议顺序，含网络需求）

> 网络需求分三类，**不要混为一谈**：
> - **N1 包管理器**：装 electron / electron-builder / react 等。**不需要国际出口**，国内镜像即可（npmmirror；Electron 二进制设 `ELECTRON_MIRROR`）。
> - **N2 代码托管/发布**：下载 yt-dlp.exe、Electron 预编译包、更新源。GitHub 时好时坏，**可用代理/镜像**；引擎更新也可以指向本地文件源做测试。
> - **N3 国际站点**：真实访问 YouTube 并下载（L3 烟测）。**必须国际出口**，没有就记 `SKIPPED`，不判 FAIL，也不得声称“YouTube 能下”。

| 块 | 内容 | 依赖 | 网络 | 验收锚点 |
|---|---|---|---|---|
| **M5-0** | 主进程装配收口：入口调用 `createM4Host`、补齐 IPC 表面（模板 CRUD / 任务详情 / 任务列表）、窗口与托盘 | 代码已就绪 | 装配可离线；窗口需 **N1** | 新增 `A-M5-00`（建议） |
| **M5-1** | 主题三态 + 强调色 + 动态取色 | 无 | 无 | `A-4.4-20` `A-4.6-06` |
| **M5-2** | 快捷键 + i18n（zh-CN/en） | core 已给 `stateLabelKey` / 通知 `titleKey/bodyKey` | 无 | `A-4.1-02` `A-4.4-21` |
| **M5-3** | 空/错状态统一 + 3 个新页面纳入截图基线 | 现有 `run-e2e.mjs --update-baselines` | 无 | `A-4.4-16` |
| **M5-4** | 打包：NSIS + 便携 + `extraResources` + asar 排除 + LGPL 文案 | **electron / electron-builder** | **N1**（+N2 下预编译包） | C13/C14、§12.5 |
| **M5-5** | 双通道更新 + 干净 VM 实测（**代码由 AI，VM 实测由甲方**） | 安装包 + VM | **N1/N2**；应用更新可全本地，无需 N3 | `A-4.4-28` `A-4.4-29`、C13–C16、U7 |
| **M5-6** | 合规文档 + L3 烟测 + SHA256 + 交付归档 | 真实站点 | **N3**（L3）；文档/SHA256 不需要 | §9.2 第 5/7 条 |

## 2.1 五个硬阻塞（M5 的真实难点）

| # | 阻塞 | 现状 | 影响 | 网络类型 |
|---|---|---|---|---|
| B1 | Electron 二进制缺失 | `node_modules/electron/dist` 为空 | 无窗口/托盘/通知，M5-4 全卡 | N1（可用镜像） |
| B2 | 打包工具与产物缺失 | 无 `electron-builder`、无 `apps/desktop/dist` | 没有安装包，成品无法交付 | N1（+N2） |
| B3 | UI 技术栈未落地 | 无 React/Vite，现有 UI 为零依赖静态页 | 主题/三态需先定载体 | N1（若迁移） |
| B4 | 入口未装配 | `index.ts` 未调用 `createM4Host`；模板/详情/列表无 IPC；托盘未创建 | 功能“库可用、界面点不到” | 离线可做 |
| B5 | 真实 GUI 从未跑过 | 无 BrowserWindow；D-28/D-39/D-52 仍 SKIPPED | 不能声称“可运行成品” | 依赖 B1 |

## 3. 生产装配现状（M4 收口后，务必先看）

**已经接好（`apps/desktop/src/main/m4-host.ts`，有 12 例测试）：**

- 启动恢复：`createTaskHost` → `restoreTasks`（`Running/FetchingInfo → Canceled`，保留进度）
- `PLAYLIST_ENQUEUE` **真正创建任务**：`probePlaylist` → `buildDownloadRequest` → `buildPlaylistBatchRecords` → `enqueueBatch`
- 队列事件 → `NotificationCenter`（可注入 Electron 适配器）
- 任务详情 7 项操作 → `TaskDetailService`（shell / clipboard 注入）
- 命令模板 → `CommandTemplateStore` 已 `init()`
- 五域请求装配：`buildDownloadRequest()`（从 ConfigStore 域 + 默认值）

**仍未接（M5-0 的活）：**

| 缺口 | 位置 | 说明 |
|---|---|---|
| 入口未调用 `createM4Host` | `apps/desktop/src/main/index.ts` | 仍只注册 M3 网关；`createM4Host` 未被引用 |
| 无窗口 | 同上 | 从未创建 BrowserWindow（无 electron 二进制） |
| 模板 CRUD 无 IPC | `packages/shared/src/ipc.ts` | `CommandTemplateStore` 已可用，但没有通道 |
| 详情操作无 IPC | 同上 | `TaskDetailService` 已可用，但没有通道 |
| 任务列表/状态无 IPC | 同上 | `queue.list()` 未暴露给渲染层 |
| 托盘未创建 | `apps/desktop/src/main/tray.ts` | 只有菜单模型，没有 `new Tray()` |

## 4. 不可破坏的约定（M5 动代码前必读）

1. **13 条合法状态转移**不变；`Idle → Canceled` **不是**合法边（D-48）。
2. **`EXPECTED_MINIMAL` 与 `DOWNLOAD_ARGV_FROZEN_ORDER` 逐字节冻结**；`request.ts` 只允许追加**可选**字段（D-50）。
3. **CD-12 时序**：`history.add()` 与 `Completed` 只在 `verify().ok === true` 之后。
4. **自定义命令**走正向白名单 `validateTemplateArgs()` + `buildCustomDownload()` 二次拦截（D-51）。
5. **两套脱敏**：`redactText()` 用于 stderr/日志；`maskUrlSecrets()` 用于 URL。**不要把 `redactText()` 直接套整条 URL**——会吞掉 `&` 后的参数（M4-6 踩过）。
6. **通知节流**：进度 ≥10% 或 ≥5s；终态按 `(kind, taskId)` 去重。
7. **断言 ID 只续号**：M3 的 48 条、M4 的 9 条一条都不能改判据；M5 新增用 `A-M5-xx` / `A-4.x-xx`（§9.3 的 9 条）。

## 5. M5 验收分支尚不存在（必须自己加）

`scripts/acceptance.mjs` 目前只有 `runM1/runM2/runM3/runM4`，**没有 `--milestone M5`**。接手的 AI 必须：

1. 新增 `M5_ASSERTIONS`（§9.3 的 9 条：`A-4.1-02` `A-4.4-16` `A-4.4-20` `A-4.4-21` `A-4.4-28` `A-4.4-29` `A-4.5-08` `A-4.6-06` `A-4.6-07`）；
2. 新增 `runM5()`，在 `main()` 里加 `if (milestone === 'M5') { await runM5(); return; }`；
3. 把 M5 测试文件登记进共享的 `M3_TEST_FILE_MAP`；
4. 把 M5 断言 ID 加进 `runM3` / `runM4` 的 `knownIds`（否则 M3/M4 的文件覆盖门控会因“未知 ID”FAIL）；
5. C13–C16 这类人工实测项，用 `MANUAL` 状态 + 甲方证据路径，**不要伪装成自动 PASS**。

## 5.1 新增测试文件必须同步验收映射（否则门控必挂）

`scripts/acceptance.mjs` 里 `M3_TEST_FILE_MAP` 是**共享**的：任何新测试文件若未登记，`M3-GATE-file-coverage` 与 `M4-GATE-file-coverage` 会直接 FAIL。

M5 每个新测试文件都要做两件事：
1. 在 `M3_TEST_FILE_MAP` 加 `'<file>.test.ts': ['A-M5-xx']`；
2. 在 `runM3` 的 `knownIds` / `runM4` 的 `knownIds` 中能把该 ID 解析到（新增 M5 断言表后，把 ID 加进两处）。

## 6. 命令清单（严格串行，勿并行）

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt

npm test                                        # 44 files / 583 passed（unit+contract）
pnpm turbo run typecheck                        # 5/5
node scripts/check-layering.mjs --json          # violationsCount=0

# 只跑某个测试文件（调试用）
node node_modules/vitest/vitest.mjs run tests/unit/<file>.test.ts --reporter=verbose

# 四套验收必须串行：它们共用 reports/vitest-results.json、coverage/、端口与临时目录
node scripts/acceptance.mjs --milestone M1
node scripts/acceptance.mjs --milestone M2
node scripts/acceptance.mjs --milestone M3
node scripts/acceptance.mjs --milestone M4
```

**两条血泪教训：**
- **不要在验收运行期间编辑源文件**：vitest 会读到新旧混合模块，产生假失败（M4 复验时发生过一次）。
- **不要并行跑四套验收**：证据文件互相覆盖，结果不可信。

## 7. 已知陷阱（M4 实际踩过）

| 陷阱 | 现象 | 正确做法 |
|---|---|---|
| URL 被 `redactText` 吞参 | `token=***` 之后整段消失 | URL 用 `maskUrlSecrets()` |
| 恢复时自动开跑 | 一启动就偷偷下载 | `restore()` 不 `pump()`（D-49） |
| 排队任务取消 | 想加 `Idle→Canceled` | 移出队列 + 删除记录（D-48） |
| 批量任务 argv | `--no-playlist` 与 `--playlist-items` 冲突 | 位置 1 换成 `--yes-playlist`（D-50） |
| 模板正则留空白 | `-f '137 251'` 被接受 | 已修，值正则禁空白 |
| 通知重复 | 同一任务完成弹两次 | `(kind, taskId)` 去重 |
| 测试口径混淆 | 把 583 说成验收总数 | `npm test` ≠ 验收内部 vitest |

## 8. 给下一个 AI 的第一小时

1. `git log --oneline -12` + `git status --short`，确认基线：`git log` 中应能看到 `847a687`（最后功能提交），其后提交均为文档；工作区只应有甲方自己的 `docs/PROJECT-HANDOFF.md` 改动。
2. 读本文 §0.1（网络硬规矩）、§3、§4、§5；需要更细的阻塞说明再翻 `docs/M5-PREFLIGHT.md`。
3. 跑 §6 命令（串行），确认四套 allGreen 后再动手。
4. 先做 **M5-1 / M5-2 / M5-3**（离线、低风险、可独立验收），不要一上来碰打包。
5. 需要网络前**先告诉甲方是哪一类**：N1 装依赖（可用国内镜像）、N2 下 GitHub 包（可代理）、N3 访问 YouTube（必须国际出口）。**N3 未放行前，不得声称“真实下载可用”。**
6. 每块一个 commit + 一份 `docs/M5-<n>-REPORT.md` + 一条 `DECISIONS`（从 **D-53** 起续号）。

## 8.1 M5-5 人机分工（重要，别搞错）

M5-5 不是“AI 跑一遍测试”，而是**两段**：

| 段 | 谁做 | 交付物 |
|---|---|---|
| **A. 更新代码与打包配置** | AI（N1/N2；**开始前按 §0.1 停下问甲方**） | `electron-updater` 双通道、NSIS `latest.yml`、引擎更新 `SHA2-256SUMS` 校验 + 原子替换 + **更新期间暂停队列**、回滚；对应 L0/L1 测试 |
| **B. 干净 VM 实测（C13–C16）** | **甲方本人**（AI 无法开窗口 / 进 VM / 点安装包） | 截图 + 日志 + 结果填入 `M5-VM-CHECKLIST.md` |

### B 段：甲方要做的 8 步（约 30–45 分钟）

1. **建干净快照**：Win10 1809+ / Win11 x64；确认无 Python / Node / FFmpeg / Chrome。
2. **装安装版**：双击 `YTVDLT-Setup-<ver>.exe`；截图 SmartScreen 提示（应出现“更多信息→仍要运行”）；记录是否需要管理员权限（应为 per-user，不需要）。
3. **首次启动**：截图自检 4 项（yt-dlp / node / ffmpeg / aria2c）；确认 3 个必需项全绿、aria2c 为 OPTIONAL。
4. **真实下载**：用一个**你有权保存**的公开视频跑一次；记录产物路径、大小、时长、C1–C12 校验结果（应用内可导出报告）。
5. **便携版**：放到普通文件夹运行 → 确认配置写在 exe 同目录；再放到不可写目录（如 `C:/Program Files`）→ 确认回退 `%APPDATA%\YTVDLT`。
6. **卸载**：控制面板卸载 → 检查 `%APPDATA%` / `%LOCALAPPDATA%` / 开始菜单 / 注册表 Run 项 / 桌面快捷方式是否有残留。
7. **应用自更新**：装 v1 → 指向 v2 更新源 → 手动检查 → 观察下载/安装/重启；记录版本号变化；再测一次“更新中断”能否回滚。
8. **引擎自更新**：触发一次 yt-dlp 更新 → 确认校验 SHA2-256SUMS、原子替换、**更新时队列暂停**；故意改坏校验值 → 确认拒绝替换且原文件未损坏。

### A 段：AI 必须提前准备好的东西

- 一份 `docs/M5-VM-CHECKLIST.md`（上述 8 步的勾选表 + 证据栏 + 期望结果）；
- 一个“本地更新源”的最小搭建说明（无需真实发布即可测 v1→v2）；
- 结果回传后的处理规则：**C13–C16 只能由甲方实测结果判 PASS，AI 不得代替签字**；网络不可达的 L3 记 `SKIPPED`，不判 FAIL。

## 9. 待甲方确认（不阻塞离线块；联网一律按 §0.1 先停再问）

| # | 问题 | 影响 |
|---|---|---|
| Q1a | 是否允许 N1 装依赖（electron / electron-builder）？可否用国内镜像？ | M5-4 起阻塞 |
| Q1b | 是否有 N2 通道（GitHub / 代理）下载 yt-dlp 与 Electron 预编译包？ | 引擎更新与打包 |
| Q1c | 是否有 **N3 国际出口**（能访问 YouTube）？何时可用？ | L3 烟测；无则 SKIPPED |
| Q2 | 是否有代码签名证书？ | SmartScreen 文案；无证书需写明「更多信息→仍要运行」 |
| Q3 | 干净 Windows VM 的版本（Win10 1809 / Win11 x64）？ | C13 / U7 实测 |
| Q4 | L3 烟测用哪个公开视频？ | §9.1 第 6 条；网络不可达可 SKIPPED |

## 10. M5 完成定义（DoD）

只有以下**全部成立**才算 M5 交付，缺一条都不许说“完成”：

1. `npm test` + `typecheck` + `layering` 全绿；
2. `acceptance --milestone M5` 的 9 条断言全 PASS（C13–C16 用甲方证据判 `MANUAL-PASS`）；
3. `YTVDLT-Setup-<ver>.exe` 与 `YTVDLT-Portable-<ver>.exe` 均产出，且记录 **SHA256**；
4. 干净 Win10/11 VM：安装版全流程通过（C13）、便携版可运行（C14）、卸载无残留（C15/C16）；
5. 主题三态 + 全部快捷键 + 中英文切换实测生效；
6. NOTICE 覆盖 §6.7 全部组件，LGPL-3.0 12 条逐条满足（D-08）；
7. L3：PASS，或明确 `SKIPPED` + 原因（无 N3），**不得把 SKIPPED 写成 PASS**。

## 11. 交接包清单（发给下一个 AI 时一起给）

| 文件 | 作用 |
|---|---|
| `docs/M5-HANDOFF.md` | **必发，唯一入口**（自包含） |
| `docs/M5-PREFLIGHT.md` | 可选附录（更细的阻塞说明，不发也能开工） |
| `docs/PROJECT-HANDOFF.md` | 项目内任务书副本（原始权威在 `2026-11-05-07-24-49/YTVDLT_HANDOFF.md`） |
| `docs/DECISIONS.md` | D-01…D-53 决策台账（改约定必须续号） |
| `docs/M4-0…M4-6-REPORT.md` | M4 每块报告与偏离 |
| `reports/acceptance-report-m1…m4.json` | 四套验收证据（本地生成，`reports/` 不入库） |
| 仓库本身 | 代码与测试；`docs/PROJECT-HANDOFF.md` 的本地改动属于甲方，**不要提交/覆盖** |

## 12. 停止声明

**M4 已交付，M5 未开始；未获甲方放行，不进入 M5。**
