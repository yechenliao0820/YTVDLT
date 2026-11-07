# AI 维护手册（YTVDLT Desktop）

> **这份文档是给下一个接手的人／AI 看的。** 目标：不用通读 40 多份历史报告，也能在 10 分钟内知道
> 「这个项目是什么、代码在哪、我该改哪个文件、改完怎么验、验完要交什么」。
>
> - 当前版本：**0.1.0**（基准线，2026-11-07 仓库重建后首次发版；此前内部构建曾到 0.1.6，见 BUILD-HISTORY）
> - 平台：Windows 10/11 x64（Electron 45 + yt-dlp 随包）
> - 一句话：**Electron 桌面下载器，前端零依赖静态页，主进程只做编排，真正的下载交给随包的 yt-dlp。**

---

## 0. 维护铁律（先看这条）

**每次改完代码，必须在回复末尾输出一份「修改文件清单」**，格式固定，方便业主去 GitHub 提交：

```
### 修改文件清单
| 文件 | 改动 | 影响 |
|---|---|---|
| packages/ui/src/pages/queue/queue.js | 修 X | 队列页按钮 |
| docs/DECISIONS.md | 追加 D-81 | 决策记录 |
（未改动的文件不要列；新增文件标「新增」）
```

其他铁律：

1. **不要动 `packages/shared/src/request.ts`**（D-50 冻结，逐字节锁定）。
2. **不要往 `devDependencies` 里加新依赖**（D-61 白名单只允许 `electron-builder` / `electron-updater`）。
3. **不要改 `apps/desktop/electron-builder.yml` 的 `files` glob**（§6.2-⑥）。要加文件进包，走 `extraResources` 或像 `electron-updater` 那样用 esbuild 内联（D-75）。
4. **不要在别人的原稿／文档里加「由 AI 生成」之类声明。**
5. **改行为必须留决策记录**：在 `docs/DECISIONS.md` 追加 `## D-<下一个编号> · 日期 · 标题`，写「现象／根因／决策／验证／未覆盖」。
6. **不要把 `SKIPPED` 的验收项改成 `PASS`**，除非对应前置条件真的做完（见 `docs/DECISIONS.md` D-71 / §11）。
7. **删除文件只能删到回收站，禁止永久删除。** 详见 §0.1，这是业主明确下达的硬性要求。

---

## 0.1 删除文件的规定（因一次真实事故而定，必须遵守）

**2026-11-07 事故（D-81）**：迁移项目目录时，先 `Move-Item` 部分文件、未校验就 `Remove-Item -Force` 清理残留，
把 `.git` 内容与根目录配置（`package.json` / `pnpm-lock.yaml` / `tsconfig.base.json` / `turbo.json` /
`vitest.config.ts` / `README.md` / `LICENSE` / `.gitignore` / `.npmrc`）**永久删除**。
`Remove-Item -Force` 与 `rm -f` **不进回收站**，回收站里一条记录都没有，`LICENSE` 与全部 git 历史至今未找回。

**因此，任何删除操作必须满足以下全部条件：**

1. **只能进回收站**。Windows 用 `Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile/DeleteDirectory`
   并指定 `RecycleOption.SendToRecycleBin`，或 PowerShell 里包一层同样的调用。
   **禁止** `Remove-Item -Force`、`rm -f`、`rm -rf`、`rd /s /q`、`shutil.rmtree`。
2. **先备份再删**：批量删除前先把目标目录复制一份到项目外的临时位置，确认新位置可用后再删旧的。
3. **移动/复制之后必须校验再删源**：核对文件数与关键文件（`package.json`、`.git/HEAD`、`LICENSE`）存在，
   才允许删源目录。**移动未校验前，不得执行任何删除**。
4. **单次删除不超过 50 个文件**（本机 safe-delete 守卫的阈值，超了会被直接拒绝）。
5. **删之前列出完整路径给业主确认**，尤其是 `.git`、`LICENSE`、`docs/`、`resources/` 这类不可再生资产。
6. 清理构建产物（`dist-*/`、`coverage/`、`_to-delete/`）虽可再生，**同样走回收站**。

**判断"可再生"的三个例外（仍需回收站）**：`dist-*/` 重新打包即可、`coverage/` 重跑测试即可、
`node_modules/` 重新 `pnpm install` 即可——但它们之外的一切都不许删。

---

## 0. 先自证：你打开的是不是这个项目

**不要凭记忆或文档里的数字干活。** 先跑这三条，确认位置与状态：

```bash
ls package.json pnpm-workspace.yaml turbo.json apps packages scripts    # 缺一个就说明目录不对
git log -1 --oneline                                                  # 最近一次提交
node -e "console.log(require('./package.json').version)"               # 仓库版本（打包后应回到 0.1.0）
```

**事实来源优先级（冲突时按这个顺序采信）**

1. **代码本身**（`grep` 出来的实现）
2. **当场跑出来的结果**（`npm test` / `run-e2e.mjs` / `handoff-check.mjs`）
3. 代码注释里的决策编号（`D-xx`）
4. `docs/DECISIONS.md`
5. `docs/*-REPORT.md`（历史快照，**很可能已过期**）

文档里的任何数字（测试数、覆盖率、PASS 数、版本号）都只是**当日快照**。引用前必须现跑一次，
`node scripts/handoff-check.mjs` 就是用来把文档数字和仓库现状对账的——它报不一致，就是文档旧了，改文档，不要改结论。

**本手册最后核对日期：2026-11-07（对应发版基准 0.1.0）**。之后若代码变了而这里没变，以代码为准，并顺手更新本手册。

---

## 0.5 改动的标准流程（照做就不会漏）

```
1. grep 定位实现            →  不要靠猜文件名
2. 改代码（保持分层，见 §2）
3. pnpm typecheck           →  必须 5 successful
4. npm test                 →  必须 0 failed（当前基线 718 例）
5. node scripts/run-e2e.mjs →  必须 30/30 + 反例 5/5
6. 动了 UI  → node scripts/build-desktop.mjs && npx electron-builder --win --publish never
               打包后立刻 git checkout -- package.json apps/desktop/package.json
7. 打包产物实测：--remote-debugging-port=9222 启动，跑 reports/l3-probe/ui-drive.mjs
8. docs/DECISIONS.md 追加 D-xx
9. 回复末尾输出「修改文件清单」（§0 顶部的格式）
```

**改动类型 → 必须重跑什么**

| 改了什么 | 必须验证 |
|---|---|
| `packages/ui/**`（页面/样式/文案） | `build-desktop` + `run-e2e`（30 张基线）+ 打包后真机点一遍 |
| `packages/core/**` | `typecheck` + `npm test`（core 单测最密） |
| `packages/engine-ytdlp/**`（argv/进度/清单） | `typecheck` + `npm test` + `scripts/l3-smoke.mjs`（真下载） |
| `apps/desktop/src/main/**`（IPC/宿主） | `typecheck` + `npm test` + 打包后真机走一遍 |
| `apps/desktop/electron-builder.yml` | 重新打包 + 检查 `latest.yml` / asar 内容 / 真机启动 |
| 只改 `docs/**` | 跑 `handoff-check.mjs` 对账即可 |

---

## 1. 60 秒上手

```bash
pnpm install                     # 依赖（首次）
pnpm typecheck                   # 5 个包类型检查，必须 5/5
npm test                         # vitest 全量（约 700+ 例，带覆盖率门限 70%）
node scripts/run-e2e.mjs         # 30 张截图基线 + 5 个反例，必须全绿
node scripts/handoff-check.mjs   # 文档里的数字与仓库现状对账

# 打包（顺序不能反）
node scripts/build-desktop.mjs                     # 1) 打包主进程 + 拷贝前端
CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --win --publish never       # 2) 出 NSIS + 便携版
git checkout -- package.json apps/desktop/package.json   # 3) 还原被构建改写的 package.json（见 §7 坑 2）
```

---

## 2. 目录地图

```
ytvdlt/
├── apps/desktop/              # Electron 应用（唯一可执行外壳）
│   ├── src/main/              # 主进程：编排、IPC、窗口、托盘、更新
│   ├── src/preload/           # contextBridge 白名单（渲染层唯一出入口）
│   ├── electron-builder.yml   # 打包配置（files / extraResources / nsis / publish）
│   ├── build/icon.ico         # 应用图标
│   └── dist/                  # 【生成】build-desktop.mjs 的产物，会被打进 asar
├── packages/
│   ├── shared/                # 纯类型 + 常量：IPC 通道、请求/任务/错误/更新契约
│   ├── core/                  # 纯逻辑（禁 node:*）：队列、校验、路径、配置、错误映射…
│   ├── engine-ytdlp/          # yt-dlp 适配：argv 构造、进度解析、清单、自更新
│   └── ui/                    # 零依赖静态前端（HTML/CSS/JS），e2e 基线也在这里
├── resources/runtime/win-x64/ # 随包二进制：yt-dlp / ffmpeg / aria2c / node（不进 git）
├── scripts/                   # 构建 / 测试 / 验收 / 烟测脚本（见 §6）
├── tests/                     # unit / contract / integration / e2e（含 30 张基线 PNG）
├── docs/                      # 设计、决策、各里程碑报告、本手册
├── reports/                   # 【不入库】本地证据：烟测 JSON、截图、日志
└── dist-0.1.6/                # 【不入库】当前交付包（Setup + Portable + latest.yml）
```

**依赖方向（单向，违反会被 `scripts/check-layering.mjs` 拦）**

```
ui（零依赖） ← preload ← apps/desktop
                 ↑
      shared ← core ← engine-ytdlp
```

`core` 里**禁止**出现 `node:fs` / `node:child_process` / `electron`；一切外部能力通过 `CorePorts` 注入。

---

## 3. 功能 → 代码位置（「哪个功能有问题就改哪」）

| 你看到的功能 | 改这里 |
|---|---|
| 队列页渲染、轮询、按钮行为 | `packages/ui/src/pages/queue/queue.js` |
| 详情页、七个操作按钮、返回 | `packages/ui/src/pages/task-detail/task-detail.js` |
| 队列页/详情页样式、主题 | `packages/ui/src/styles/ytvdlt.css`、`packages/ui/src/theme/theme.js` |
| 文案（中/英） | `packages/ui/src/i18n/messages.js` |
| 粘贴入队（`DOWNLOAD_START`） | `apps/desktop/src/main/m5-channels.ts` → `m4-host.ts::enqueueSingle` |
| 任务列表/详情/动作（`TASK_*`） | `apps/desktop/src/main/m5-channels.ts`（`TASK_LIST/DETAIL/ACTION`） |
| 播放列表批量入队 | `apps/desktop/src/main/ipc-gateway.ts` + `core/playlist/batch.ts` |
| 队列调度、并发、暂停 | `packages/core/src/task-queue/task-queue.ts` |
| yt-dlp 命令行参数 | `packages/engine-ytdlp/src/argv-builder-download.ts`（自定义命令走 `argv-builder-custom.ts`） |
| 下载进度解析 | `packages/engine-ytdlp/src/progress-parser.ts` / `progress-template.ts` |
| 产物校验（C1–C12） | `packages/core/src/artifact-verifier/` + `engine-ytdlp/src/artifact-manifest.ts` |
| 错误码与中文提示 | `packages/shared/src/errors.ts` + `packages/core/src/error-mapper/` |
| 错误报告文本 | `packages/core/src/error-report/error-report.ts` |
| 设置项读写、默认值 | `packages/core/src/config-store/`（`defaults.ts` 是默认值） |
| 便携模式 / 数据目录判定 | `apps/desktop/src/main/data-dir.ts` |
| 日志落盘 | `packages/core/src/logger/` + `apps/desktop/src/main/electron-entry.ts` |
| 托盘、窗口、单实例 | `apps/desktop/src/main/tray.ts` / `electron-entry.ts` |
| 应用自更新（检查/下载/静默装） | `apps/desktop/src/main/app-updater.ts` + `adapters/electron-updater-adapter.ts` + `electron-builder.yml` 的 `publish` |
| yt-dlp / aria2c 组件更新 | `packages/engine-ytdlp/src/self-updater.ts` + `apps/desktop/src/main/component-updater.ts` |
| 打包产物（安装包/便携） | `apps/desktop/electron-builder.yml` |

---

## 4. IPC 契约：两处必须对齐（踩过两次坑）

渲染层调用 **符号名**，preload 白名单校验 **线缆字符串**。两者在
`packages/ui/src/pages/queue/queue.js::CHANNELS`、`task-detail.js::CABLE`、
`packages/ui/src/ipc-bridge.js::CHANNEL_STRINGS` 里做映射，漏一处就是「按钮点了没反应」。

| 符号名 | 线缆字符串 | 方向 |
|---|---|---|
| `DOWNLOAD_START` | `ytvdlt:download:start` | 渲染 → 主 |
| `TASK_LIST` | `ytvdlt:task:list` | 渲染 → 主 |
| `TASK_DETAIL` | `ytvdlt:task:detail` | 渲染 → 主 |
| `TASK_ACTION` | `ytvdlt:task:action` | 渲染 → 主 |
| `PROBE` / `PROBE_PLAYLIST` | `ytvdlt:probe` / `ytvdlt:probePlaylist` | 渲染 → 主（**仍是 fixture**） |
| `DIALOG_CONFIRM` | `ytvdlt:dialog:confirm` | 渲染 → 主（**仍是 fixture**） |
| `COMPONENT_STATUS/UPDATE` | `ytvdlt:component:status` / `:update` | 渲染 → 主 |

另外两条约束：

1. **payload 键白名单**：`m5-channels.ts::PAYLOAD_KEYS` 只放行登记过的键，多一个键直接抛错。
2. **URL 脱敏**：`TASK_LIST` 不返回 URL；`TASK_DETAIL` 返回 `maskUrlSecrets()` 后的 URL。新增字段时别把原始链接带出去。

---

## 5. 数据落在哪

| 运行形态 | 配置 / 日志 |
|---|---|
| 安装版 & 便携版（exe 目录可写） | `<exe目录>\config\config.json`、`<exe目录>\logs\app-YYYYMMDD.jsonl` |
| 安装到 `C:\Program Files`（不可写） | `%APPDATA%\YTVDLT\config\…`（`data-dir.ts` 会写探针文件实测可写性） |
| 默认下载目录 | `%USERPROFILE%\Downloads\YTVDLT`（**运行时展开，见 §7 坑 3**） |

`config/config.json` 按域组织：`general / format / subtitle / paths / network / advanced`。
`config/tasks.json` 是队列快照（崩溃后可恢复）。

---

## 6. 脚本一览

| 脚本 | 用途 |
|---|---|
| `scripts/build-desktop.mjs` | esbuild 打包主进程 + preload，拷贝 `packages/ui/src` 到 `apps/desktop/dist`。**改前端后必须先跑它** |
| `scripts/make-icon.mjs` | 生成 `icon.ico` |
| `scripts/run-tests.mjs` | vitest 封装（`all --coverage` / `unit` / `contract` / `integration`） |
| `scripts/run-e2e.mjs` | 30 张 PNG + DOM 基线对比，含 5 个反例（基线被篡改必须报错） |
| `scripts/acceptance.mjs` | 五套里程碑验收（M1–M5），产出 `reports/acceptance-report-m*.json` |
| `scripts/handoff-check.mjs` | 把交接文档里的数字与仓库现状对账（决策编号、覆盖率、PASS 数） |
| `scripts/l3-smoke.mjs` | 打包应用的在线烟测（CDP 驱动真实 IPC，6 场景） |
| `scripts/check-layering.mjs` | 分层依赖检查（core 不许 import node:*） |
| `scripts/frozen-gate.mjs` | 冻结门控（`request.ts` 逐字节、package.json 白名单） |
| `scripts/verify-artifact.mjs` | 单个媒体文件的产物校验（C1–C12） |

---

## 7. 五个必须知道的坑（都踩过，别再踩）

1. **先 `build-desktop.mjs`，再 `electron-builder`**。前者生成 `apps/desktop/dist`，后者只是把它塞进 asar。顺序反了，包里就是上一版前端（0.1.6 的临版本就这么废掉的）。
2. **electron-builder 会就地改写根 `package.json`**：丢掉 `scripts` / `devDependencies`、写入 `main`。打包后必须 `git checkout -- package.json apps/desktop/package.json`。带 `publish` 块时它还会把包内 `package.json` 的 `main` 弄丢，靠 `extraMetadata.main` 钉住（D-75）。
3. **用户路径里的 `%USERPROFILE%` 必须运行时展开**：`spawn` 不经过 shell，没人展开 `%VAR%`，否则会生成一个字面量 `%USERPROFILE%` 目录并导致 `ARTIFACT_INCOMPLETE`（D-79，`m4-host.ts::withExpandedPaths`）。
4. **`preventDefault()` 会吃掉表单提交**：判断顺序写反，按钮就完全没反应（D-78）。凡是「按钮点了没反应」，先查是否依赖了浏览器的隐式行为（表单提交 / label 转发 / 默认按钮）。
5. **验证要用真实输入事件**：`Input.dispatchMouseEvent` + `Input.insertText`，不要用 `dispatchEvent(new Event('submit'))`。合成事件绕过按钮本身，会稳定地骗过测试（D-76 假通过、D-78 才暴露）。

---

## 8. 已知未完成（接手时别当成 bug）

| 项 | 状态 | 位置 |
|---|---|---|
| 播放列表批量对话框 | 仍是 fixture 渲染，未接 `PLAYLIST_ENQUEUE` | `packages/ui/src/pages/queue/playlist-batch.js` |
| 格式选择对话框 | 仍读录制 JSON（`PROBE` 是 fixture），所以「粘贴并解析」= 用默认设置直接入队 | `packages/ui/src/dialogs/` |
| 日志页 / 设置页 | 未逐页复审是否已接真实 IPC | `packages/ui/src/pages/task-log/`、`settings/` |
| 错误报告里的 `Engine: unknown` | 字段没填引擎版本（展示缺陷） | `packages/core/src/error-report/` |
| 自更新会清空便携模式数据 | NSIS 更新安装清空 `$INSTDIR`，而便携数据就在 exe 同目录（D-75 缺陷项） | 需迁出数据目录或自定义 NSIS 脚本 |
| 干净机验收 C13–C16 | 未做（需在无 Python/Node/FFmpeg 的 VM 里跑） | `docs/M5-VM-CHECKLIST.md` |
| `A-4.4-28/29` 验收 | 维持 `SKIPPED`（真实能力已完成，但按规则不改判） | `scripts/acceptance.mjs` |

---

## 9. 排错入口

1. **看日志**：`<exe目录>\logs\app-YYYYMMDD.jsonl`，按 `level` 过滤（`ERROR` / `WARNING`）。`scope` 字段说明模块（`engine.probe` / `app-update` / `data-dir` / `task-queue`）。
2. **看错误码**：`packages/shared/src/errors.ts` 的 17 个码，对应中文提示在 `core/error-mapper/`。
   - `ARTIFACT_INCOMPLETE` → 产物校验没过（看 `artifact manifest` 内容）
   - `PERMISSION_DENIED` → 目录不可写（看清单路径是否落到盘根）
   - `EJS_FAILED` / `NETWORK_TIMEOUT` → YouTube 侧 JS challenge 或网络
3. **手动复跑一次下载并校验**：`node scripts/verify-artifact.mjs <文件路径>`
4. **UI 层验证**：`node reports/l3-probe/ui-drive.mjs <URL>`（需要先用 `--remote-debugging-port=9222` 启动打包后的 exe）。

---

## 10. 相关文档索引

| 想了解 | 看哪份 |
|---|---|
| **本版交付了什么、验收怎么过的、事故怎么发生的** | `docs/DELIVERY-REPORT.md` |
| 做过哪些决策、为什么这么定 | `docs/DECISIONS.md`（D-01…D-81，最新在最后） |
| 每个版本产出了什么、为什么被淘汰 | `docs/BUILD-HISTORY.md` |
| 打包步骤与环境 | `docs/BUILD.md` |
| 验收口径 | `docs/ACCEPTANCE.md` |
| 里程碑交接 | `docs/M5-HANDOFF-V5.md`（最新） |
| 当前已知阻塞 | `docs/BLOCKED-2026-11-07.md` |
| 架构设计演进 | `docs/ARCHITECTURE-M1/M2/M3.md` |

---

## 11. 检索模板（先搜，别猜）

| 想找什么 | 命令 |
|---|---|
| 某个 IPC 通道的实现 | `grep -rn "ytvdlt:task:action" apps packages` |
| 某个按钮的绑定 | `grep -rn "data-action=\"cancel\"" packages/ui/src` |
| 某个错误码从哪来 | `grep -rn "ARTIFACT_INCOMPLETE" packages` |
| yt-dlp 参数怎么拼 | `grep -rn "\-\-print-to-file\|--download-sections" packages/engine-ytdlp/src` |
| 默认配置项 | `sed -n '1,80p' packages/core/src/config-store/defaults.ts` |
| 某个决策为什么这么定 | `grep -n "D-79" -A 20 docs/DECISIONS.md` |
| 哪些地方碰了文件系统 | `grep -rn "ports.fs\." packages/core/src \| head -30` |
| 有没有偷偷 import node 内建 | `node scripts/check-layering.mjs` |

---

## 12. 冷启动清单（10 分钟内建立判断）

1. 跑 §0 的三条自证命令，确认版本与提交。
2. 读 §3 对照表，找到你被指派的功能对应文件（不要通读全仓）。
3. 跑一次 `node scripts/handoff-check.mjs`，看当前数字是否自洽。
4. 需要真机验证时：先 `node scripts/build-desktop.mjs`，再按 §0.5 第 6 步打包。
5. 有疑问先看 `docs/BUILD-HISTORY.md` 的版本时间线——很多「奇怪现象」是旧版本遗留，不是新 bug。

---

## 13. 这份文档本身的维护

- 新增/删除文件、改分层、改 IPC 通道、改构建步骤时，**同步改本手册**。
- 本手册不写「预计」「大概」，只写**可验证的事实**（路径、命令、文件名）。
- 若某个数字无法当场复现，删掉它，而不是保留一个可能过期的值。

