# YTVDLT · M1「骨架与引擎契约」产品需求文档（PRD-M1）

> 唯一权威输入：`C:/Users/leolee/WorkBuddy/2026-11-05-07-24-49/YTVDLT_HANDOFF.md`（v1.1，933 行）
> 本文件只覆盖 **M1**。M1 汇报后整个项目停下等甲方放行，**绝不推进 M2–M5**（§0 / §8 / §10 Step 5）。
> 本次为**简单 PRD**：不做竞品/市场调研，不重新讨论选型、命名、平台、技术栈（§2 已拍板，§9 禁止事项 1）。

---

## 0. 项目信息

| 项 | 值 |
|---|---|
| Language | 中文（与需求语言一致） |
| Programming Language | **Electron 45.2.2 + React + TypeScript + Vite**；`packages/core`、`packages/engine-ytdlp` 为纯 TS 包（零 electron / 零 fs 副作用）；按 §2 拍板，非通用默认栈 |
| Project Name | `ytvdlt`（snake_case） |
| 项目根 | `C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt`（本次新建 `docs/`） |
| 里程碑 | **M1 骨架与引擎契约**（硬边界）；M2–M5 仅为「不纳入本次」的排期标注 |
| 交付物 | 本文档 + §8 M1 范围代码骨架/契约（由架构师、工程师落地）；本文档不含业务代码 |

**原始需求复述**：把 Windows 桌面下载器 YTVDLT 的第一个里程碑 M1 做需求分析，产出一份中文结构化 PRD，重点是为 §4 功能矩阵的**每一个矩阵项**分配稳定的「可执行验收断言 ID」，标注其落地里程碑与验收层，并单独列出 M1 必须绿的断言；同时把 §8 的 5 条 M1 验收标准转成可判定条件，明确 M1 不做什么。

---

## 1. 产品目标与 M1 目标

**产品目标（一句话）**：YTVDLT 是把开源 Android 应用 Seal 的行为规格（§4 功能矩阵）干净室重写为 Windows x64 桌面应用——Electron 主进程以 `spawn(argv[])` 编排随包自带的 `yt-dlp.exe / ffmpeg / ffprobe / node.exe`，纯 TS Core 负责参数构造、队列状态机与本地持久化，最终以零外部依赖的 NSIS 安装版 + 便携版 EXE 交付；全过程不复制上游源码/资源、不实现任何绕过限制的能力。

**M1 目标（一段话）**：M1 不追求任何可见功能，而是先把「可验证的地基」立稳——建好 monorepo 与分层铁律、冻结 `shared` DTO 与 `DownloadEngine` 接口契约、实现 ConfigStore/Logger/ErrorMapper/RuntimeResolver 四个可离线单测的 Core 组件、打通 `probe()` → `JsonMapper` → `MediaInfo` 的解析链路，并按 §12.10 提前把 `resources/runtime/win-x64/`、`runtime-manifest.json` 与 `extraResources` 前置到位（避免 M5 返工），同时用 U3 实测确认本地直链可被 generic extractor 解析；最终以 L0/L1 全绿、Core 覆盖率 ≥70%、check-runtime 四项通过作为停下汇报的判据，并为 §4 全部矩阵项建立「项 → 断言 ID」的稳定映射，使后续里程碑的「功能完全一致」可逐条核验而非口头声明。

### 产品目标（3 个正交目标）

| # | 目标 | 可度量结果 |
|---|---|---|
| G1 | 建立可离线验证的骨架与分层契约 | `core`/`engine-ytdlp` 的 import 图不含 `electron`；`shared` DTO 全签名齐备；`npm test` 零网络全绿 |
| G2 | 锁定运行时自包含与启动自检前置 | `check-runtime` 4 项通过；`runtime-manifest.json` 全项 SHA-256 可校验；`extraResources` 已配置、运行时不入 asar |
| G3 | 打通解析链路并建立全矩阵断言基线 | `probe()` 对本地 fixture 返回完整 `MediaInfo`；§4 全部 74 个矩阵项各有 1 条稳定断言 ID；M1 必须绿断言清单可逐条判定 |

### 用户故事

| # | 用户故事 | M1 中的体现 |
|---|---|---|
| US-1 | **作为**首次启动应用的最终用户，**我希望**应用在启动瞬间自动核验 yt-dlp / ffmpeg+ffprobe / node(JS runtime) / aria2c 四项运行时并给出明确状态，**以便**缺少任一必需组件时得到可操作的错误提示而不是崩溃或静默失效 | M1 以 `RuntimeResolver` + `npm run check-runtime` 脚本体现（无 UI，见 §6） |
| US-2 | **作为**开发者 / 后续 UI 的调用方，**我希望**把一条 URL 交给 `probe()` 就能得到完整 `MediaInfo` DTO（标题/上传者/时长/缩略图/格式/字幕/章节），**以便** M3 的格式、字幕弹窗无需重新解析引擎契约 | `YtDlpEngine.probe()` + `JsonMapper`，U3 本地直链实测 |
| US-3 | **作为**开发者，**我希望**在完全断网的环境跑 `npm test` 覆盖 L0/L1 并看到 Core 覆盖率 ≥70%，**以便**验收结论不依赖外网可达性 | L0/L1 测试与 fixtures，`npm test` 零网络全绿 |
| US-4 | **作为**打包 / 发布者，**我希望** `runtime-manifest.json` 记录每个随包文件的 SHA-256 且 `check-runtime` 逐项校验，**以便** M5 打包前即可确认运行时完整、且外部 exe 不会误入 asar | §12.4 / §12.10 前置，`resources/runtime/win-x64/` + `electron-builder.yml` |
| US-5 | **作为**甲方，**我希望** M1 汇报附「矩阵项 → 断言 ID」对照表并停下等放行，**以便**逐里程碑核验「功能完全一致」而不靠口头声明 | 本 PRD §4 映射表 + §5 可判定条件 + §8 汇报模板 |

---

## 2. 需求池（P0 / P1 / P2）

> **P0 严格等于 §8 M1 范围 + §10 Step 0–5**，共 **18 条**。P1/P2 全部标注为后续里程碑，**不纳入本次**。

### 2.1 P0 — M1 必须（18 条）

| ID | P0 需求 | 权威来源 |
|---|---|---|
| P0-01 | 建立项目根 `ytvdlt/` 与 `docs/`，确认 Node/npm/pnpm 可用，完整阅读 HANDOFF v1.1 全文 | §10 Step 0 |
| P0-02 | 按 §6.6 建 monorepo 骨架：`package.json` / `pnpm-workspace.yaml` / `turbo.json` / `tsconfig.base.json` + `packages/{shared,core,engine-ytdlp}` / `apps/desktop` / `scripts` / `tests/fixtures` / `docs` | §8 M1；§10 Step 2 |
| P0-03 | 落实分层铁律：`core` 与 `engine-ytdlp` 不 import `electron`；跨层数据经 `packages/shared` 的 DTO；UI 不接触子进程 | §6.2；§10 Step 2/3 |
| P0-04 | 实现 §6.4 全套 shared DTO 与接口契约：`EngineEvent` / `Artifact` / `DownloadEngine`(probe/probePlaylist/download/version/selfUpdate) / `CancelHandle` / `AppError` / `ErrorCode` / `MediaInfo` / `PlaylistInfo` / `DownloadRequest`（分域 format/subtitle/paths/network/advanced）/ IPC channel 常量 | §8 M1；§10 Step 3 |
| P0-05 | 实现 `ConfigStore`：分域 + `schemaVersion` + 迁移 + 原子写（tmp+rename）+ 配置损坏回退默认并记 WARNING | §8 M1；§10 Step 3 |
| P0-06 | 实现 `Logger` + **脱敏**：JSONL 结构化落文件；argv 中 Cookie / 凭据 / token 一律掩码；崩溃报告与导出接口占位 | §8 M1；§10 Step 3；§6.7 |
| P0-07 | 实现 `ErrorMapper`：stderr 关键字 → §6.7 错误码 + 用户文案 + `retryable` + 已脱敏 `report` | §8 M1；§10 Step 3 |
| P0-08 | 实现 `RuntimeResolver`：启动自检 4 项运行时，按 `runtime-manifest.json` 逐项校验 SHA-256 与可执行性；缺失 → `ENGINE_MISSING`/`JS_RUNTIME_MISSING`/`FFMPEG_MISSING` + 不崩溃、不静默降级 | §8 M1；§10 Step 3；§12.4 铁律 3 |
| P0-09 | 实现 `YtDlpEngine.probe()`：`spawn` 绝对路径 + `argv[]`（`shell:false` / `windowsHide:true`）；注入 `--no-js-runtimes --js-runtimes node:<内置 node.exe>`；stdout JSON → `JsonMapper` → `MediaInfo` | §8 M1；§10 Step 4；F2/F3/F4 |
| P0-10 | 实现 `JsonMapper`：`--dump-single-json` JSON → `MediaInfo` DTO，字段完整映射与类型校验 | §8 M1；§10 Step 4 |
| P0-11 | 实现 `ArgvBuilder` **骨架（仅 probe 分支）** + spawn 安全铁律：URL 仅 `http(s)`、用户可控 token 置于 `--` 之后、绝不字符串拼接 shell | §8 M1 验收④；§10 Step 4；§6.7 |
| P0-12 | 实现 `fetch-runtime.mjs`：拉取 4 项运行时 + `SHA2-256SUMS` 校验 + 原子放置 | §8 M1；§10 Step 1；§12.4 |
| P0-13 | 实现 `check-runtime.mjs` / `npm run check-runtime`：4 项检测（yt-dlp / ffmpeg+ffprobe / node / aria2c 可选）输出版本与绝对路径 | §8 M1 验收①；§10 Step 1 |
| P0-14 | **【最高优先】验证 U3**：本地 HTTP `fixture.mp4` + `yt-dlp.exe -J --dump-single-json http://127.0.0.1:<port>/fixture.mp4` + 一次真实下载（含 ffmpeg 合并路径）；结论写入 `DECISIONS.md`；不支持则 L2 改 `FakeEngine`（同一 `DownloadEngine` 接口），C1–C12 不变 | §2 假设 5；§5.4 U3；§7.1；§9 R5；§10 Step 1 |
| P0-15 | 按 §12.4 备齐 `resources/runtime/win-x64/`：`yt-dlp.exe`(+SHA2-256SUMS)、`node.exe`、BtbN `*‑win64‑lgpl‑shared.zip` 整个 `bin/`、`FFMPEG-LICENSE.txt`；生成 `runtime-manifest.json`（path / sha256 / version / 来源 URL / release tag） | §12.4；§12.10；§10 Step 1 |
| P0-16 | 把 `extraResources` 配进 `electron-builder.yml`（from→`runtime`，filter `**/*`），用 `app.isPackaged` 切换开发/打包路径；**运行时绝不进 asar** | §12.4 铁律 1/2；§12.10 |
| P0-17 | 写 L0/L1 测试与 fixtures（`info-*.json` / `progress-*.log` / media fixture），跑 `npm test` 全绿，输出 **Core 覆盖率 ≥70%** 报告 | §8 M1 验收⑤；§10 Step 5 |
| P0-18 | 出 M1 汇报（按 §8 模板，附「矩阵项 → 断言 ID」对照表与 `acceptance-report.json`），**停下等甲方放行**；任何偏离写入 `DECISIONS.md` | §8 汇报模板；§10 Step 5；§2 变更控制 |

### 2.2 P1 — 后续里程碑（明确不纳入本次）

| ID | 需求 | 归属里程碑 |
|---|---|---|
| P1-01 | `ArgvBuilder` 下载分支 / `ProgressParser` / `--print-to-file after_move:filepath` / `CancelHandle` / `TaskQueue` 基础状态机 / `ArtifactVerifier` / `HistoryStore` / `verify-artifact.mjs` / L0–L2 测试基建 | **M2** |
| P1-02 | 完整性判据 **C1–C12** 全部通过、本地 HTTP fixture 走真实 yt-dlp 完成下载 | **M2** |
| P1-03 | §4.2/4.3/4.4 全部参数分支、格式/字幕/播放列表弹窗、`PathResolver` Windows 边界、自定义标题/模板/裁剪/章节 | **M3** |
| P1-04 | 并发调度（可配默认 3）、7 态完整状态机、快照持久化与恢复、播放列表批量入队、自定义命令模板 CRUD + 白名单、任务日志页、托盘与通知 | **M4** |

### 2.3 P2 — 后续里程碑 / 可选项（明确不纳入本次）

| ID | 需求 | 归属里程碑 |
|---|---|---|
| P2-01 | 深浅色主题、快捷键、空/错状态、i18n、双通道自动更新、L3 在线烟测 | **M5** |
| P2-02 | NSIS 安装版 + 便携版 EXE、干净虚拟机 **C13–C16**、FFmpeg LGPL 合规清单逐条、`THIRD_PARTY_NOTICES.md`、代码签名 | **M5** |
| P2-03 | `docs/*`（README/BUILD/ARCHITECTURE/ACCEPTANCE/SHORTCUTS/LICENSE-COMPLIANCE）全套 | **M5** |
| P2-04 | 真暂停、任务优先级、捆绑 aria2c、arm64 包 | **v1.1 延后**（§2 增强项） |

---

## 3. 「功能矩阵项 → 验收断言 ID」映射表（本次最重要产出）

### 3.0 编号与判定规则

- **断言 ID 格式**：`A-4.<节>-<两位序号>`，与 §4 表格行序一一对应，**稳定不可改号**；后续里程碑只追加/细化断言内容，不重编号。
- **每个矩阵项恰好绑定 1 条可执行断言**（§7.3「每个矩阵项在 M2–M4 至少绑定一条自动断言」；M1 的 7 项为契约层前置断言）。
- **里程碑**：M1 / M2 / M3 / M4 / M5 —— 指该断言**首次判绿**的里程碑。
- **层**：`L0`(零网络单测) / `L1`(引擎契约：录制 JSON、日志、FakeEngine) / `L2`(离线端到端：本地 HTTP fixture + 真实 yt-dlp，含 UI 回归) / `L3`(在线烟测，不可达记 `SKIPPED` 不判 FAIL) / `L4-packaging`(C13–C16 干净虚拟机/便携版/运行时完整性)。
- **「M1 必须绿」**：仅指 M1 能以 Core/契约层（零 UI、零网络）判定的断言；其 UI 表现层在后续里程碑复验，见「备注」列。
- §4 矩阵本身不含打包项，`L4-packaging` 由补充断言 `A-INF-02`（M1 前置）与 §12.8 C13–C16（M5）覆盖。
- **§7 完整性判据映射（横切，不逐项绑定）**：`C1–C12` → **M2 / L2**；`C13–C16` → **M5 / L4-packaging**；C1–C12 在 U3 不支持时改由 `FakeEngine` 回放，**判据不变**（§7.1）。

### 3.1 §4.1 输入、解析、播放列表（7 项）

| 断言 ID | 矩阵项 | 可执行断言（判定条件） | 里程碑 | 层 | M1 必须绿 | 备注 |
|---|---|---|---|---|---|---|
| A-4.1-01 | 粘贴/输入链接并解析 | `UrlExtractor` 单测：含 3 条链接文本 → 输出 3 条且 `toSet()` 去重；纯文本 → 返回空集且不抛异常 | M3 | L0 | — | UI 行内错误在 M3 复验 |
| A-4.1-02 | 系统分享/打开链接 | `--url` 参数与 `Ctrl+Shift+V` 全局热键唤起后，输入框预填为复制的链接 | M5 | L2 | — | 协议关联 + 快捷键，M5 |
| A-4.1-03 | 已保存链接 | `ConfigStore` 的 `saved_links` 域：写入 2 条 → 原子写落盘 → 重新加载仍在；文件损坏 → 回退默认并 WARNING | **M1** | L0 | ✅ **M1 必须绿** | 仅验持久化契约；「一键填入」UI 在 M3 |
| A-4.1-04 | 抓取视频元数据 | 录制 `--dump-single-json` fixture → `JsonMapper` → `MediaInfo`，`title`/`uploader`/`duration`/`thumbnail`/`formats[]`/`subtitles`/`chapters` 字段齐全且类型正确 | **M1** | L1 | ✅ **M1 必须绿** | L2 的 `probe()` 本地直链实测由 `A-INF-07` 绑定 |
| A-4.1-05 | 播放列表解析 | 录制 `--flat-playlist --dump-single-json` → `PlaylistInfo`，按 `_type` 分流，条目数与标题逐条一致 | M3 | L1 | — | `probePlaylist()` 在 M3 实现 |
| A-4.1-06 | 播放列表条目选择与批量入队 | 选 5 条 → 生成 5 个独立任务、独立进度、并发不超上限 | M4 | L2 | — | §8 M4 验收③ |
| A-4.1-07 | 下载类型 4 种 | 切 Audio → 字幕嵌入项置灰；切 Command → GUI 格式项禁用并说明；四态互斥校验通过 | M3 | L2 | — | Playwright 回归见 M3 验收④ |

### 3.2 §4.2 视频清晰度与格式（13 项）

| 断言 ID | 矩阵项 | 可执行断言（判定条件） | 里程碑 | 层 | M1 必须绿 | 备注 |
|---|---|---|---|---|---|---|
| A-4.2-01 | 清晰度档位 | `ArgvBuilder` 单测：1080p / 720p / 最佳 → 命令分别含 `-S res:1080` / `-S res:720` / 无 res 约束 | M3 | L0 | — | 用 `-S` 而非 `-f` 硬指定 |
| A-4.2-02 | 编码偏好 / AV1 | 质量+AV1 → `vcodec:av01`；关闭 → `vp9.2`；兼容 → `vcodec:h264` | M3 | L0 | — | 桌面不做 Android 硬解检测 |
| A-4.2-03 | 自定义格式排序 | 填 `res:720,ext:mp4` → `-S` 含该值；留空 → 回退预设排序 | M3 | L0 | — | `sorting_fields` 存 ConfigStore |
| A-4.2-04 | 手动格式选择弹窗 | 选 `137`+`251` → `-f 137+251`；合计体积 = 两者体积之和 | M3 | L0 | — | UI 三组分栏截图在 M3 验收④ |
| A-4.2-05 | 多音频流合并 | 单测覆盖 1 条 / 2 条 audio-only 分支：≥2 时自动置 `--audio-multistreams` | M3 | L0 | — | — |
| A-4.2-06 | 仅下载音频 | `-x` → 产物纯音频、落音频目录、`ffprobe` 无 video 流（C6） | M2 | L2 | — | C6 音视频流完整性 |
| A-4.2-07 | 音频质量档位 | `abr~192` / `128` / `64` + 最佳 / 最低，单测覆盖 5 分支 | M3 | L0 | — | — |
| A-4.2-08 | 音频编码偏好 | 选 OPUS → 命令含 `acodec:opus` | M3 | L0 | — | — |
| A-4.2-09 | 音频转码 | 开转 MP3 → 含 `--audio-format mp3` 且**不含** `-S abr~`（互斥校验） | M3 | L0 | — | mp3 编码器可用性 U4 在 M2 实测 |
| A-4.2-10 | 元数据/封面嵌入 | 音频产物含标题/作者/封面标签；裁剪时封面为正方形（显式 `--ppa`，不写临时 config） | M3 | L2 | — | — |
| A-4.2-11 | 缩略图/章节/容器 | 嵌入字幕 → 产物为 mkv 且含字幕轨；开缩略图 → 同目录 png（C9） | M3 | L2 | — | — |
| A-4.2-12 | 片段裁剪 / 章节拆分 | 选 00:30-01:00 → 产物时长约 30s；有章节 → 每章一文件且历史逐条（C5/C8） | M3 | L2 | — | — |
| A-4.2-13 | 自定义标题 / 输出模板 | 标题含 `:` / emoji → `PathResolver` 净化后正常落盘且不抛异常；自定义模板生效 | M3 | L0 | — | Windows 非法字符/保留名/长路径 |

### 3.3 §4.3 字幕（8 项）

| 断言 ID | 矩阵项 | 可执行断言（判定条件） | 里程碑 | 层 | M1 必须绿 | 备注 |
|---|---|---|---|---|---|---|
| A-4.3-01 | 字幕下载开关 | 开 → 含 `--write-subs`；关 → 不含任何字幕参数 | M3 | L0 | — | `SubtitlePlanner` |
| A-4.3-02 | 字幕语言 | 填 `zh.*,en.*` → `--sub-langs` 值与产物语言一致；非法式前端提示 | M3 | L0 | — | 默认 `en.*,.*-orig` |
| A-4.3-03 | 自动字幕 | 开自动字幕且关翻译 → `--write-auto-subs` 与 `youtube:skip=translated_subs` 同时出现 | M3 | L0 | — | — |
| A-4.3-04 | 自动翻译字幕 | 开启 → 命令**不含** `skip=translated_subs`；实验性提示保留 | M3 | L0 | — | — |
| A-4.3-05 | 字幕格式转换 | ass / srt / vtt / lrc / 不转换 五分支：命令与文件后缀一致（C9），单测 5 分支 | M3 | L0 | — | — |
| A-4.3-06 | 字幕嵌入视频 | 视频嵌入 → mkv 且容器内 subtitle 流存在；Audio 模式该项不可点 | M3 | L2 | — | 自动 `mergeToMkv=true` |
| A-4.3-07 | 保留独立字幕文件 | 嵌入 + keepSubtitle 同时开 → 既有 `.srt` 又有内嵌轨 | M3 | L2 | — | — |
| A-4.3-08 | 格式页按语言多选 | 选 `zh-Hans`+`en`+自动字幕 → `--sub-langs ...` 且 `--write-auto-subs`，已选计数正确 | M3 | L2 | — | 强制 `downloadSubtitle=true` |

### 3.4 §4.4 路径、文件、队列、进度、历史、设置（30 项）

| 断言 ID | 矩阵项 | 可执行断言（判定条件） | 里程碑 | 层 | M1 必须绿 | 备注 |
|---|---|---|---|---|---|---|
| A-4.4-01 | 视频/音频/命令三目录 | 分设 `D:\Videos` / `D:\Music` → 各落对应目录；重启后路径保留 | M3 | L2 | — | 默认 `%USERPROFILE%\Downloads\YTVDLT` |
| A-4.4-02 | 私有目录 | 开启 → 落 `%LOCALAPPDATA%\YTVDLT\private` 且历史不新增 | M3 | L2 | — | — |
| A-4.4-03 | 按站点/播放列表建子目录 | `PathResolver.buildOutputDir()` 纯函数：两开关全开 → `<dir>/<extractor>/<playlist>/`，单测 4 组合 | M3 | L0 | — | — |
| A-4.4-04 | 输出模板与文件名净化 | 超长含非法字符标题 → 截断且不抛异常；保留名 / 260+ 长路径单测通过 | M3 | L0 | — | `--restrict-filenames` |
| A-4.4-05 | 临时文件与清理 | 取消 → `.part` 保留；清理 → 正式产物不受影响（仅删应用自建 temp） | M2 | L2 | — | 二次确认 |
| A-4.4-06 | 下载归档去重 | 同视频下两次 → 第二次明确 `ALREADY_DOWNLOADED`；清空归档后可重试 | M2 | L2 | — | 与 A-4.5-06 同判据 |
| A-4.4-07 | 完成后入库/打开/分享/删除 | 完成 → 历史新增 1 条、路径可打开、`videoPath` 无重复（C11）；勾选删文件 → 磁盘一并移除 | M2 | L2 | — | C11 历史一致性 |
| A-4.4-08 | 历史搜索/过滤 | `HistoryStore` 查询单测：标题片段 → 仅匹配项；按 Audio 过滤 → 仅音频 | M2 | L0 | — | — |
| A-4.4-09 | 并发队列 | 入队 7 → 同时运行 ≤3 且自动补位；上限设 1 → 严格串行 | M4 | L2 | — | 并发可配默认 3 |
| A-4.4-10 | 任务状态机 | 7 态（Idle/FetchingInfo/ReadyWithInfo/Running/Completed/Error/Canceled）全部合法转移通过、非法转移拒绝 | M4 | L0 | — | M2 建基础状态机，M4 完整 |
| A-4.4-11 | 下载进度 | 录制进度日志 → `ProgressParser` → `ProgressEvent`，下载中百分比递增；解析阶段不确定动画 | M2 | L1 | — | F7 `--progress-template` |
| A-4.4-12 | 速度 / 剩余时间 | 结构化 `speed`/`eta` 字段可解析并更新；无字段时显「—」 | M2 | L1 | — | 桌面增强，文档注明差异 |
| A-4.4-13 | 暂停 | 运行中点击 → 状态为 `Canceled` 而非 `Paused`；README 明确「无暂停」 | M2 | L2 | — | §9 禁止事项 8 |
| A-4.4-14 | 取消 / 重试 | 取消 → 进度保留、进程消失、`.part` 保留；重试 → 不重抓信息即可继续（C10 哈希一致） | M2 | L2 | — | C10 续传一致性 |
| A-4.4-15 | 队列持久化与恢复 | 下载中强杀 → 重启后任务仍在、显示上次进度、可重试；运行/解析中一律转 `Canceled` | M4 | L2 | — | — |
| A-4.4-16 | 任务筛选与空状态 | 无任务 → 空状态引导；切「已完成」→ 仅完成项；四 Tab 生效 | M5 | L2 | — | — |
| A-4.4-17 | 任务详情操作 | 右键菜单每项逐一可触发；复制错误报告含 URL 与错误摘要 | M4 | L2 | — | — |
| A-4.4-18 | 通知与错误报告 | 失败 → 托盘提示 + 详情含 URL、引擎版本、完整 stderr；可复制 | M4 | L2 | — | — |
| A-4.4-19 | 设置持久化 | `ConfigStore` 分域 + `schemaVersion` + 迁移 + 原子写：改任一设置 → 重启保持；配置损坏 → 回退默认并 WARNING | **M1** | L0 | ✅ **M1 必须绿** | 仅验 Core 契约；108+ 键全量在 M3/M4 补齐 |
| A-4.4-20 | 深浅色主题 / 外观 | 切深色 → 全页即时；跟随系统 → 随 Windows 主题变化；强调色跟随系统 | M5 | L2 | — | — |
| A-4.4-21 | 语言/本地化 | 切英文 → 全部文案切换且布局不溢出（zh-CN / en） | M5 | L2 | — | — |
| A-4.4-22 | 隐私模式 / 禁用预览 | 开启隐私模式下载 → 文件存在但历史无新增；关预览 → 不显示缩略图 | M2 | L2 | — | — |
| A-4.4-23 | 自定义命令模板/日志 | 新建模板执行 → 日志逐行、可复制、可取消重试；含禁用选项 → `CUSTOM_COMMAND_REJECTED` 且不执行 | M4 | L2 | — | 参数白名单防注入 |
| A-4.4-24 | 模板/历史/快捷方式备份导出导入 | `ConfigStore.export()`/`import()` 带 schema 版本与去重：导出 → 清空 → 导入 → 数量一致且无重复 | M4 | L0 | — | — |
| A-4.4-25 | 网络选项 | 设 500K → `-r 500K`；设代理 → 经代理；aria2c 与 `--concurrent-fragments` 互斥 | M3 | L0 | — | — |
| A-4.4-26 | Cookies / UA | 导入合法 `cookies.txt` → `--cookies <path>`；空文件 → 明确报错；**断言命令中不含 `--cookies-from-browser`** | M3 | L0 | — | 合规禁用项，永久不实现自动抓取浏览器凭据 |
| A-4.4-27 | SponsorBlock | 选分类 → 命令含对应值；模拟 SB API 失败 → 下载完成且仅 WARNING（降级） | M3 | L2 | — | 与 A-4.5-07 同判据 |
| A-4.4-28 | yt-dlp 引擎更新 | 手动检查 → 显示当前/最新；升级后 `--version` 变化；离线 → 明确报错；`SHA2-256SUMS` 校验 + 失败回滚 | M5 | L3 | — | 网络不可达记 `SKIPPED`；M1 `fetch-runtime.mjs` 为前置（A-INF-02） |
| A-4.4-29 | 应用自更新 | 有新版本 → 提示并可一键更新；无网络 → 静默降级记日志 | M5 | L3 | — | `electron-updater` + NSIS |
| A-4.4-30 | 调试/日志 | `Logger` 输出为 JSONL 结构化行；argv 中 Cookie / 凭据 / token 全部掩码，`report` 全字段已脱敏 | **M1** | L0 | ✅ **M1 必须绿** | 仅验脱敏与结构化；`-v` 调试参数在 M2/M3 ArgvBuilder 下载分支 |

### 3.5 §4.5 错误处理（9 项）

| 断言 ID | 矩阵项 | 可执行断言（判定条件） | 里程碑 | 层 | M1 必须绿 | 备注 |
|---|---|---|---|---|---|---|
| A-4.5-01 | 空链接 | 空输入 → 行内校验提示且「开始下载」按钮禁用；`ErrorMapper` 注册 `INVALID_URL` | M3 | L0 | — | UI 表现层在 M3；错误码契约由 M1 ErrorMapper 覆盖 |
| A-4.5-02 | 链接无法匹配 | 粘贴非 URL → 明确提示、不创建任务 | M3 | L0 | — | `UrlExtractor` |
| A-4.5-03 | 链接无效/站点不支持 | `ErrorMapper` 单测：输入 `example.invalid` 的 stderr → `UNSUPPORTED_SITE` + `retryable` + 原文保留 + 脱敏 `report`，不抛异常 | **M1** | L0 | ✅ **M1 必须绿** | 仅验契约层；UI 折叠/复制在 M5 |
| A-4.5-04 | 格式不可用 | 手填不存在 id → `FORMAT_UNAVAILABLE`，保留重试 | M3 | L0 | — | M1 ErrorMapper 已注册该码 |
| A-4.5-05 | 网络失败/超时 | `ErrorMapper` 单测：超时 / DNS / HTTP 403 / HTTP 429 四类 stderr → 分别映射 `NETWORK_TIMEOUT`/`DNS_FAILURE`/`HTTP_403`/`HTTP_429` 且分类互斥 | **M1** | L0 | ✅ **M1 必须绿** | 仅验分类契约；断网秒级超时与恢复重试在 M2 L2 |
| A-4.5-06 | 归档重复 | 同视频下载两次 → 第二次 `ALREADY_DOWNLOADED` 且不创建重复产物 | M2 | L2 | — | 与 A-4.4-06 同判据 |
| A-4.5-07 | SponsorBlock API 失败 | 模拟失败 → 下载完成且仅 WARNING，不判 FAIL | M3 | L2 | — | 与 A-4.4-27 同判据 |
| A-4.5-08 | 崩溃与全局异常 | 注入异常 → 生成含版本信息的崩溃报告文件且不静默吞错；下次启动提示 | M5 | L2 | — | Logger 崩溃报告接口在 M1 占位（P0-06） |
| A-4.5-09 | 错误报告内容 | `AppError.report` 含 OS / 应用版本 / 引擎版本 / URL / 完整 stderr，且 Cookie 与凭据均已掩码 | **M1** | L0 | ✅ **M1 必须绿** | `ErrorMapper` + `Logger` 脱敏联合断言 |

### 3.6 §4.6 安卓平台特有功能与等价替代（7 项）

| 断言 ID | 矩阵项 | 可执行断言（判定条件） | 里程碑 | 层 | M1 必须绿 | 备注 |
|---|---|---|---|---|---|---|
| A-4.6-01 | SAF 目录树 / SD 卡 URI | 选 UNC 路径 → 可写入且重启保留（持久化绝对路径） | M3 | L2 | — | 原生目录对话框 |
| A-4.6-02 | MediaScanner / FileProvider | 点「打开文件」→ 系统默认播放器启动；点「所在文件夹」→ 资源管理器选中 | M2 | L2 | — | `ShellExecute` |
| A-4.6-03 | 前台服务 + 通知 | 下载中关主窗口 → 下载继续、托盘有进度 | M4 | L2 | — | 托盘常驻 |
| A-4.6-04 | WebView 登录生成 Cookie | **断言不存在内置 WebView 登录路径**；仅接受用户手动导入自有 `cookies.txt`；空文件 → 明确报错 | M3 | L0 | — | 合规禁用项，永久不做替代绕过 |
| A-4.6-05 | 蜂窝/计量网络判断 | 计量网络 → 弹确认；用户允许后才开始下载 | M4 | L2 | — | Windows 计费网络检测 |
| A-4.6-06 | 动态取色 / 触觉反馈 / 预测式返回 | 系统强调色变更 → 应用主色跟随；触觉反馈明确省略（无等价硬件）；转场动效生效 | M5 | L2 | — | §2 默认假设 6 |
| A-4.6-07 | 电池优化 / APK 安装 | 无残留 Android 专用 UI 或报错；改为可选「开机自启/后台运行」 | M5 | L2 | — | — |

### 3.7 映射表统计（自检）

| 维度 | 分布 | 合计 |
|---|---|---|
| 按节 | 4.1=7、4.2=13、4.3=8、4.4=30、4.5=9、4.6=7 | **74 行** |
| 按里程碑 | M1=7、M2=12、M3=36、M4=10、M5=9 | **74 行** |
| 按层 | L0=32、L1=4、L2=36、L3=2、L4-packaging=0（见 3.8/3.9） | **74 行** |
| M1 必须绿（矩阵项内） | A-4.1-03、A-4.1-04、A-4.4-19、A-4.4-30、A-4.5-03、A-4.5-05、A-4.5-09 | **7 条** |

### 3.8 M1 骨架 / 契约补充断言（绑定 §8 M1 范围、§10 Step 0–5、§12.4、U3；非 §4 矩阵项）

> §8 M1 范围与 §10/§12.4 的多数交付物不是 §4 矩阵项，需独立断言 ID（`A-INF-xx`）才能做到「每条交付物绑定一条可执行断言」。

| 断言 ID | 绑定来源 | 可执行断言（判定条件） | 里程碑 | 层 | 对应 M1 验收 | M1 必须绿 |
|---|---|---|---|---|---|---|
| A-INF-01 | §8 M1 / §10 Step 0,2,3 | `pnpm-workspace.yaml`/`turbo.json`/`tsconfig.base.json` 存在且 workspace 全解析；`shared` 导出 §6.4 全部类型；`core`/`engine-ytdlp` import 图不含 `electron` | M1 | L0 | — | ✅ **M1 必须绿** |
| A-INF-02 | §12.4 / §12.10 / §10 Step 1 | `resources/runtime/win-x64/` 含 4 项运行时 + `FFMPEG-LICENSE.txt`；`runtime-manifest.json` 全项 SHA-256 与磁盘文件一致；`electron-builder.yml` 含 `extraResources`(from→runtime)；`app.isPackaged` 双路径切换存在；运行时不在 asar | M1 | **L4-packaging（前置）** | — | ✅ **M1 必须绿** |
| A-INF-03 | §5.4 U3 / §7.1 / §9 R5 / §10 Step 1 | 本地 HTTP `fixture.mp4` 上 `yt-dlp.exe -J --dump-single-json` 退出 0 且返回完整 JSON；一次真实下载（含 ffmpeg 合并）成功；**结论写入 `DECISIONS.md`**（不支持 → L2 改 `FakeEngine`，C1–C12 不变） | M1 | L2 | — | ✅ **M1 必须绿** |
| A-INF-04 | §8 M1 / §10 Step 1 | `npm run check-runtime` 4 项中 3 项必需全部 OK、路径为 `resources/runtime/win-x64` 绝对路径、版本号非空；aria2c 缺失标 OPTIONAL 不判 FAIL；`yt-dlp.exe --version` / `ffmpeg.exe -version` / `node.exe --version` 均退出 0；缺必需项 → 专用错误码且不崩溃 | M1 | L0 | ① | ✅ **M1 必须绿** |
| A-INF-05 | §8 M1 验收④ / §10 Step 4 | `ArgvBuilder.build(ProbeRequest)` 纯函数输出 argv 数组且按序含 `-J --dump-single-json --no-playlist --no-warnings --socket-timeout 5 -R 1 --no-js-runtimes --js-runtimes node:<path> -- <url>`；不含 shell 元字符拼接、`shell:false`；URL 白名单拒 `file://`/UNC/本地路径；probe 分支覆盖率 100% | M1 | L0 | ④ | ✅ **M1 必须绿** |
| A-INF-06 | §8 M1 验收⑤ / §10 Step 5 | `packages/core` + `packages/engine-ytdlp` 的 Vitest coverage（lines/branches/functions/statements 取最低值）≥70%；L0+L1 全绿、零网络；`npm test` 退出码 0 | M1 | L0 | ⑤ | ✅ **M1 必须绿** |
| A-INF-07 | §8 M1 验收③ / §10 Step 4 | `YtDlpEngine.probe()` 对 U3 本地直链 fixture 退出 0，返回完整 `MediaInfo` 且字段契约与 `A-4.1-04` 一致；spawn 使用绝对路径 + `argv[]` | M1 | L2 | ③ | ✅ **M1 必须绿** |
| A-INF-08 | §8 M1 验收② / §10 Step 5 | `tests/fixtures/info-*.json`（≥1 视频 + ≥1 flat-playlist）经 `JsonMapper` 映射全绿：字段存在且类型正确、0 FAIL、不触网、不 spawn 外部进程 | M1 | L1 | ② | ✅ **M1 必须绿** |
| A-INF-09 | §10 Step 5 / §8 汇报模板 | M1 汇报按 §8 模板产出（完成项/改动文件/运行命令/验收命令与输出摘要/矩阵项→断言 ID 对照表/剩余与偏离），附 `acceptance-report.json`；`DECISIONS.md` 已留痕；**汇报后停下等放行，未放行不进入 M2** | M1 | L0（文档/流程） | — | ✅ **M1 必须绿** |
| A-INF-10 | §6.4 / §8 M1 | `DownloadEngine` 接口 5 个方法签名齐备；存在一个实现同一接口的 `FakeEngine` 桩（供 U3 不支持时 L2 回放），证明引擎可替换性硬要求成立 | M1 | L1 | — | ✅ **M1 必须绿** |

### 3.9 「M1 必须绿」断言 ID 汇总（17 条）

**来自 §4 矩阵项（7 条）**
`A-4.1-03`、`A-4.1-04`、`A-4.4-19`、`A-4.4-30`、`A-4.5-03`、`A-4.5-05`、`A-4.5-09`

**来自 M1 骨架/契约补充（10 条）**
`A-INF-01`、`A-INF-02`、`A-INF-03`、`A-INF-04`、`A-INF-05`、`A-INF-06`、`A-INF-07`、`A-INF-08`、`A-INF-09`、`A-INF-10`

> 判定口径：上述 17 条在 M1 汇报时必须全部为 `PASS`（L3 不适用，M1 无在线断言）；任一 `FAIL` 不得出汇报、不得推进 M2。

---

## 4. M1 五条验收标准 → 可判定条件

> 来源 §8 M1 表格。全部为零网络 / 零 UI 判定；`acceptance-report.json` 每项含 `id / layer / status(PASS|FAIL|SKIPPED) / expected / actual / durationMs / evidence`。

| # | §8 原标准（复述） | 可判定 PASS 条件 | 执行命令 / 证据 | 绑定断言 ID | FAIL 判据 |
|---|---|---|---|---|---|
| ① | `npm run check-runtime` 4 项通过 | 3 项必需（yt-dlp.exe / ffmpeg.exe+ffprobe.exe / node.exe）全部 `status=OK`、路径为 `resources/runtime/win-x64/` 下**绝对路径**、版本号非空；aria2c 缺失仅记 `OPTIONAL`，不判 FAIL；`yt-dlp.exe --version`、`ffmpeg.exe -version`、`node.exe --version` 退出码均为 0；人为移除任一必需 exe → 输出对应 `ENGINE_MISSING`/`JS_RUNTIME_MISSING`/`FFMPEG_MISSING` 且**不崩溃、不静默降级**；脚本退出码 0 | `npm run check-runtime`；`node scripts/check-runtime.mjs --json`；`DECISIONS.md` 记录 4 项版本 | `A-INF-04`（+ `A-INF-02` 哈希前置、`P0-08`） | 任一必需项 status≠OK、版本号为空、路径为相对路径/PATH 查找、或缺失时无专用错误码 |
| ② | fixture 驱动 `JsonMapper` 单测全绿 | `tests/fixtures/info-*.json`（录制的 `--dump-single-json`，≥1 单视频 + ≥1 flat-playlist）经 `JsonMapper` → `MediaInfo`/`PlaylistInfo`，`title`/`uploader`/`duration`/`thumbnail`/`formats[].format_id`/`subtitles`/`chapters` 字段存在且类型正确；0 FAIL / 0 ERROR；**不触网、不 spawn 外部进程** | `npm run test:unit -- --run JsonMapper`；`npm run test:contract` | `A-INF-08`（矩阵项 `A-4.1-04`） | 任一 fixture 映射字段缺失/类型错误，或测试访问网络 / 起外部进程 |
| ③ | `probe()` 对本地 fixture 返回完整 `MediaInfo` | 本地 HTTP 服务 `http://127.0.0.1:<port>/fixture.mp4`（U3）下调用 `YtDlpEngine.probe()` → 退出 0，返回 `MediaInfo` 且 `id`/`title`/`duration`/`formats`/`thumbnail`/`ext` 与 ② 契约一致；spawn 使用**绝对路径 + `argv[]`**（`shell:false`）；已注入 `--no-js-runtimes --js-runtimes node:<内置 node.exe>`。**若 U3 判不支持**：改由录制 fixture 回放验证，结论写入 `DECISIONS.md`，C1–C12 判据不变 | `npm run test:integration:offline -- --case probe-local`（M1 仅此 1 条 L2 用例）；`yt-dlp.exe -J --dump-single-json http://127.0.0.1:<port>/fixture.mp4` 原始输出留证 | `A-INF-07`、`A-INF-03`（矩阵项 `A-4.1-04`） | `MediaInfo` 字段缺失、spawn 非绝对路径 / `shell:true`、未注入 JS runtime 参数，或 U3 结论未写入 `DECISIONS.md` |
| ④ | `ArgvBuilder` 骨架单测覆盖 probe 分支 | `ArgvBuilder.build(ProbeRequest)` 为**纯函数**、返回 `string[]`；按序断言含 `-J` / `--dump-single-json` / `--no-playlist` / `--no-warnings` / `--socket-timeout 5` / `-R 1` / `--no-js-runtimes` / `--js-runtimes node:<path>` / `--` / `<url>`；断言无 shell 元字符拼接、`shell:false`；URL 白名单仅 `http(s)`，`file://`、UNC、本地路径被拒；**probe 分支分支覆盖率 100%** | `npm run test:unit -- --run ArgvBuilder --coverage` | `A-INF-05` | 参数缺失/顺序错误、出现字符串拼接命令、`shell:true`、URL 白名单可绕过 |
| ⑤ | **Core 覆盖率 ≥70%** | `packages/core` + `packages/engine-ytdlp` 的 Vitest coverage 中 `lines` / `branches` / `functions` / `statements` **取最低值 ≥70%**；L0 + L1 全部 `PASS`、零网络；`npm test` 退出码 0；覆盖率报告写入 `coverage/` 并作为 M1 汇报附件 | `npm test`；`npm run test:unit -- --coverage`；`coverage/coverage-summary.json` | `A-INF-06`（+ `A-4.4-19` / `A-4.4-30` / `A-4.5-03` / `A-4.5-05` / `A-4.5-09` / `A-4.1-03`） | 任一覆盖率维度 <70%，或 L0/L1 存在 FAIL，或测试依赖外网 |

> **口径观察项（不阻塞，见 §6）**：§7.1 定 L0 全局目标「Core 覆盖率 ≥80%」，§8 M1 验收⑤ 定「≥70%」。**M1 按 §8 取 ≥70% 判定**，在 M2–M5 收敛至 ≥80%，并写入 `DECISIONS.md`。

---

## 5. UI 设计稿

**按 §9 禁止事项 7，M1 无 UI 交付**：本里程碑不产出任何页面、组件、线框稿或视觉稿；UI 设计留待 M3–M5 按 §6.8 展开。

---

## 6. 待确认问题 / 已定假设

> 本节**只列不影响开工的观察项**，不就选型、命名、平台、技术栈发问（§2 已拍板，§9 禁止事项 1）。下列均为「记录并继续」，不是待甲方决策的阻塞项。

### 6.1 已定假设（已探测环境事实，直接采信生效）

| ID | 已定假设 |
|---|---|
| HA-01 | **Windows x64**（目标 Win10 1809+ / Win11 x64）；Bash 可用（Git Bash） |
| HA-02 | **Node v22.22.2 / npm 10.9.7**；**pnpm 未安装** → 按 §10 Step 0「确认 Node/npm/pnpm 可用」，用 `corepack enable` 或 `npm i -g pnpm` 补齐；**不更换包管理器**（§6.6 已定 pnpm workspace + turbo） |
| HA-03 | **Python 3.13.14** 可用，仅作本机工具；运行时不依赖 Python（`yt-dlp.exe` 为 PyInstaller 单文件自带解释器，F16） |
| HA-04 | **外网可达**：`api.github.com` 200 / `registry.npmjs.org` 200 / `nodejs.org` 200 → `fetch-runtime.mjs` 可拉取 4 项运行时；**但 L0–L2 验收本身零网络** |
| HA-05 | 工作区当前为空；项目根 `ytvdlt/` 与 `docs/` 由本次新建（已建） |
| HA-06 | §2 拍板项直接生效：产品名 YTVDLT / 仅 Windows x64 / Electron 45.2.2 + React + TS + Vite / 官方 yt-dlp.exe 外部子进程 / 并发可配默认 3 / 全自包含分发 / L3 不可达记 SKIPPED |
| HA-07 | 唯一权威输入为 HANDOFF v1.1（933 行）；`_seal_analysis/` 非必需，仅作背景，**不复制**其 Kotlin/Java 源码或资源 |
| HA-08 | M1 汇报后停下等甲方放行，未放行不进入 M2（§0 / §8 / §10 Step 5） |

### 6.2 观察项（不阻塞开工，M1/M2/M5 记录留痕即可）

| ID | 观察项 | 处理 |
|---|---|---|
| Q-01 | §7.1 定 L0 覆盖率 ≥80%，§8 M1 验收⑤ 定 ≥70% | M1 按 §8 取 ≥70%，M2–M5 收敛到 ≥80%；写入 `DECISIONS.md`，不阻塞 |
| Q-02 | U3（generic extractor 能否处理本地直链）结论未定 | 已排为 **P0-14 / A-INF-03**，M1 Step 1 实测后写入 `DECISIONS.md`；不支持 → L2 改 `FakeEngine`，C1–C12 不变（§9 R5）。属已排定验证项，非待决问题 |
| Q-03 | `yt-dlp-ejs` 独立仓库 404（F14 / U2） | 依赖官方 exe 内置组件，不单独获取；每轮引擎升级验证 `--js-runtimes` 行为。不阻塞 |
| Q-04 | Seal main 具体 commit hash 未核实（U1） | 记录快照版本 `2.0.0-alpha.5` 即可。不阻塞 |
| Q-05 | FFmpeg LGPL 构建是否含 libmp3lame（U4）、所用 yt-dlp 是否支持 `--ffmpeg-location`（U8）、干净虚拟机 UCRT/VC++ 缺口（U7）、代码签名证书（U5） | 均为 M2 / M5 的实测项，不阻塞 M1 |
| Q-06 | `runtime-manifest.json` 中 BtbN autobuild release tag 与 FFmpeg 精确 commit 的对应关系 | M1 先按实际下载产物逐项记录 SHA-256 / version / 来源 URL；§12.5 合规清单在 M5 逐条补齐。不阻塞 |
| Q-07 | `fetch-runtime.mjs` 拉取的 yt-dlp 版本以 §10 Step 1「2026.10.26 或更新 stable」为准 | 若 API 返回更新版本，以实际 `SHA2-256SUMS` 校验通过的版本记录进 manifest，无需甲方先行确认 |
| Q-08 | §4 中数个矩阵项的断言落在 M3–M5 且需 UI/在线环境 | 断言 ID 已提前分配且**稳定不改号**；M1 只判 17 条「必须绿」，其余在对应里程碑判绿。不阻塞 |

---

## 7. M1 不做什么（明确清单）

| # | 不做项 | 归属 / 依据 |
|---|---|---|
| 1 | **不写任何 UI**：页面、组件、线框稿、视觉稿、主题、快捷键、i18n、托盘 UI、空/错状态 | §9 禁止事项 7；§6.8 留待 M3–M5 |
| 2 | **不做下载闭环**：`download()`、`--print-to-file after_move:filepath`、`CancelHandle`、`ArtifactVerifier`、`HistoryStore`、`verify-artifact.mjs` | M2 / §8 |
| 3 | **不做格式/字幕/路径全量参数分支**：§4.2/4.3/4.4 参数组合、三个弹窗、`PathResolver` Windows 边界、自定义标题/模板/裁剪/章节 | M3 / §8 |
| 4 | **不做并发队列**：并发调度（默认 3）、7 态完整状态机、快照持久化与恢复、播放列表批量入队、自定义命令模板与白名单、任务日志页、托盘与通知 | M4 / §8 |
| 5 | **不做结构化进度链路**：`ProgressParser` 下载流、速度/ETA、C1–C12 完整性判据、取消/重试闭环 | M2 / §7.2 |
| 6 | **不做 NSIS 安装版 / 便携版 EXE 打包、代码签名、干净虚拟机 C13–C16、FFmpeg LGPL 合规清单逐条落地、`THIRD_PARTY_NOTICES.md`** | M5 / §12；**M1 只做 §12.4 前置**（P0-15/16） |
| 7 | **不做 L3 在线烟测**（网络不可达记 `SKIPPED`） | M5 / §7.1 |
| 8 | **不实现** `probePlaylist()`、`selfUpdate()`、`electron-updater` 应用自更新 | M3 / M4 / M5 |
| 9 | **不实现任何绕过 DRM / 付费墙 / 登录限制 / 地区限制 / 年龄限制的能力；不生成或注入 PO Token；不自动抓取浏览器凭据（`--cookies-from-browser`）；不内置 WebView 登录；不降低 TLS 校验** | §9 禁止事项 4 / §6.7 合规边界 —— **永久不做，非仅 M1** |
| 10 | **不复制** Seal 的 Kotlin/Java 源码、XML 资源、图标、字符串资源；**不使用** "Seal" 作为产品名/包名/窗口标题/标识 | §9 禁止事项 2/3 / §3.6 —— 永久不做 |
| 11 | **不用字符串拼接执行 shell 命令、不 `shell:true`** | §9 禁止事项 5 / §6.7 —— 永久不做 |
| 12 | **不跳过完整性校验就把任务置 `Completed`** | §9 禁止事项 6 —— M1 无下载任务，自然不触发 |
| 13 | **不一次性生成大量未经验证的代码** | §0 / §9 禁止事项 7 |
| 14 | **不重新讨论选型、命名、平台范围；不做竞品/市场调研** | §9 禁止事项 1；本次为简单 PRD |
| 15 | **不推进 M2–M5**：M1 汇报后停下等甲方放行 | §0 / §8 / §10 Step 5 |

---

## 8. M1 汇报模板（照 §8 执行）

```
## M1 汇报
- 完成了什么：            （对照 P0-01..P0-18 逐条）
- 改了哪些文件：          （packages/*、apps/desktop/src/main/runtime-resolver.ts、scripts/*、
                           resources/runtime/win-x64/**、runtime-manifest.json、
                           electron-builder.yml、tests/fixtures/**、docs/、DECISIONS.md）
- 如何运行：              npm install / npm run check-runtime / npm test
- 如何验收：              ① npm run check-runtime  ② npm run test:contract
                         ③ npm run test:integration:offline -- --case probe-local
                         ④ npm run test:unit -- --run ArgvBuilder
                         ⑤ npm run test:unit -- --coverage
                         + acceptance-report.json 链接
- 矩阵项 → 断言 ID 对照表：本 PRD §3（74 行全表 + 17 条「M1 必须绿」清单，标 PASS）
- 剩余 / 阻塞 / 偏离：     U3 结论、覆盖率 70%→80% 收敛计划、pnpm 补齐方式，写入 DECISIONS.md
- 停下声明：              未获甲方放行，不进入 M2
```

---

*文档结束 · 本 PRD 仅覆盖 M1，不含业务代码。*
