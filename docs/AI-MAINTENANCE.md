# AI 维护手册（YTVDLT Desktop）

> 给下一个接手的人／AI：不看任何历史报告，也能在十分钟内知道
> **项目是什么、文件夹干什么、改哪个文件、先排查哪里、改完怎么验、验完交什么**。
>
> **本手册只写不会过期的结构知识**：路径、命令、规则、契约、分诊顺序。
> 版本号、测试数、覆盖率、PASS 数、交付状态、某版实测结论一律**不写**——它们每天在变，
> 抄进来就必然腐烂。版本流水在 `CHANGELOG.md`，决策原文在 `DECISIONS.md`。
>
> 平台：Windows 10/11 x64（Electron 45 + yt-dlp 随包）。
> 一句话：**Electron 桌面下载器；前端零依赖静态页，主进程只做编排，真正的下载交给随包的 yt-dlp。**

---

## 0. 维护铁律

**每次改完代码，必须在回复末尾输出「修改文件清单」**（业主据此提交）：

```
### 修改文件清单
| 文件 | 改动 | 影响 |
|---|---|---|
| packages/ui/src/pages/queue/queue.js | 修 X | 队列页按钮 |
| docs/DECISIONS.md | 追加 D-xx | 决策记录 |
（未改动的不列；新增文件标「新增」）
```

1. **不要动 `packages/shared/src/request.ts`**（D-50 冻结，逐字节锁定）。
2. **不要往 `devDependencies` 加新依赖**（D-61 白名单只允许 `electron-builder` / `electron-updater`）。
3. **不要改 `apps/desktop/electron-builder.yml` 的 `files` glob**。要加文件进包，走 `extraResources` 或用 esbuild 内联（D-75）。
4. **不要在别人的原稿／文档里加「由 AI 生成」之类声明。**
5. **改行为必须留决策记录**：`docs/DECISIONS.md` 追加 `## D-<下一编号> · 日期 · 标题`，写「现象／根因／决策／验证／未覆盖」。
6. **不要把 `SKIPPED` 改成 `PASS`**，除非前置条件真做完了。
7. **删除文件只能进回收站，禁止永久删除**（细则见 §0.1）；应用内「同时删除本地文件」也必须走 `shell.trashItem`。
8. **改 UI 后不得全量覆盖截图基线，也不得改结论迁就新 UI**：按 §7 的「按 case 重建」流程做，并在 `DECISIONS.md` 写明重建范围。
9. **默认只打安装版**（`--win nsis`）。便携版与更新清单属点名项，业主说「打包」才跑；不要主动打包（一次约 5 分钟）。
10. **改了本手册或 `BUILD-HISTORY.md` 要同步外层阅读副本**：业主在 `C:/Users/leolee/Desktop/YTVDLT/docs/` 放了副本，两边不一致会让人拿着旧规则干活。
11. **版本号按 §7 的十进制进位规则取**，任一段都不写两位数；发版前查 `CHANGELOG.md` 确认下一版号。
12. **维护完成后不要主动推送仓库或发布 Release**。等业主明确说「上传仓库」/「发布 release」再执行；执行后把仓库地址、分支、提交号与上传方法一起交给业主或下一位接手者（见 §11）。推送和发布是对外动作，不是收尾的自动步骤。
13. **`README.md` 与 `README.zh-CN.md` 必须同时改**（D-100）：英文是默认门面，中文是镜像，两份章节一一对应、顶部各有语言切换行。只改一份等于制造两种真相；`docs/assets/` 里的截图随之更新时也要确认两份引用一致。
14. **GitHub Release 说明一律用英文**：Release 页面是仓库门面，面向国际读者；中文只写进 `CHANGELOG.md` / `DECISIONS.md` 这类内部文档。发版时把英文说明贴进 Release，不要把中文正文直接发出去（`DECISIONS.md` 里的 D-xx 编号可以保留，作为可追溯的括注）。

### 0.1 删除文件的规定（一次真实事故换来，不可协商）

事故：迁移目录时未校验就 `Remove-Item -Force` 清理残留，把 `.git` 与根目录配置永久删除，
`LICENSE` 和 git 历史至今未找回。`Remove-Item -Force` / `rm -f` **不进回收站**。

任何删除必须同时满足：

1. 只能进回收站：用 `Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile/DeleteDirectory` +
   `RecycleOption.SendToRecycleBin`。**禁止** `Remove-Item -Force`、`rm -f/-rf`、`rd /s /q`、`shutil.rmtree`。
2. 先备份到项目外临时位置，确认新位置可用再删。
3. 移动/复制后**校验再删源**：核对文件数与 `package.json`、`.git/HEAD`、`LICENSE` 存在。
4. 单次删除 ≤ 50 个文件（本机 safe-delete 守卫阈值）。
5. 删前列完整路径给业主确认，尤其 `.git`、`LICENSE`、`docs/`、`resources/`。
6. 构建产物（`dist-*/`、`coverage/`、`node_modules/`）虽可再生，**同样走回收站**。

---

## 1. 先自证，再看文档

```bash
ls package.json pnpm-workspace.yaml turbo.json apps packages scripts   # 缺一个就说明目录不对
git log -1 --oneline                                                 # 最近一次提交
node -e "console.log(require('./package.json').version)"              # 仓库版本（打包后回到发版基准）
```

**事实来源优先级（冲突时按此采信）**

1. 代码本身（`grep` 出来的实现）
2. 当场跑出来的结果（`npm test` / `run-e2e.mjs` / `handoff-check.mjs`）
3. 代码注释里的决策编号 `D-xx`
4. `docs/DECISIONS.md`
5. `docs/*-REPORT.md`（历史快照，**大概率已过期**）

文档里的数字一律只是当日快照，引用前现跑一次。`node scripts/handoff-check.mjs` 会把文档数字
和仓库现状对账；**它报不一致就是文档旧了，改文档，不要改结论**。

---

## 2. 目录地图（每个文件夹干什么）

```
ytvdlt/
├── apps/desktop/                  # Electron 唯一可执行外壳
│   ├── src/main/                  # 主进程：窗口、托盘、菜单、IPC 编排、宿主装配
│   ├── src/preload/               # contextBridge 白名单（渲染层唯一出入口）
│   ├── src/main/adapters/         # 真实 node/electron 能力注入（CorePorts 实现）
│   ├── electron-builder.yml       # 打包配置：files / extraResources / nsis / publish / 图标
│   ├── build/icon.ico             # 应用 / 安装包 / 快捷方式图标（由脚本生成）
│   └── dist/                      # 【生成】build-desktop 产物，会被打进 asar
├── packages/
│   ├── shared/                    # 纯类型 + 常量：IPC 通道、请求/任务/错误/更新契约
│   ├── core/                      # 纯逻辑（禁 node:*）：队列、校验、路径、配置、错误映射
│   ├── engine-ytdlp/              # yt-dlp 适配：argv、进度解析、产物清单、子进程启动环境
│   └── ui/src/                    # 零依赖静态前端：pages / styles / shell / i18n / theme / dialogs / about
├── resources/runtime/win-x64/     # 随包二进制：yt-dlp / ffmpeg / aria2c / node（不进 git）
├── scripts/                       # 构建、测试、验收、烟测脚本（见 §7）
├── tests/                         # unit / contract / integration / e2e（截图基线在 e2e/baselines）
├── docs/                          # 设计、决策、里程碑报告、本手册、版本流水
├── reports/                       # 【不入库】本地证据：烟测 JSON、截图、日志
└── dist-<version>/                # 【不入库】当前交付包（Setup + blockmap + latest.yml）
```

**依赖方向（单向，`check-layering.mjs` 会拦）**

```
ui（零依赖） ← preload ← apps/desktop
                 ↑
      shared ← core ← engine-ytdlp
```

`core` 里禁止 `node:fs` / `node:child_process` / `electron`；外部能力一律经 `CorePorts` 注入。

---

## 3. 功能 → 代码位置（最常改的重点文件）

| 要改的功能 | 先打开 |
|---|---|
| **所有出站 HTTP（重定向逐跳校验 / 有界读取 / 私网拦截 / DNS 钉扎）** | `apps/desktop/src/main/adapters/http-policy.ts`（URL 策略 + 手工跟随重定向 + **每跳解析钉扎**，**唯一事实来源**）→ `adapters/node-ports.ts::httpPort()`（流式字节上限 + 全程单一 deadline）→ `adapters/http-download.ts`（安装包下载）；`shared/src/ports.ts::HttpFetchOptions` 是 append-only 的可选参数契约。缩略图在 `main/thumbnail-cache.ts::fetchAndStore` 传 `maxBytes` + `isPublicHttpsUrl`，更新器在 `main/app-update-service.ts` 传 `hostPolicy: isTrustedReleaseHost`。D-137；**D-143：传输层是 `node:http(s)`，每一跳先解析 hostname 全部地址、逐个过 `RedirectPolicy.allowResolvedAddress`（私网/保留地址 fail-closed），再把 socket 钉在已验证地址上（SNI/证书/Host 仍用原 hostname）；新增出站请求必须走 `fetchFollowingRedirects`，直用 `fetch` 既绕过策略、测试里 `globalThis.fetch` stub 也已失效**；**D-152**：`isPublicIpv6` 改白名单（仅 `2000::/3` 且排除六段 IANA 特殊用途前缀），`isPrivateIpv6` 取补集，URL 字面量路径与解析地址路径共用同一分类不漂移；`::ffff:0:0/96` 解包末 32 位复用 IPv4 判断 |
| **IPC 调用者 / 导航信任边界** | `main/bootstrap.ts::assertTrustedIpcSender`（纯函数：sender === 本窗口 webContents、主 frame、可信本地页）、`isTrustedLocalPage`、`will-navigate` 与 `setWindowOpenHandler`；单测在 `tests/unit/ipc-trust-boundary.test.ts`。D-137 |
| 队列页：渲染、轮询、按钮、语言切换、任务管理、全屏 | `packages/ui/src/pages/queue/queue.js` + 同目录 `index.html`（版式与内联 CSS） |
| 所有界面文案（中/英） | `packages/ui/src/i18n/messages.js`（双语键集合必须一致）、`i18n/i18n.js`；**首启语言检测（D-147）**：`bootstrap.ts::resolveStartupLanguage`（纯函数）+ 空串哨兵 `general.language: ''`——首次启动检测一次并经 `SETTINGS_SET` await 写回，之后永不重检测；`readRawLanguage` 走 config 端口（`readAppearance` 会把 `''` 归一化，哨兵只能从端口观察） |
| **「去 Star」引导（按版本 ≤2 次）** | `core/src/star-prompt/policy.ts`（纯策略：第 3 次启动才问、每版本 ≤2、later 后 7 天间隔、star/never 永久安静、升级重置，时间注入）→ `main/star-prompt-service.ts`（启动计数 + 动作落库 + openExternal 开仓库常量）→ `m5-channels.ts::STAR_PROMPT_CHECK/ACTION` → `queue.js`（live-only 动态弹窗：首个真实 `TASK_LIST` 后 45 s 且无进行中任务、每会话一次 CHECK）；状态在 `advanced.starPrompt*` 五键。D-148 |
| 版本号 / 关于弹窗 / 许可声明 | `apps/desktop/src/main/main.ts`（首帧 `?v=` 提示）、`packages/ui/src/shell/app-version.js`（**唯一真相链**：`?v=` 提示 → `APP_INFO` 覆盖 → 无值显示 `v—`）、`packages/ui/src/about/about.js`（紧凑弹窗）、`packages/ui/src/pages/settings/index.html`（`#section-about`：主许可 + 组件许可表 + 根 `LICENSE` 英文部分**逐字内嵌**）、`LICENSE`（主许可唯一真相，改它必须同步内嵌副本，`about-licence.test.ts` 会拦）；**本软件是 source-available 非商业许可，不是开源、不是 MIT，文案不得写成「开源许可」** |
| 主题、强调色、动效 | `packages/ui/src/theme/theme.js`、`styles/theme.css`；共享基线样式 `styles/ytvdlt.css` |
| 应用菜单（文件/编辑/视图/窗口/设置） | `apps/desktop/src/main/app-menu.ts`（纯数据）→ `bootstrap.ts` 安装与重建 |
| 窗口、托盘、单实例、菜单跳转、关闭清理 | `apps/desktop/src/main/bootstrap.ts` |
| 生产依赖装配、回收站删除、无痕清理、真实入口 | `apps/desktop/src/main/electron-entry.ts` / `main.ts` |
| IPC 通道白名单、payload 校验、设置读写 | `apps/desktop/src/main/m5-channels.ts`；装配在 `m5-host.ts` / `m4-host.ts` |
| 粘贴入队、格式选择落到下载请求 | `m5-channels.ts` → `m4-host.ts::applyFormatChoice` / `enqueueSingle` |
| 下载计划、清晰度、音频码率、私有模式 | `packages/core/src/decision/download-plan.ts`、`config-store/defaults.ts` |
| **下载中间文件（`.part` / `.part-FragN.part` / `.ytdl`）落在哪** | `core/src/path-resolver/volume.ts::resolveDownloadTempDir`（同卷才用私有 work 目录，否则 `<outputDir>/.ytvdlt-incomplete/<taskId>`）→ `main/m4-host.ts::resolveTempDirFor`（写进 `request.paths.tempDir`）→ `engine-ytdlp/src/argv-builder-download.ts`（`-P temp:`）+ `yt-dlp-engine.ts`（cwd、manifest、成功后 `rmdir` 空目录） |
| **子进程 TEMP / `_MEI*`** | `engine-ytdlp/src/yt-dlp-engine.ts::spawnBase` —— cwd 钉在可写目录，**TEMP 一律不再覆盖**（`_MEI` 必须留在系统临时目录，见 §9 坑 20） |
| yt-dlp 参数、进度、产物清单 | `packages/engine-ytdlp/src/argv-builder-download.ts`、`progress-parser.ts`、`artifact-manifest.ts` |
| **下载后处理阶段（合并 / 整理 / 校验）** | `packages/engine-ytdlp/src/postprocess-parser.ts`（stderr 方括号标记 → `merging` / `postprocess`）→ `core/src/task-queue/task-queue.ts`（`lastStage`，单调推进，校验前置 `verifying`）→ `main/m5-channels.ts::toTaskListItem`（`stage`）→ `ui/src/pages/queue/queue.js::progressMode`（`working`）/ `stageText`；顺序规则在 `shared/src/events.ts::isForwardStage` |
| **子进程启动环境（cwd / TEMP / PATH）** | `packages/engine-ytdlp/src/yt-dlp-engine.ts::spawnBase` —— 任何新 spawn 都从这里取 |
| **有界元数据子进程的输出硬上限（`probe` / `probePlaylist` / `version`）** | `shared/src/ports.ts::SpawnOptions.maxStdoutBytes / maxStderrBytes`（append-only 可选字段，字节数）→ `apps/desktop/src/main/adapters/output-limiter.ts::createBoundedOutput`（按**字节**累加：对每个到达的 `Buffer` 分片取 `chunk.byteLength`，**不是** `string.length`；超限保留已接受前缀、拒绝剩余分片且**不抛异常**；超限在 stderr 追加 `OUTPUT_LIMIT_MARKER`）→ `shared/src/engine-limits.ts`（`METADATA_MAX_STDOUT_BYTES = 16 MiB` / `METADATA_MAX_STDERR_BYTES = 1 MiB`）；`assertSafeSpawnOptions()` 拒绝非正整数上限。**正常下载一个字节上限都不加**（不杀进程；D-144 起其**诊断副本**改为 1 MiB 尾缓冲 `STREAM_TAIL_MAX_BYTES` + `STREAM_TAIL_TRUNCATED_MARKER`，实时 `onChunk` 进度依旧全量不限），长下载照旧可流式吐兆字节进度。超限与超时**都走 `killTree()`**（`taskkill /PID /T /F`，见 §9 坑 21）。**D-153**：`spawnStreaming` 的 stdout 行拼装缓冲 `pending` 按字节封顶 `PROGRESS_PENDING_MAX_BYTES`（1 MiB），丢最旧前缀、结束统一记一条 WARNING，无换行 chunk 走 fast-path。**D-156**：`SpawnOptions.signal`（append-only，结构化 `SpawnAbortSignal`）触发时走同一 `killTree()` + 有界等待退出证据；只供有界元数据 / URL 预检任务，正常下载不传 signal。D-133 / D-144 / D-153 / D-156 |
| 产物校验、错误码与中文提示、错误报告 | `core/src/artifact-verifier/`、`shared/src/errors.ts`、`core/src/error-mapper/`、`error-report/`；列表页一句话失败简报（D-109）：`core/src/failure-summary/`（稳定码→分类）→ `main/m5-channels.ts::toTaskListItem`（`failureKind`）→ `ui/src/pages/queue/queue.js::failureKeyOf`（`queue.failure.<kind>`），详情 DTO 不动 |
| 队列调度、并发、暂停、历史快照 | `core/src/task-queue/`、`task-store/`；数据目录判定在 `data-dir.ts` |
| 详情页、日志页、设置页、M3 三个对话框 | `packages/ui/src/pages/*`、`packages/ui/src/dialogs/*` |
| 打包配置、图标、安装包 | `apps/desktop/electron-builder.yml`、`scripts/make-icon.mjs`、`apps/desktop/build/installer.nsh` |
| **应用本体更新（检查 / 说明弹窗 / 下载校验 / 安装 / 忽略版本）** | `main/app-update-service.ts`、`main/github-releases.ts`、`main/adapters/http-download.ts`；纯规则在 `core/src/app-update/`（`notes.ts` = 跨版本说明聚合）；弹窗在 `ui/src/updates/update-dialog.js`。D-104：缓存复用与安装前都重算 SHA-256，基准为发布 `digest` 或 `<target>.sha256` sidecar，失败只隔离不删。**D-140：说明面必须覆盖 `(current, latest]` 整段区间**——`/releases/latest` 只回答「有没有新版」，弹窗文案来自 `/releases?per_page=30` + `collectReleaseNotes()`（升序、单版 1400 / 总量 6000 字符、超预算从最旧端丢并计数）；历史查询失败只降级成单版正文，**不允许**把一次成功的检查变成 `error` |
| **yt-dlp 组件更新（版本查询 / 换文件 / 自动检查）** | `main/component-updater.ts`（`feedUrl` / `versionApiUrl`）、`engine-ytdlp/src/self-updater.ts`；**D-154**：三入口（版本查询 / 清单校验 / 二进制下载）全部接入 `componentSourceUrlPolicy`——GitHub 系复用 `isTrustedReleaseHost` 严格白名单 + 逐跳校验 + DNS 地址钉扎，操作者显式配置的镜像允许任意 http(s) 跳但传输层守卫无条件保留（经 `HttpFetchOptions.urlPolicy` 接线，shared 未改） |
| **队列进度（总大小 / 速度 / 剩余时间 / 未知 vs 0%）** | `core/src/task-queue/task-queue.ts`（progress 分支）→ `main/m5-channels.ts::toTaskListItem`（`percent` 可为 `null`）→ `ui/src/pages/queue/queue.js::progressMode`（`value / unknown / none / waiting`）→ `progressText` / `waitBar`；`null` 一律不得写成 0（D-107）。刷新节奏与整表重绘的分离见 `queue.js::paintKey` / `progressKey` / `patchProgress`（D-112） |
| **进度行到底有没有数据（外置下载器）** | `main/m4-host.ts::resolveAria2cPath`（默认 `null` = 用 yt-dlp 自带下载器）；`engine-ytdlp/src/yt-dlp-engine.ts` 的 chunk 处理与 64 KiB 元数据过滤（D-111 / D-112） |
| **队列封面缩略图** | `main/thumbnail-cache.ts`、`main/m5-channels.ts::ThumbnailPort`、`queue.js::thumbNode` |
| **封面缓存清理（占用 / 自动清理 / 立即清理）** | `core/src/thumbnail-cache-policy/`（纯策略）→ `main/thumbnail-cache.ts`（`index.json` / `status()` / `prune()`）→ `main/m5-channels.ts::THUMBNAIL_CACHE` → `ui/src/pages/settings/settings.js::installCacheControls()`；配置在 `advanced.autoCleanThumbnailCache` / `thumbnailCacheMaxBytes` / `MaxFiles` / `MaxAgeDays` |
| **下载位置（视频 / 音频目录）** | `ui/src/pages/settings/*`（`#section-paths`）→ `main/m5-channels.ts::PATH_ACTION` → `core/config-store/defaults.ts::DEFAULT_PATH_TOKENS`；原生对话框在 `main/adapters/path-picker.ts` |
| **设置页分区目录 + 滚动联动** | `ui/src/pages/settings/index.html`（`.settings-shell` / `.settings-nav` / `.settings-scroll`）、`settings.js::installSectionNav()` |
| 截图基线用例 | `scripts/e2e-cases.mjs`、`tests/e2e/baselines/` |
| **全局导航 / 返回下载队列 / 队列视图状态** | `packages/ui/src/shell/app-nav.js`（导航条注入、`saveView/restoreView`）、`pages/queue/queue.js::saveView/restoreView` |
| **全屏唯一真相（菜单 / 按钮 / 所有页面）** | `apps/desktop/src/main/bootstrap.ts`（`WINDOW_FULLSCREEN` handler + 事件推送）、`main/app-menu.ts`（F11 click）、`ui/src/shell/app-nav.js`（按钮与 Esc） |
| **主题 / 强调色 / 动效全局状态与持久化** | `packages/ui/src/theme/theme.js`（`set/sync/listen/state`）、`pages/settings/settings.js`、`main/m5-channels.ts::SETTINGS_GET/SET` |
| **本地文件状态探测 / 删除任务时文件已不存在 / 打开文件与打开文件夹反馈** | `apps/desktop/src/main/local-file-status.ts`（errno 分类 + 短 TTL 缓存 + force 重查）、`apps/desktop/src/main/adapters/local-file-status-port.ts`（真实 `stat` + 幂等回收）、`main/m5-channels.ts::TASK_ACTION` / `TASK_LIST`、`core/src/task-detail/task-detail.ts::open`、`ui/src/pages/queue/queue.js::fileStateKey` / `openActionMessage` / `performRemoval`；卡片「打开文件」按钮**只在 live 模式注入**（静态预览不注入，保住冻结基线）；原理见 §9 坑 22 |
| **响应式布局（视口宽高驱动）** | `packages/ui/src/styles/layout.css`（`--ui-step` + 高特异性覆盖）；`ytvdlt.css` 仍是 M3 固定画幅，**不要改它** |
| **TXT 清单批量导入（选文件 / 预览 / 确认入队）** | `packages/core/src/txt-import/parse.ts`（纯解析，URL 校验由外层注入）→ `apps/desktop/src/main/txt-import-service.ts`（一次性票据 + 真实计数）→ `apps/desktop/src/main/adapters/txt-file-picker.ts`（原生选择器 + 读）→ `main/txt-import-file.ts`（扩展名 / 大小 / 严格 UTF-8 纯解码）→ `m5-channels.ts::TXT_IMPORT_PICK/ENQUEUE` → `m4-host.ts::enqueueTxtBatch` → `TaskQueue.enqueueBatch()`；UI 在 `packages/ui/src/txt-import/txt-import.js`（**仅 live 模式注入**，静态基线不受影响） |
| **播放列表批量下载（自动识别 / 预览 / 默认全选 / 一次确认）** | `core/src/playlist/preview-cache.ts`（票据）→ `apps/desktop/src/main/playlist-preview-service.ts`（真 `engine.probePlaylist()` + 脱敏 DTO）→ `m5-channels.ts::PLAYLIST_PREVIEW / PREVIEW_CANCEL / BATCH_ENQUEUE` → `m4-host.ts::runPlaylistBatch` → `buildPlaylistBatchRecordsByUrl()` → `TaskQueue.enqueueBatch()`；UI 在 `packages/ui/src/playlists/playlist-import.js`（**仅 live 模式注入**）。M3 fixture 对话框 `dialogs/playlist-selector.js` 与 `pages/queue/playlist-batch.html` 保持冻结不动 |
| **内嵌字幕后按 `keepSubtitleFile` 清理外置副本** | `core/src/task-queue/task-queue.ts::discardEmbeddedSubtitleArtifacts`（本任务字幕清单 + 媒体归属 / 语言段 / 其它任务引用三重校验）→ `main/m5-host.ts::makeSubtitleRecycler` → `main/adapters/local-file-status-port.ts::createTrashFilesPort` → `shell.trashItem`（D-131；**删除只进回收站**） |
| **支持的网站列表（引擎自述 / 搜索 / 排序 / GenericIE 说明）** | `engine-ytdlp/src/extractor-list.ts::parseExtractorList`（纯解析 `--list-extractors`，**唯一事实来源，无兜底名单**）→ `engine-ytdlp/src/yt-dlp-engine.ts::listExtractors` → `engine-ytdlp/src/site-discovery.ts`（可选能力接口 `SiteDiscovery` + `supportsSiteDiscovery()`，**不扩冻结的 5 方法 `DownloadEngine`**）→ `main/site-support-service.ts`（缓存身份 = 引擎路径 + 版本，自更新后 key 变化即失效）→ `m5-channels.ts::SUPPORTED_SITES`（投影 DTO，**丢 `enginePath`**）→ `ui/src/sites/supported-sites.js`（**仅 live 模式注入**，静态基线不受影响；文件内无任何写死站点名）。D-134 |
| **URL 支持状态预检（六态模型，仅「明确不支持」拦截）** | `engine-ytdlp/src/extractor-list.ts::classifySupportFailure` / `extractorClaimedUrl`（纯函数，按真实 stderr 分类）→ `engine-ytdlp/src/yt-dlp-engine.ts::checkUrlSupport`（`--simulate`，默认 20 s，**永不抛异常**）→ `main/site-precheck-gate.ts::precheckBatch`（**三个入口共用的唯一定义**：worker 池并发 3、in-flight 去重、重复不折叠、超预算放行并记 `skipped`）→ `m5-channels.ts`（单 URL 在 `DOWNLOAD_START` **花掉字幕票据之前**拦截；`PLAYLIST_BATCH_ENQUEUE` 按条目预检）与 `main/txt-import-service.ts`（TXT 批量预检）。六态：`SUPPORTED / UNSUPPORTED / NO_MEDIA / INDETERMINATE / TIMEOUT / CANCELLED`，**只有 `UNSUPPORTED` 拦截**（`shared/src/site-support.ts::blocksEnqueue`），**门禁 fail open**。⚠️ `generic`（GenericIE）会认领一切 http(s) URL，故引擎的裸 `ERROR: Unsupported URL:` 是「认领了但无媒体」= **NO_MEDIA（放行）**，不是 UNSUPPORTED。**D-156（可取消）**：`URL_SUPPORT_CHECK_CANCEL`（零 payload，abort 所有在途预检）/ `URL_SUPPORT_CHECK_STATUS`（只读进度轮询）两通道；`AbortSignal` 贯穿 `SpawnOptions.signal` → `node-ports` `killTree` → `checkUrlSupport` → `SiteSupportService` → `precheckBatch`，三个入口（单 URL / TXT / 播放列表）取消即不入队并回带 `cancelled`；`CANCELLED` 落 `indeterminate` 桶、门禁仍 fail-open；UI 全部 live-only 动态 DOM（坑 30），静态截图基线零改动。D-134 / D-156 |

---

## 4. 常见问题：先排查这几处（分诊表）

> **这是分诊顺序，不是排除法结论。** 像看感冒先抽血：先验高概率、低成本的原因，
> **但前几项排除后必须继续按 §1 的事实来源优先级查代码、查日志、查端口注入**，
> 不能因为「常见的都查过了」就下结论。

| 现象 | 按顺序先查 | 为什么先查它 | 排除后继续 |
|---|---|---|---|
| **按钮点了没反应** | ① 符号名 ↔ 线缆字符串三处映射（§5）② `preventDefault()` 顺序 / 隐式表单提交 ③ live 与 fixture 分支走错 ④ 是否用合成事件「验证」过（会假通过） | 这三类各造成过一次真实事故；成本最低 | 查主进程 handler、`PAYLOAD_KEYS` 白名单、端口是否注入 |
| **下载失败 / 出现错误码** | ① `logs/app-*.jsonl` 里 `ERROR` 与 `scope` ② stderr 原文 ③ `error-mapper` 映射 ④ 产物 manifest 是否为空 | 错误码只是翻译结果，stderr 才是一手证据 | 再查 argv、下载计划、校验器、网络 |
| **装到 `C:\Program Files` 报 `PERMISSION_DENIED` / `tmp*.tmp`** | ① 子进程是否走 `spawnBase()` 拿到可写 `cwd` + `TEMP/TMP/TMPDIR` ② 配置目录是否已回落 `%APPDATA%` ③ 输出目录是否绝对且可写 | 这是启动环境缺陷，**不是用户没开管理员** | 再查具体哪个文件落到只读路径；**绝不要建议以管理员运行绕过** |
| **界面留白 / 样式错乱 / 全屏不自适应** | ① 共享 `ytvdlt.css` 把 `html/body` 钉成固定画幅 ② 本页内联 CSS 是否覆盖 ③ 主题变量 `data-theme` / `data-accent` | 冻结截图基线要求固定画幅，新页面容易继承 | 再查网格列数、overflow、截图基线 |
| **只有中文 / 文案不切换** | ① `?lang=` 有没有传到启动 URL ② 新文案是否两边字典都有键 ③ `data-i18n` 是否被运行时覆盖 | 字典与运行时都在，缺的通常是入口或键 | 再查菜单/托盘是否也跟随语言、`i18n.test.ts` 是否报缺键 |
| **e2e 全红** | ① 是否刚改了 UI（DOM/像素必然变）② 失败 case 的 `dom=true` 是否仍成立 ③ 是否只有预期 case 失败 | 基线是冻结快照，改 UI 不等于改坏 | 按 §6 逐 case 重建；**不要**改松断言或全量覆盖 |
| **打包后界面还是旧的** | ① 是否先跑 `build-desktop.mjs` ② asar 内对应文件是否是新内容 ③ `package.json` 是否被构建改写未还原 | 顺序反了会把上一版前端塞进包 | 再查缓存、`dist/` 与输出目录、图标是否重生成 |
| **改了代码没效果 / 行为异常** | ① `grep` 定位真实实现（别猜文件名）② 是否违反分层 ③ 是否改到了 fixture 分支 | 项目有多处同名的 M3/M4/M5 通道 | 再按 §1 优先级查日志与当场输出 |
| **下载进度一直转圈、随后「秒完成」** | ① argv 里有没有 `--downloader aria2c`（外置下载器下 yt-dlp 不报字节，`--progress-template` 一行都不出）② `logs/app-*.jsonl` 的 `engine.download` argv 是否含 `--progress-template` ③ 用同一 URL 手工跑一次随包 yt-dlp，看 stdout 是否出现 `YTVDLT\|` 行 | 引擎只能解析它真的收到的字节；外置下载器让整条链路「安静地成功」 | 再查 `record.lastPercent` 是否被 `restart()` 清空、UI 的 `progressMode` 分支 |
| **文件名不可读 / 中文标题变成下划线** | ① argv 里有没有 `--restrict-filenames`（语义是「只保留 ASCII」，CJK 会被删除）② `config.json` 的 `paths.restrictFilenames` ③ 模板里的空格被 `sanitizeToken` 换成 `_` 属正常 | 这两类各造成过一次业主可见的退化 | 再查 `paths.outputTemplate` 与 `withCopySuffix()` 的 `(1)` 插入位置 |
| **主题只在设置页生效 / 重启回浅色** | ① 设置页是否还在走 `CONFIG_SET`（M3 fixture，不持久化）② `theme.js` 的 `ytvdlt.appearance` 本地缓存与 `SETTINGS_GET` 回读 ③ `<html>` 上的 `data-theme` | 真正的持久化只走 `SETTINGS_SET` → `general.theme` | 再查 `config.json` 是否被只读目录回落、`theme.css` 是否被覆盖 |
| **全屏退不出去 / 各页面按钮不一致** | ① 是否同时用了 HTML Fullscreen API 与 `Window.setFullScreen()` ② 菜单 F11 是否还挂 `role:'togglefullscreen'` ③ `WINDOW_FULLSCREEN` handler 是否注册、`enter-full-screen` 是否推送 | D-106 把两套状态合并为主进程单一真相 | 再查 `shell/app-nav.js` 的 bridge 分支与静态预览降级 |
| **「检查更新」没反应 / 一直提示失败** | ① `logs/app-*.jsonl` 里 `app-update` 与 `component-check` ② GitHub API 是否可达（`api.github.com/repos/yechenliao0820/YTVDLT/releases/latest`）③ `advanced.autoCheckAppUpdate` / `lastAppUpdateCheckAt` 是否把自动检查挡在节流窗口内 ④ 该版本是否已被「以后不再提示」写进 `advanced.skippedAppVersion` | 更新链路不碰 UI 状态，失败只写日志、不动正在运行的版本 | 再查 Release 资产名是否还能被 `selectInstallerAsset` 认出来（改名成非 `Setup` 且带 portable 字样会被打 0 分） |
| **勾选「同时删除本地文件」后记录删不掉 / 卡片仍显示已完成但文件早已被外部删除** | ① 产物路径是不是已被用户在资源管理器删掉（`ENOENT` 是幂等完成，不是失败）② `TASK_ACTION` 是否在 `taskDetail.perform('remove')` 之前就 return ③ `EACCES` / `EBUSY` 有没有被误判成 `ENOENT` ④ `fileStatus` 是否来自过期缓存、重进页面有没有带 `refreshFileStatus` | 记录删除与文件清理必须解耦；只有真实文件系统错误才保留记录（原理见 §9 坑 22） | 再查共享物理文件的引用计数、`shell.trashItem` 的真实 errno、以及 `open-folder` 走的是目录检查而不是文件检查 |
| **切语言 / 启动瞬间冒出 6 条演示任务** | ① `queue.js::tasks()` 的 live 分支是否又回退到 `SAMPLE` ② 是否在首条 `TASK_LIST` 回来前就 `render()` ③ 详情页是否把 `index.html` 里的 fixture 值直接画了出来 | 截图 fixture 只服务 `file://` 静态基线；live 模式「还不知道」必须是空白 / `data-state="loading"`，**绝不允许**用样例数据顶替（D-141） | 再查首条回复是否被 paint-key 吞掉（空队列尤其）、2.5 s 看门狗有没有转错误态 |
| **「下载并安装」看不到下载进度** | ① 设置页刷新定时器是否只认 `phase`——`download` 要等整包下载完才 resolve，期间 `data-update-state` 恒为 `available`，条件自锁 ② 弹窗轮询间隔（下载中应为 0.8 s）③ 缓存命中会直接跳 `ready`，本来就没有进度 | 用「phase 决定要不要去读 phase」就是自锁；`appBusy` 才是 action 未返回期间的唯一信号 | 再查 `onProgress` 是否更新 `downloadedBytes`、`totalBytes` 是否为 null（百分比会恒 0） |

---

## 5. IPC 契约（两处必须对齐）

渲染层调用**符号名**，preload 白名单校验**线缆字符串**。映射分布在这三处，漏一处就是「按钮点了没反应」：

- `packages/ui/src/pages/queue/queue.js::CHANNELS`
- `packages/ui/src/pages/task-detail/task-detail.js::CABLE`
- `packages/ui/src/ipc-bridge.js::CHANNEL_STRINGS`

通道常量定义在 `packages/shared/src/ipc.ts`（append-only）；主进程 handler 在 `m5-channels.ts` 与 `ipc-gateway.ts`。

约束：

1. **payload 键白名单**：`m5-channels.ts::PAYLOAD_KEYS` 只放行登记过的键，多一个直接抛错；枚举值越界同样拒收，不会带进 argv。
2. **URL 脱敏**：`TASK_LIST` 不返回 URL；`TASK_DETAIL` 返回 `maskUrlSecrets()` 后的值。新增字段别把原始链接带出去。
3. **删本地文件**：`TASK_ACTION` 的 `withFiles: true` 只允许配 `action: 'remove'`；主进程只取该任务 `artifacts`，经 `TrashFilesPort` 移入回收站，**部分失败保留记录**。
4. **无痕**：`SETTINGS_SET` 的 `privateMode` 只收 boolean，`SETTINGS_GET` 回读；关闭窗口时清任务记录，**不动本地文件**。
5. `PROBE` / `PROBE_PLAYLIST` / `DIALOG_CONFIRM` 仍是 fixture 通道，别当成真实能力。
6. **更新三分家**（D-93 / D-94）：`APP_UPDATE_*` 管应用本体（GitHub Release），`COMPONENT_CHECK` / `COMPONENT_UPDATE` 管随包二进制，`COMPONENT_STATUS` 只读本地版本。`APP_UPDATE_STATUS` 是纯内存读，队列页与设置页都以轮询方式消费，**不要为它加主进程推送**。
7. **`TASK_LIST` 只回本地封面路径 `thumbPath`**：远端缩略图 URL 由主进程缓存成文件，URL 本身永不出主进程（与 URL 脱敏同一条规则）。
8. **`PATH_ACTION` 不接受路径字符串**（D-98）：渲染层只能发 `{action: pick|reset|open, kind: video|audio}`，能写进 `paths.*` 的只有主进程对话框选出来的目录。改这条等于给渲染层开一个"任意写配置路径"的口子。
9. **`THUMBNAIL_CACHE` 不接受路径**（D-103）：渲染层只能发 `{action: status|prune|set-auto|set-max-bytes, enabled?, maxBytes?}`。删除只在主进程发生，且必须经 `isSafeCacheName()` + 目录前缀校验后走 `shell.trashItem`；把路径或删除原语带进这个通道等于给渲染层开一个"任意删文件"的口子。
10. **`APP_INFO` 只读、零参数**（D-114）：主进程回 `app.getVersion()`。**页面上的版本号只能来自它**（`?v=` 仅作首帧提示，不得作为唯一来源，更不得在渲染层写死版本字符串——那正是 0.2.2 存活四个版本的机制）。
11. **`TASK_LIST` 的 `fileStatus` / `dirStatus` 只是文件系统观察值，不是下载状态**（D-120）：主进程只对 `Completed` 任务按记录里的产物路径 `stat`，枚举固定 `present|missing|inaccessible|unavailable|invalid`；`refreshFileStatus: true` 只请求一次强制重查，**不接受任何路径**。渲染层绝不能因 `missing` 删除历史记录或把「已完成」改成「失败」。
12. **`TASK_ACTION` 的 `withFiles` 是幂等清理**（D-120）：`TrashFilesPort` 逐路径返回 `trashed|missing|error`；只有 `error` 才保留记录并回 `FILE_DELETE_FAILED` + 真实原因，`missing` 一律继续删记录。被其它在册任务引用的同一物理文件跳过回收，删除范围不得扩大。`open-file` / `open-folder` 在操作前强制重查；`open-folder` 只看目录状态，文件缺失不阻止打开原目录。
13. **`TXT_IMPORT_PICK` 零参数、`TXT_IMPORT_ENQUEUE` 不接受 URL**（D-129）：渲染层既不能传路径也不能传 URL 列表，只能传主进程颁发的一次性 `importId` 加现有下载枚举。文件选择与读取只发生在主进程 adapter，票据由 `txt-import-service.ts` 单次消费（TTL + 数量上限）。
14. **导入预览的统计必须来自真实解析结果**（D-129）：部分入队失败按 `requested / enqueued / failed` 如实回报，禁止把 `PARTIAL_SUCCESS` 写成全部成功；无效、重复、播放列表行不进入批量。
15. **`PLAYLIST_PREVIEW` 只收 url / previousPreviewId，`PLAYLIST_BATCH_ENQUEUE` 不收 PlaylistInfo**（D-130）：完整 `PlaylistInfo`（含条目 URL）只留在主进程 `PlaylistPreviewCache`；Renderer 拿到的 DTO 无任何 URL。票据绑定 URL、5 分钟 TTL、单次消费，取消 / 关闭 / 退出清理。M3 冻结的 `PLAYLIST_ENQUEUE` 仍在 fixture gateway，两条链路共用 `m4-host.ts::runPlaylistBatch()`。
16. **播放列表生产 taskId 不用 `defaultBatchTaskId()`**（D-130）：`<playlistId>-<entryId>` 会让同一合集二次入队覆盖旧记录。新票据链路注入唯一 `makeTaskId`；旧 M3 链路和纯函数保持原样。预览显示「声明总数 / 实际解析 / 可下载 / 不可访问」四个数，只解析到 20 条不得写成 65 条。
17. **`SUPPORTED_SITES` 只收 `refresh`、`URL_SUPPORT_CHECK` 只收 `url` / `refresh`**（D-134）：渲染层不得指定引擎路径、引擎版本、argv、cookies、质量或提取器——名单必须来自**当前实际运行的引擎**，这是整个功能存在的理由（写死或可被渲染层指定的名单与陈旧列表无法区分）。`SUPPORTED_SITES` 的 DTO **不含 `enginePath`**（含用户名绝对路径，无需求且属泄露），取不到就以稳定 code（`ENGINE_TIMEOUT` / `ENGINE_FAILED` / `ENGINE_EMPTY` / `OUTPUT_LIMIT_EXCEEDED` / `ENGINE_UNAVAILABLE`）报失败，**绝不编造列表**。`URL_SUPPORT_CHECK` 由**主进程算好 `blocks` 下发**，渲染层不得自行推导「什么状态算不支持」；`NO_MEDIA` 是提示不是拦截，**门禁 fail open**——误拦用户无法绕过，误放只是让下载按引擎自己的准确错误失败。
18. **截图 fixture 永不进 live 模式**（D-141）：`queue.js::SAMPLE`、`task-detail.js::SAMPLE`、`task-log.js::SAMPLE` 与 `index.html` 里的 fixture 字面值只服务 `file://` 静态基线。live 模式在真实数据到达前必须表现成「还不知道」（`data-state="loading"` / 空白 / 动作全部禁用），**不得**用样例数据顶替，也不得谎报「还没有任务」。首个回复要**强制重绘**（否则空队列因 paint key 相同永远停在 loading）；首条回复卡死要有超时转错误态 + 重试。语言切换是整页重载，等于重走启动路径——这条规则不守住，切换语言就会把假任务带回真实窗口。
19. **`STAR_PROMPT_CHECK` 零参数、`STAR_PROMPT_ACTION` 只收动作枚举**（D-148）：渲染层不得传 URL 或计数——仓库地址是主进程常量，`star` 走 `openExternal`；频率状态（`advanced.starPrompt*` 五键）只由主进程读写。弹窗是 live-only 动态 DOM（D-139 模式），不进静态基线；「以后再说」后 7 天内同版本不再问，`star`/`never` 永久安静，升级新版本计数重置。

---

## 6. 数据落在哪

| 运行形态 | 配置 / 日志 |
|---|---|
| exe 目录可写（便携 / 默认安装） | `<exe目录>\config\config.json`、`<exe目录>\logs\app-YYYYMMDD.jsonl` |
| 装到 `C:\Program Files`（不可写） | `%APPDATA%\YTVDLT\config\…`（`data-dir.ts` 写探针实测可写性） |
| 默认下载目录 | 视频 / 音频都在**系统「视频」库**下的 `YTVDLT`（`app.getPath('videos')` → `%USERVIDEOS%/YTVDLT`，音频在其 `Audio` 子目录；**运行时展开**，spawn 不经过 shell。`%USERVIDEOS%` 不是 Windows 环境变量，由主进程注入展开表） |
| 用户改过下载目录 | `paths.videoDir` / `paths.audioDir` 存**绝对路径**；未改过则存 token（`%USERVIDEOS%/…`），换机器仍跟用户目录走（D-98 / D-117） |
| **应用内部工作目录** | `<dataDir>/work/<taskId>/`：yt-dlp 产物清单、子进程 `cwd`、以及 `-P temp:` 指向的中间文件（`.part` / `.part-FragN.part` / `.ytdl`）。**按任务隔离**；清单读取并交接后才删除，成功后若目录为空则非递归 `rmdir`。**这就是续传的凭据，不要当成垃圾清理**（D-118） |
| **跨卷时的中间文件** | `<outputDir>/.ytvdlt-incomplete/<taskId>/`：当 `<dataDir>` 与输出目录不在同一卷（或卷无法判定）时使用。放在输出目录内部是为了保证收尾的 `shutil.move` 退化成 rename，而不是整份复制 |
| 封面缓存 / 更新包 | `<dataDir>\thumbs\<sha1(url)>.<ext>`、同目录 `index.json`（D-103 持久索引：taskIds / bytes / lastUsedAt）、`<dataDir>\updates\YTVDLT-Setup-*.exe`（D-93 / D-96） |

`config/config.json` 按域组织：`general / format / subtitle / paths / network / advanced`；
`config/tasks.json` 是队列快照。

---

## 7. 改动流程与文档分工

```
1. grep 定位实现（别猜文件名）
2. 改代码，保持 §2 的分层
3. pnpm typecheck            → 看输出，要求全 successful
4. npm test                  → 看输出，要求 0 failed（覆盖率门限由脚本管）
5. node scripts/run-e2e.mjs  → 看输出，要求全绿 + 反例全 PASS
   改了 UI：先跑一次确认只有预期 case 失败且 dom=true；
   再逐 case `node scripts/run-e2e.mjs --case=<id> --update-baselines`；
   最后全量复验。不要全量 --update-baselines，不要改断言。
6. 动了 UI → node scripts/build-desktop.mjs，再按 §0 铁律 9 打包
            打包后立刻还原被改写的 package.json（见 §9 坑 2）
7. 打包产物真机验证：--remote-debugging-port=9222 启动，用 reports/l3-probe/ 下的驱动
8. docs/DECISIONS.md 追加 D-xx；发版另在 CHANGELOG.md 加一行
9. 回复末尾输出「修改文件清单」（§0 格式）
```

| 改了什么 | 至少重跑 |
|---|---|
| `packages/ui/**` | `build-desktop` + `run-e2e` + 打包后真机点一遍 |
| `packages/core/**` | `typecheck` + `npm test` |
| `packages/engine-ytdlp/**` | `typecheck` + `npm test` + `scripts/l3-smoke.mjs`（真下载） |
| `apps/desktop/src/main/**` | `typecheck` + `npm test` + 打包后真机走一遍 |
| `electron-builder.yml` / 图标 | 重新打包 + 检查 asar、图标、真机启动 |
| 只改 `docs/**` | `node scripts/handoff-check.mjs` 对账 |

**文档分工（写错地方就是制造下一个屎山）**

| 内容 | 唯一去处 |
|---|---|
| 版本、日期、交付状态、某版改了什么 | `CHANGELOG.md` |
| 现象／根因／决策／验证／未覆盖 | `DECISIONS.md`（append-only） |
| 构建产物考据、为什么淘汰某版 | `BUILD-HISTORY.md` |
| 对业主的交付口径、验收结论、已知缺陷 | `DELIVERY-REPORT.md` |
| 打包步骤与环境、打包相关的坑 | `BUILD.md` |
| **路径、规则、契约、分诊顺序** | **本手册** |

### 版本编号规则（十进制进位，业主 2026-11-08 定）

版本号三段 `0.<minor>.<patch>`，**每段是一位十进制数，满 9 向前进位**：

```
0.1.8 → 0.1.9 → 0.2.0 → 0.2.1 → … → 0.2.9 → 0.3.0 → … → 0.9.9 → 1.0.0
```

- **禁止在任一段写两位数**：`0.1.9` 的下一版是 `0.2.0`，绝不写 `0.1.10`。
- 发版前同时改根 `package.json` 与 `apps/desktop/package.json`（两处必须一致）；
  打包后按本节上方步骤 6 还原成发版基准。
- 号必须单调递增且能被 `electron-updater` 按 semver 认成新版本，**不回退、不重号**。
- **当前发到哪一版、下一版取什么号，看 `CHANGELOG.md` 的版本表末行与「版本编号规则与历史例外」一节。**
  本手册不写当前版本号——那是会过期的状态，不属于这里。

收尾一律跑 `node scripts/handoff-check.mjs`；输出不齐说明有文档没跟上。

---

## 8. 脚本一览

| 脚本 | 用途 |
|---|---|
| `scripts/build-desktop.mjs` | esbuild 打包主进程 + preload，拷贝 `packages/ui/src` 到 `apps/desktop/dist`。**改前端后必须先跑** |
| `scripts/make-icon.mjs` | 生成四档 `icon.ico`；改图标后必须重跑并重新打包 |
| `scripts/run-tests.mjs` | vitest 封装（`all --coverage` / `unit` / `contract` / `integration`） |
| `scripts/run-e2e.mjs` | PNG + DOM 基线对比，含反例；`--case=<id>` / `--update-baselines`。D-105：浏览器路径由 `lib/find-browser.mjs` 自动发现，版本门槛可用 `YTVDLT_E2E_EXPECT_VERSION` / `YTVDLT_E2E_ALLOW_VERSION_MISMATCH` 配置 |
| `scripts/lib/find-browser.mjs` | E2E 浏览器自动发现：env 覆盖 → `PLAYWRIGHT_BROWSERS_PATH` / ms-playwright 缓存 → 系统 Chrome → PATH；缺失时输出安装指引 |
| `scripts/handoff-check.mjs` | 把文档数字与仓库现状对账 |
| `scripts/acceptance.mjs` | 里程碑验收，产出 `reports/acceptance-report-m*.json` |
| `scripts/l3-smoke.mjs` | 打包应用在线烟测（CDP 驱动真实 IPC） |
| `vitest.online.config.ts` / `npm run test:online` | **真实国际网**在线审计（D-132）：真播放列表探测 + 批量下载、真字幕内嵌。默认 `vitest.config.ts` 已排除 `tests/integration/online/**`，不显式运行不会联网；产物只落 `reports/l2-tmp/` |
| `scripts/check-layering.mjs` | 分层依赖检查（core 不许 import `node:*`） |
| `scripts/frozen-gate.mjs` | 冻结门控（`request.ts` 逐字节、package.json 白名单） |
| `scripts/verify-artifact.mjs` | 单个媒体文件的产物校验 |
| `reports/l3-probe/ui-drive.mjs` | 真机 UI 驱动（需 9222 端口） |

---

## 9. 稳定坑（原理，不随版本变）

1. **先 `build-desktop.mjs` 再 `electron-builder`**：后者只是把 `apps/desktop/dist` 塞进 asar，顺序反了包里就是旧前端。
2. **electron-builder 会就地改写根 `package.json`**（丢 `scripts` / `devDependencies`、写 `main`）：打包后必须还原；带 `publish` 块时靠 `extraMetadata.main` 钉住入口。
3. **用户路径里的 `%VAR%` 必须运行时展开**：spawn 不经过 shell，否则生成字面量目录并导致产物为空。
4. **验证要用真实输入事件**（`Input.dispatchMouseEvent` / `Input.insertText`），不要用 `dispatchEvent(new Event(...))`——合成事件会稳定地骗过测试。
5. **打包可能被本机 safe-delete 守卫超时打断**：Setup 已产出而其它 target 缺失、`exit=1` 时，原样重跑同一条命令即可；**不要 rm -rf**。
6. **真机 CDP 启动报 `bad option: --remote-debugging-port=...`**：会话继承了 `ELECTRON_RUN_AS_NODE=1`，Electron 被当成 Node。启动前用 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS ./YTVDLT.exe --remote-debugging-port=9222`。
7. **任何子进程 spawn 都要带可写 `cwd` 与 `TEMP/TMP/TMPDIR`**：装到只读目录时，缺了它们 yt-dlp 的临时文件会落到安装目录。不要自己拼 `env: { PATH }`。
8. **改 UI 后截图基线必然变**，这是预期；处理方式见 §7，不是「测试坏了」。
9. **桌面图标是 shell 缓存问题，先证明打包没坏**：把 `build/icon.ico` 里 256 档的 DIB 载荷（跳过 40 字节头）在 `dist-<ver>/win-unpacked/YTVDLT.exe` 里搜一遍，命中就说明 `win.icon` 已生效，别再改打包配置；接着看 `build/installer.nsh`（`SHChangeNotify` 刷缓存）是否被执行，最后才是 `ie4uinit.exe -show` 或删快捷方式重装。
10. **设置页的滚动发生在内层 `.settings-scroll`**：目录要跟着高亮，就必须用内层 `scrollTop` 而不是文档滚动；并且**底部要留出 `max(140px, 60vh)` 的空白**，否则最后两个分区永远滚不到探针线，点「关于」会停在高亮「下载位置」的位置（D-99）。首帧 rect 不可信，`load` + `ResizeObserver` 各复测一次。
11. **yt-dlp 不会覆盖同名文件**：第二次下载只会打印 `has already been downloaded` 并退出 0，应用随后拿到的是**旧文件**。要让用户「再存一份」，必须在 spawn 之前把 ` (n)` 插进 `-o` 模板（`TaskQueue.withCopySuffix()`），而不是事后改历史（D-101）。同理：这种情况**不能判 Error**，文件在盘上、校验也过了。

12. **更新器缓存复用不等于「已校验」**（D-104）：大小 + `MZ` 只能证明文件像 exe，证明不了它是当初验证过的那份。复用与安装前都必须用 `CorePorts.hash.sha256File()` 重算；发布端可能不给 `digest`，所以首次下载要落 `.sha256` sidecar；两个基准都没有就拒绝复用、重新下载，绝不因为「没有哈希」而跳过校验。可疑文件只改名隔离，不永久删除。
13. **截图基线的载体是 `chrome-headless-shell`**（D-105）：完整 Chrome 与 headless shell 的滚动条 / 字体光栅化不同，自动发现时 headless-shell 构建必须优先命中，否则会出现「版本字符串相同但像素全变」。版本门槛默认严格；换机器先用 env 指路，找不到浏览器要给安装命令而不是 ENOENT。

14. **不要改 `styles/ytvdlt.css` 的固定 1280×800**：M3 冻结基线靠它。主窗口页面的响应式全部在 `styles/layout.css`，用 `--ui-step`（1280×800 时恒为 0）与高特异性选择器覆盖各页内联 `<style>`；改变量上限不会动冻结基线，改 `ytvdlt.css` 会一次毁掉 16 张。
15. **全屏只有主进程一个真相**：渲染层按钮发 `WINDOW_FULLSCREEN`，菜单 F11 走同一个 `applyFullscreen()`；只有静态预览（无 preload bridge）才退化到 HTML Fullscreen API。任何「两套状态并存」的写法都会复现「退出全屏按钮点了没反应」。

16. **外置下载器（`--downloader aria2c`）会整条吃掉进度链**：yt-dlp 的 `--progress-template` 取自它自己的下载循环，交给 aria2c 后 `progress.*` 字段大批为 `NA`，实测同一条 17.6 MB 视频 aria2c 输出 **0 行**、原生 **6 行**；14 分钟 1080p HLS 还慢 3.7 倍。任何「加速/多线程」开关上线前，必须先证明进度仍然可用，否则用户看到的是「转圈很久 → 突然完成」。

17. **`--restrict-filenames` 不是「清理非法字符」**：它的语义是只保留 ASCII，CJK 会被直接删空（中文标题实测变成 `_ [_].mp4`）。Windows 非法字符交给 yt-dlp 默认行为即可（`?`→`？`、`|`→`｜`，是替换不是删除）。这个标志只能作为用户显式选择，绝不能从模板内容推导。

18. **GitHub Release 的资产名会被静默改写**：上传时名字里的空格一律转成点（`YTVDLT Setup 0.2.5.exe` → `YTVDLT.Setup.0.2.5.exe`），你本地文件名不变，线上变了。因此 **`latest.yml` 的 `url` / `path` 必须按点号版本重写再上传**，否则清单指向一个不存在的文件名（404），任何按清单取包的客户端都会失败。这条只影响 `latest.yml` 的消费者（`electron-updater`），应用本体走 `releases/latest` + `browser_download_url`，不受影响（D-113）。

19. **小文件资产的 `/releases/download/` 直链可能 504，而同一版的大资产正常**：0.2.5 的 `latest.yml` 直链连续 504（重传一次仍 504），同一版的 `.exe` / `.blockmap` 都是 302，0.2.4 的同名文件也正常。判断方法：改用 API 资产端点 `GET /releases/assets/<id>`（带 `Accept: application/octet-stream`）能正常取到内容，说明文件本身没问题、是 GitHub 侧的网关/CDN 问题。本产品不消费 `latest.yml`，故不阻塞交付；**若将来真的启用 `electron-updater`，发布后必须实测这条直链**。

20. **`_MEI<pid>` 跟随 `TEMP`，不跟随 `-P`**：yt-dlp 是 PyInstaller onefile，每次启动把约 29 MB / 142 个文件解包到 `%TEMP%\_MEI<pid>`，**正常退出会自己删**，被 `taskkill` 打断则残留。它曾经出现在用户的视频目录里（D-89 把子进程 TEMP 钉在输出目录），这就是"下载目录里为什么有一堆 `_MEI`"的答案。结论：**cwd 可以钉，TEMP 不要钉**；`-P temp:` 只影响 `.part` / `.ytdl`。别按名字去删 `_MEI*`——判断不了哪个属于正在跑的进程。

21. **`child.kill()` 杀不掉 yt-dlp**：onefile 的 bootloader 会再起一个子进程，`child.kill()` 只终结父进程，下载继续跑（实测：kill 后仍完整下载完，`.part` 都没出现）。取消必须走 `taskkill /PID <pid> /T /F`（`adapters/process-streaming.ts` 已实现）。写任何"中断"测试时同理，否则测的是假中断。

22. **`shell.trashItem` 对不存在的文件抛 `ENOENT`，那不是删除失败**（D-120）：把它计入「部分失败」会让任务历史永远删不掉。清理必须幂等——先 `stat` 判存在，存在才回收；`ENOENT`/`ENOTDIR` 视为已完成；`EACCES`/`EPERM`/`EBUSY`/`EIO`/卷不可用才保留记录并回报真实原因。`stat` 到 `trashItem` 之间文件仍可能被外部删掉，catch 里要按 errno 再兜一次，别吞掉所有异常。同理：队列里的 `Completed` 说的是「当初下载成功」，不是「文件现在还在」，两者别互相覆盖。

23. **元数据子进程的 stdout 必须有上限，且上限要按字节而不是字符算**（D-133）：`probe` / `probePlaylist` 的 JSON 用无上限的 `stdout += chunk` 累积，一个病态播放列表或持续流式返回的站点能把主进程撑到卡死。两个容易踩的点：① **用 `text.length` 设限会低估最多 3 倍**——CJK 标题一个字形占 3 个 UTF-8 字节却只有 1–2 个 JS 字符，中文用户最容易先撞上；计数一律按字节。**实现细节别写错**：适配层（真正执行上限的地方，`output-limiter.ts::createBoundedOutput`）拿的是原始 `Buffer`，累加的是分片实例属性 `chunk.byteLength`，**仓库里没有 `Buffer.byteLength(...)` 这行代码**——那只是 `tests/unit/probe-output-limit.test.ts` 用来对账的对照基准；引擎侧另有一个对**已解码字符串**估算的 `utf8ByteLength()`（`yt-dlp-engine.ts`，仅供日志记 `receivedBytes`，**不参与上限判定**）。照文档 grep `Buffer.byteLength` 会一无所获，别被坑。② **超限不能按「网络类错误」报**，否则用户拿到的是误导性的 `UNKNOWN`/`NETWORK_TIMEOUT`；适配器在 stderr 追加一个**不含任何关键词表触发词**的标记，引擎识别后按「输出超限」解释，并把 `exitCode` 置 `null`。**截断的 JSON 绝不能拿去解析**——截断的播放列表会静默长成「列表就是短」，比探测失败更危险。上限只在有界元数据任务上开，正常下载一字节都不杀；但 D-144 起 `spawnStreaming` 的**诊断副本**也是按字节算的 1 MiB 尾缓冲（截断标记 `STREAM_TAIL_TRUNCATED_MARKER` 在最前、末行必完整）——依赖「下载 stderr 是全量历史」的代码从此拿不到全量，现无此类消费方。

24. **`generic`（GenericIE）会认领一切 http(s) URL，「无提取器」与「无媒体」在引擎措辞里是同一句话**（D-134）：随包引擎对 `/nomedia.html`、无 `src` 的 `/video-nosrc.html` 都先打 `[generic] Extracting URL` + `Looking for embeds`，再以 `ERROR: Unsupported URL: ...` 收尾且真实下载写零文件（`[debug] Loaded 1747 extractors`）。所以这句**必须读成「提取器认领了但页面无媒体」= NO_MEDIA（放行）**，读成「站点不支持」会拦掉普通「此页面无视频」的下载，正是「网站支持 ≠ 视频可用」的混淆。真正 UNSUPPORTED 的只有引擎**连路由都拒绝**的情形（`'wat' is not a valid URL`、`Unsupported url scheme: "mailto"`、`file:// URLs are disabled`），这类在 http(s) 输入上几乎不可达。判定顺序上 `unsupported url scheme` **必须先于** `unsupported url` 检查，否则路由级结论会被子串误吞。门禁的不对称性决定默认值：**误拦用户无法绕过且无补救，误放只是让下载按引擎自己更准确的错误失败 → 一律 fail open**，预检自身抛异常也算「未检查」放行。
25. **`--extractor-descriptions` 的输出不是 UTF-8**（D-134）：实测同一二进制上它是 Windows ANSI 代码页（`BaiduVideo: 百度视频` 到达时是 `B0 D9 B6 C8 CA D3 C6 B5` = cp936），按 UTF-8 解码必成 mojibake，按 cp936 解又在非中文 Windows 上出错。名单只用 `--list-extractors`（纯 ASCII，实测 1755 行 / 23,500 B）；`(CURRENTLY BROKEN)` 是引擎自己的判断，**逐字保留、不重新推导也不隐藏**，且标记**具有粘性**（同名两行无论顺序都保留坏标记，结果不依赖行序）。

26. **`redirect: 'follow'` 会让「初始 URL 校验」整个失效**（D-137）：`fetch` 自己决定最终地址，所以校验过 `https://github.com/…` 之后，一个 302 仍能把它带到任意主机或 http 明文，而应用层只看得到结果。所有出站请求一律走 `adapters/http-policy.ts::fetchFollowingRedirects`（`redirect:'manual'` + 逐跳 `allow` + 跳数上限 + 环检测），**同一个 AbortSignal 覆盖整条链**。同理，`HttpPort.getBytes()` 曾用 `arrayBuffer()` 读完整 body 才比大小，且计时器在拿到响应头就被 `clearTimeout`——无 `Content-Length` 的大流和慢流各能独立把主进程拖垮；现在按字节流累计、`maxBytes` 立即取消、单一 deadline 覆盖到最后一片。**URL 字面量检查 ≠ 已防 SSRF**——检查发生在解析之前，看不见解析后的 IP；D-143 的修复不是再加一层 hostname 判断，而是把传输层换成 `node:http(s)`：每跳解析全部地址 → 逐个过 `allowResolvedAddress`（私网 fail-closed）→ 用 `lookup` 选项把 socket 钉在已验证地址上（消灭「检查后、连接前」的换 IP 窗口）。残余局限（resolver 被控持的解析投毒、无地址钩子的 `allowAnyHttpUrl`）见 D-143「未覆盖」。
27. **「发出 kill」不等于「进程已退出」**（D-137）：`taskkill /T` 是外部进程、可能失败；超时/超限若在 kill 发出的瞬间就 resolve，调用方拿到的是「我认为它停了」而不是「我看到它停了」。`node-ports.spawn()` 现在有界等待 `killTree()` 的布尔结果，只有 `close`/`error` 事件才是退出证据；两者都没有时 stderr 追加中性的 `TERMINATION_UNCONFIRMED_MARKER`，且 `exitCode` 对**超时与超限**一律置 `null`（否则 `taskkill` 的退出码 1 会伪装成一次正常运行）。

28. **`file:` 的 `origin` 恒为 `'null'`，不能用来区分「应用页面」与「任意本地文件」**（D-138）：`new URL('file:///C:/x/evil.html').origin` 和 `new URL('file:///app/pages/queue/index.html').origin` 都是字符串 `'null'`。可信页面必须走**规范化路径白名单**：`decodeURIComponent` → 按 `/` 分段 → 消 `..` → 反斜杠归一 → **按段**比较前缀（`pages-other` 不能命中 `pages`）→ 末段限 `.html`/`.htm`。注意 WHATWG URL **不解码** `%2e%2e`，`pathname` 会原样保留，只靠 URL 解析挡不住编码穿越。同一族的地址坑：`new URL('https://[::ffff:127.0.0.1]/')` 的 hostname 是 `[::ffff:7f00:1]`，任何「点分字符串前缀」匹配都永不命中；IPv6 必须先展开成 8 组再判 `fc00::/7` / `fe80::/10` / `::ffff:0:0/96`（取末 32 位复用 IPv4 段判断），并且**先判断是不是 IP 字面量**——否则 `fc`/`fd` 开头的公开域名会被误拒。

29. **「通道 / handler / 单测都在，功能却不存在」时先查前端调用方**（D-139）：IPC 通道、payload 白名单、handler、甚至单测全绿，不代表有界面能触发它。`grep -rn "CHANNEL_NAME" packages/ui/src` 为 0 命中，就是前后端断裂——本项目已出现两次（`URL_SUPPORT_CHECK`、`TEMPLATE_*`）。接线时三张表必须同时改：`shared/src/ipc.ts` 的通道值、`preload/bridge.ts` 的全量放行（它取 `Object.values(IPC_CHANNELS)`，通常无需改）、以及 `ui/src/ipc-bridge.js` 的 `ALLOWED_COMMANDS` + `CHANNEL_STRINGS`；漏掉最后一张表的表现是点击静默无反应（`command-not-allowed`）。
30. **动态创建的弹窗不改静态截图基线**（D-139）：需要在页面加确认框又不想动冻结基线时，用 `doc.createElement` 挂到 `body` 上、用完移除，而不是写进 `index.html`。静态用例没有 bridge、不会触发该分支，PNG/DOM 基线保持不变。反过来说，**静态 HTML 里新增可见元素一定会改基线**，必须按 §7 的按 case 重建流程做。

31. **「无报告的遗留物」先甄别再续写**（T5 / T6 两次实测）：被取消或限额杀死的 Agent 可能留下编译不过的骨架（`dropUtf8Prefix` 无定义），也可能留下「新测试全过、覆盖面未审计」的半成品（T5 的 30/30 掩盖了 7 项既有测试回归与 M5 `file-coverage` 红门）。接手顺序固定：`git diff` 逐文件对照任务书 → 全包 typecheck → 定向测试 → 全量测试 → 只补缺口，已实现且测过的绝不重写。
32. **动态 DOM 的节点移除不能假设 `parentNode` 存在**（D-156 实测）：测试沙箱的节点暴露 `parent` 而非 `parentNode`，`!== null` 挡不住 `undefined`，一次 `removeChild` 的未处理 rejection 会连带击穿**无关**的测试文件。照 D-139 Star 弹窗的三连守卫写：`parent !== null && parent !== undefined && typeof parent.removeChild === 'function'`；创建前先确认 `<body>` 可挂。静态预览没有真实 body，动态能力在那里就该不可见。

33. **「本机全绿」不等于「CI 全绿」**（D-157 实测）：干净 runner 缺三类本机才有的东西——被 `*.log` 误伤的测试 fixture（本机有、仓库没有）、按架构 §2.7 不入库的随包 `node.exe` / `yt-dlp.exe`、以及 Windows 检出的 CRLF（仓库 blob 是 LF，按 LF 分隔标记切分的许可测试会假失败）。修 CI 只补环境：把 fixture 入库、测试前用 `fetch-runtime --only=ytdlp/node` 取回二进制、在测试**输入边界**归一化行尾；**不许改断言、不许跳过用例、不许下调覆盖率门限**。补充（D-158）：Windows 把带 `#!/usr/bin/env node` 的 `.mjs` 检出成 CRLF 时，Vitest 收集期会报 `SyntaxError: Invalid or unexpected token` 且错误指向测试文件的 `import` 行；用 `.gitattributes` 的 `*.mjs text eol=lf` 钉住行尾即可，不要改测试。

分诊顺序与这些坑的对应关系见 §4；**§4 给顺序，本节给原理，不重复叙述事故经过**。


---

## 10. 已知未完成（接手时别当成 bug）

| 项 | 位置 |
|---|---|
| M3 播放列表选择对话框仍读录制 fixture、确认不创建任务（D-38 冻结保留）；**真实播放列表批量入口另见 §3「播放列表批量下载」**，两条链路互不替代 | `ui/src/pages/queue/playlist-batch.js`、`ipc-gateway.ts` |
| 逐格式选择对话框仍读录制 JSON（`PROBE` 是 fixture） | `ui/src/dialogs/` |
| 错误报告里的 `Engine: unknown`（展示缺陷） | `core/src/error-report/` |
| 自更新会清空便携模式数据（NSIS 清空 `$INSTDIR`） | 需迁出数据目录或自定义 NSIS 脚本 |
| 干净机验收、部分 `SKIPPED` 验收项（按规则不改判） | `docs/M5-VM-CHECKLIST.md`、`scripts/acceptance.mjs` |
| 托盘菜单与 NSIS 安装向导未双语；托盘右键无「设置/关于」 | `apps/desktop/src/main/tray.ts` |
| M3 弹窗里 JS 拼接的文案可能中英混排 | `ui/src/i18n/messages.js::PHRASES` |
| 便携版不参与自更新（只认 `Setup` 资产，`-portable` 被打 0 分） | `core/src/app-update/release.ts::selectInstallerAsset` |
| 后处理（合并/转码）阶段没有速度与剩余时间（引擎不报 `speed`） | `ui/src/pages/queue/queue.js::progressText` |
| 应用更新没有差量下载，每次整包（约 216 MiB） | `apps/desktop/src/main/adapters/http-download.ts` |
| 删本地文件、只读目录安装的在线下载，仍待目标环境真机复测 | §4 分诊表对应行 |
| **删除任务不回收其 `work/<taskId>` 目录**：目录里的 `.part` / `.ytdl` 是续传凭据，递归删除要先有租约判断，现阶段只保留不动 | `engine-ytdlp/src/yt-dlp-engine.ts`（成功后只删空目录） |
| **跨卷的中间文件落点未实测**：本机只有 C:，`resolveDownloadTempDir` 的跨卷分支只经过单元测试 | `core/src/path-resolver/volume.ts` |
| **字幕边界**：独立字幕重试、内嵌保留 MP4、同语言人工/自动分别下载未实现 | `core/src/task-queue/task-queue.ts`、`core/src/decision/download-plan.ts`、`core/src/subtitle-planner/subtitle-choice.ts`；验收口径见 `docs/DELIVERY-REPORT.md` 已知边界 3–5 与 D-132 |
| **URL 预检与「支持的网站」只在 main 进程边界验证过**：真实站点已在线跑通（播放列表 20/20 + 3 条下载、自动字幕内嵌、预检对 YouTube 返回 `SUPPORTED`），但**没有在真机 Electron 窗口里点开面板**，也**没有用真实 Cookie 跑过「预检与下载同配置」的正向对照**（proxy 那一路已实测，`cookiesFile` / `userAgent` 只有单测透传证明） | `main/site-support-network.ts`、`main/site-precheck-gate.ts`；口径见 D-135「未覆盖」 |
| **更新器首次下载没有独立可信签名基准**：信任根是 TLS + GitHub 域；发布端缺 `digest` 时本地 `.sha256` sidecar 只保证「后来没变」，不认证首次来源 | `main/app-update-service.ts`、`main/adapters/http-download.ts`；口径见 D-137「未覆盖」 |
| **IPC / 导航边界未做真机窗口验证**：sender、主 frame、`will-navigate`、`setWindowOpenHandler` 目前只有假 Electron 单测；打包后真机点一遍待业主指令（铁律 9） | `main/bootstrap.ts`、`tests/unit/ipc-trust-boundary.test.ts` |
| **本轮加固缺在线 / 安装包证据**：HTTP 逐跳、有界读取、IPC 边界全部是离线受控测试（127.0.0.1 + 假 Electron）；真实站点预检六态矩阵与 Windows 安装包验收需业主放行国际网并点名打包（铁律 9） | `tests/unit/http-network-boundary.test.ts`；口径见 D-137「未覆盖」 |

> 这张表会随开发推进变短。**完成一项就删一行**，不要留着写「已做」——那是本手册最容易腐烂的地方。
>
> 已删除的行（留存最近一次的移除记录，便于回溯）：
> - **「最低画质」是空选项** —— 由 D-133 修复（`RESOLUTION_QUALITIES` 补 `lowest → '+res'` 相对排序，绝不硬编码分辨率）。
> - **「URL 预检未做真实站点验证」的「未验证」部分** —— 由 D-135 在线补跑（`npm run test:online` 2/2、预检对 YouTube 实测 `SUPPORTED`）；该行**没有整行删除**，因为「真机窗口 / 真实 Cookie 对照」仍未做，改为上面那一行。
> - **「DNS 重绑定未防护」** —— 由 D-143 关闭（每跳解析全部地址 → `allowResolvedAddress` 逐个校验 fail-closed → socket 钉扎在已验证地址上，TOCTOU 窗口消灭）；残余局限（resolver 被控持的解析投毒、`allowAnyHttpUrl` 无地址钩子、无真实外网实测）见 D-143「未覆盖」。

---

## 11. 文档索引与检索

| 想了解 | 看哪份 |
|---|---|
| **版本流水（某版改了什么）** | `docs/CHANGELOG.md` |
| **给外部看的产品门面（安装 / 构建 / 功能）** | `README.md`（英，默认）与 `README.zh-CN.md`（中，镜像）；截图在 `docs/assets/` |
| 做过哪些决策、为什么 | `docs/DECISIONS.md`（最新编号看 `handoff-check.mjs` 输出） |
| 构建产物考据 / 淘汰版本 | `docs/BUILD-HISTORY.md` |
| 对业主的交付口径 / 验收结论 | `docs/DELIVERY-REPORT.md` |
| 打包步骤与环境 | `docs/BUILD.md` |
| 验收口径、架构演进、里程碑交接 | `docs/ACCEPTANCE.md`、`ARCHITECTURE-*.md`、`M*-HANDOFF-*.md` |
| 历史报告 `docs/*-REPORT.md` | **可能已过期**，只作线索，不作结论 |

```bash
grep -rn "ytvdlt:task:action" apps packages        # 某个 IPC 通道的实现
grep -rn 'data-action="cancel"' packages/ui/src    # 某个按钮的绑定
grep -rn "ARTIFACT_INCOMPLETE" packages            # 某个错误码从哪来
grep -n "D-89" -A 20 docs/DECISIONS.md             # 某个决策为什么这么定
sed -n '1,80p' packages/core/src/config-store/defaults.ts   # 默认配置项
node scripts/check-layering.mjs                     # 有没有偷偷 import node 内建
```

**冷启动**：跑 §1 三条自证 → 读 §4 分诊表 → 读 §3 找到被指派功能的文件 →
跑 `handoff-check.mjs` → 需要真机时按 §7 第 6 步打包。不要通读全仓，也不要通读历史报告。

### 代码仓库与上传

- 公开仓库：`https://github.com/yechenliao0820/YTVDLT.git`；默认分支 `main`；remote 名 `origin`。
- **不要主动推送**（铁律 12）。维护做完先本地交付并等指令；业主说「上传仓库」后再执行。
- 上传方法：

  ```bash
  git remote -v                                  # 先确认 origin 指向上面的地址
  git status --short                             # 看清楚本次要提交什么
  git add -A && git commit -m "<改动摘要>"
  git push origin main                           # 首次需 GitHub 授权，之后凭据由 Git Credential Manager 缓存
  ```

- 推送前体检：确认没有大文件（单文件 > 50 MB 会被拒）、密钥 / token 误入、以及
  `.gitignore` 是否仍覆盖 `node_modules/`、`dist-*`、`_to-delete/`、随包 exe、`reports/`。
- 上传后把**仓库地址、分支、本次提交号**写进回复交给业主／下一位；
  发布二进制 Release 同样等业主明确指令，产物在 `dist-<version>/`。

### 发布 Release（0.2.5 起实测路径）

本机**没有 `gh` CLI**（`gh: command not found`），发布走 GitHub REST API，凭据复用
Git Credential Manager 里那份（`git credential fill` 取 `password`，只在 shell 变量里用，不要打印）。

```bash
CREDS=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill)
TOKEN=$(printf '%s' "$CREDS" | sed -n 's/^password=//p')

# 1) 建 release（body 是英文 markdown；tag 由 target_commitish 指向 main 头）
#    POST https://api.github.com/repos/yechenliao0820/YTVDLT/releases
#    {tag_name: v<ver>, target_commitish: main, name: "YTVDLT <ver>", body, draft:false}

# 2) 传资产（顺序：latest.yml → blockmap → exe，小文件先上）
#    POST https://uploads.github.com/repos/<o>/<r>/releases/<id>/assets?name=<URL编码名>
#    -H "Content-Type: application/octet-stream" --data-binary @"<本地文件>"

# 3) 校验
curl -s -H "Authorization: Bearer $TOKEN" .../releases/latest   # 应用真实读取的接口
sha256sum "dist-<ver>/YTVDLT Setup <ver>.exe"                   # 必须等于资产 digest
```

**发布后的三条硬校验**（缺一条就不算发完）：

1. `releases/latest` 返回新 tag，且资产里 `digest` 非空；
2. 本地 exe 的 `sha256sum` 与资产 `digest` 逐字符相同（证明上传字节未损坏）；
3. `git fetch --tags` 后 `git rev-list -n1 v<ver>` == `git rev-parse HEAD`。

**资产名会被 GitHub 改写**：上传名里的空格一律变成点（`YTVDLT Setup 0.2.5.exe` →
`YTVDLT.Setup.0.2.5.exe`），所以 `latest.yml` 的 `url` / `path` 必须同步改成点号版本再上传
（见 §9 坑 18）。只传 exe 不改清单，会让任何按清单取文件的客户端 404。

---

## 12. 本手册的维护规则（防止它变成屎山）

**可以写进来**：路径、命令、文件名、分层与依赖方向、IPC 契约、永久规则、分诊顺序、稳定坑的原理。

**不要写进来**：
- 版本号、当前交付状态、日期、「最后核对日期」；
- 测试数、覆盖率、PASS 数、基线张数——**写成「跑某某命令看输出」，不写具体值**；
- 「某版本实测」「某某版已做」「当日新增」这类带时间戳的叙述；
- 已完成事项（直接删掉对应行，不要留着加「已做」标注）；
- 事故经过的复述（去 `DECISIONS.md` 看原文）。

**每轮维护做一次减法**：接手时先扫一遍，把已完成、已失效、带日期的条目**删掉**，
而不是继续往上加说明。新增内容先问一句「这条一年后还成立吗」，不成立就放 `CHANGELOG.md` 或 `DECISIONS.md`。

**改动后**：同步外层阅读副本 `C:/Users/leolee/Desktop/YTVDLT/docs/`，并跑一次 `handoff-check.mjs`。
