# YTVDLT · M3「格式 / 字幕 / 路径全量」增量产品需求文档（PRD-M3）

> **文档类型**：增量 PRD（简单 PRD，不做竞品分析 / 市场调研）。只覆盖 **M3**。
> **唯一权威输入**：`C:/Users/leolee/WorkBuddy/2026-11-05-07-24-49/YTVDLT_HANDOFF.md`（v1.1，933 行）§4.2 / §4.3 / §4.4 / §8 M3 / §9 / §11。
> **基线**：`docs/PRD-M1.md` §3（74 行「矩阵项 → 断言 ID」映射，**断言 ID 稳定不改号**，D-04）、`docs/ARCHITECTURE-M2.md` §4（冻结 download argv 顺序、C1–C12、状态机）、`docs/PROJECT-HANDOFF.md` §3 / §5 / §7 / §11、`docs/DECISIONS.md`（D-01…D-29）、`docs/M2-REPORT.md`。
> **冲突裁决**：文档与实际代码不符时，**以实际代码为准**，集中登记于 §9 并给出依据路径；不重新讨论选型、命名、平台、技术栈（§9 禁止事项 1）。
> **本次边界**：只产出本文档；不修改任何产品代码、测试、验收脚本，不修改 `docs/PROJECT-HANDOFF.md`（该文件有一处用户未提交修改，原样保留）。

---

## 0. 项目信息

| 项 | 值 |
|---|---|
| Language | 简体中文（与需求语言一致） |
| Programming Language | Electron 45.2.2 + React + TypeScript + Vite；`packages/{shared,core,engine-ytdlp}` 为纯 TS（零 `electron` / 零 `fs` 副作用）；pnpm workspace + turbo。沿用 §2 拍板项，**非通用默认栈** |
| Project Name | `ytvdlt`（snake_case） |
| 项目根 | `C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt` |
| 里程碑 | **M3 格式 / 字幕 / 路径全量**（硬边界）；M1、M2 已完成并通过独立复验；M4 / M5 不纳入本次 |
| 交付物 | 本文档（需求基线 + 断言映射）；代码、测试、验收报告由架构 / 工程 / QA 落地 |
| M3 判定批次 | M3-B0…B5（`PROJECT-HANDOFF.md` §7.4），B0 为 R2-1 验收门修复前置 |
| 本轮网络约束 | **离线推进**（`PROJECT-HANDOFF.md` §6.4：要联网前必须先告知用户）；不联网安装任何 UI / 测试依赖；**B1–B3 纯 TS 参数分支不受此约束，仍为 P0**；B4 载体见 §5.5 |

**原始需求复述**：在 M1（骨架与引擎契约）、M2（单任务下载闭环 + C1–C12）已冻结的地基上，把 HANDOFF §4.2（格式与清晰度 13 项）、§4.3（字幕 8 项）、§4.4（路径相关项）的**全量 yt-dlp 参数分支**做完；首次引入 UI，交付格式 / 字幕 / 播放列表三个弹窗（**本轮离线前提下允许零依赖静态 HTML/CSS 载体 + 已缓存 chromium headless shell 截图回归，属载体偏离、非功能删减，见 §5.5 / §10 Q-M3-15…18**）；实现 `PathResolver` 的 Windows 文件名边界（非法字符 / 保留名 / 260+ 长路径 / UNC）；为 M3 归属的 36 条矩阵项各绑定可执行断言并新增骨架断言；参数冲突必须有明确的裁决优先级；同时守住零绕过能力、零 shell 拼接的合规红线。M3 明确不做并发调度、托盘通知、自定义命令模板、打包、L3 在线烟测与 `probePlaylist()` 真实实现。

---

## 1. 产品目标与用户故事

### 1.1 产品目标（3 个正交目标）

| # | 目标 | 可度量结果 |
|---|---|---|
| **G1** | **参数全覆盖且零冲突**：把 §4.2 / §4.3 / §4.4 全量参数分支接入 `ArgvBuilder`，并为所有冲突给出确定性裁决 | `ArgvBuilder` 组合单测 ≥60 例全绿（清晰度 8 档 × 编码 2 × 音频 ≥5 档 × 字幕 5 格式 × 路径 4 组合）；M2 冻结的 download argv 顺序逐元素不回归；5 组互斥冲突各有正 / 反例单测 |
| **G2** | **UI 可用且数据可信**：三个弹窗由 probe 结果 DTO 驱动，控件 / 状态 / 回写字段可验证 | 三弹窗 Playwright 截图回归通过；禁用 / 空态 / 错误态齐全且确认按钮门禁生效；确认后回写的 `DownloadRequest` 五域字段有断言可核验 |
| **G3** | **Windows 文件系统安全 + 合规红线**：`PathResolver` 净化边界可证、36 条矩阵项各有断言、零绕过能力 | 非法字符 / 保留名 / 260+ 长路径 / UNC 单测通过；36 条矩阵断言 + 12 条 `A-M3-*` 骨架断言全部 PASS；argv 中不含任何禁用参数、无 `shell:true`、无字符串拼接命令 |

### 1.2 用户故事（覆盖 §7.1 五块）

| # | 用户故事 | 对应 §7.1 块 | M3 中的体现 |
|---|---|---|---|
| **US-1** | **作为**想精确控制画质与音质的用户，**我希望**在格式页选清晰度档位（2160/1440/1080/720/480/360 + 最佳 + 最低）、编码偏好（AV1 / VP9.2 / H.264）、自定义排序、手动 `-f id+id`、音频质量与转码，**以便**生成的命令严格符合我的选择且不出现互斥参数 | ① 格式与清晰度 13 项 | §4.2 全量分支 + `FormatSelector` 参数决策 + §4 互斥裁决 |
| **US-2** | **作为**需要多语言字幕的用户，**我希望**按语言多选字幕、开关自动字幕 / 自动翻译、选择 ass/srt/vtt/lrc 转换、嵌入视频或保留独立文件，**以便**产物既有内嵌字幕轨又有 `.srt` 文件 | ② 字幕 8 项 | §4.3 全量分支 + `SubtitlePlanner` + 字幕选择弹窗 + `embed → mergeToMkv` 容器决策 |
| **US-3** | **作为**按站点 / 播放列表归档下载的用户，**我希望**分别设置视频 / 音频 / 命令目录、开启私有目录、按 extractor / 播放列表建子目录、自定义输出模板，**以便**文件自动落到我期望的目录且重启后设置保留 | ③ 路径相关项 | §4.4 相关项 + `PathResolver.buildOutputDir()` 纯函数 4 组合 + 路径预览 |
| **US-4** | **作为**从解析结果里挑选内容的用户，**我希望**格式 / 字幕 / 播放列表三个弹窗直接列出 probe 得到的格式、字幕语言、播放列表条目，支持多选与搜索并显示合计体积 / 已选计数，**以便**不手填 yt-dlp 参数也能完成配置 | ④ 三个 UI 弹窗 | §5 三个弹窗规格；数据只来自 `MediaInfo` / `PlaylistInfo` DTO；确认回写 `DownloadRequest` |
| **US-5** | **作为**标题含 `:` / emoji / 控制字符或超长路径的 Windows 用户，**我希望**文件名被净化、保留名被改写、超长路径被截断或加 `\\?\` 前缀，**以便**下载正常落盘且不抛异常、不产生不可访问的文件 | ⑤ PathResolver Windows 边界 | `PathResolver` 非法字符 / 保留名（大小写不敏感）/ 260+ 长路径 / UNC 单测，`%(title).200B` 截断 |

---

## 2. 需求池（P0 / P1 / P2）

> **P0 严格等于 `PROJECT-HANDOFF.md` §7.1 五块 + §7.2 四条验收 + §3 硬约束 + §2.2.1 R2-1 前置**，共 **18 条**。每条给出可验证判据。
> **离线口径**：P0-07…09 / P0-14 的判据按 §5.5 的零依赖静态载体解读，**18 条 P0 不减**；B1–B3 纯 TS 参数分支（FormatSelector / SubtitlePlanner / PathResolver / ArgvBuilder）不受离线约束，仍是 P0 与 M3 主体交付。
> **P1** 为 M3 内可后置、不阻塞四条验收的增强项；**P2** 明确不纳入 M3，标注归属里程碑。

### 2.1 P0 — M3 必须（18 条）

| ID | P0 需求 | 可验证判据 |
|---|---|---|
| **P0-01** | **B0 前置**：收紧 `scripts/lib/vitest-run.mjs` 的 `runVitestGuarded()`（R2-1） | ① spawn 前删除 / 隔离旧 `vitest-results.json` 与 `coverage-summary.json`，或加 run-id / mtime 新鲜度校验；② guard 判定补上覆盖率四维 ≥70 复算；③ `guardMitigated` 记录 `originalStatus`；④ **反例复验**：改坏任一断言 + 手造陈旧成功结果 → 仍必须 `exit 1 / FAIL`。未通过则 M3 的「全绿」不可信，不得进入 B1（`PROJECT-HANDOFF.md` §2.2.1） |
| **P0-02** | 格式与清晰度 §4.2 全 13 项参数分支 | 清晰度 8 档（best/2160p/1440p/1080p/720p/480p/360p/lowest）分别生成 `-S res:N` 或「无 res 约束」；编码 2 类（质量 `vcodec:av01` / `vp9.2`、兼容 `vcodec:h264`）；自定义 `sortingFields` 覆盖预设；手动 `-f 137+251`；`-x`；音频质量 `abr~N`；`acodec:opus/aac`；`--audio-format mp3/m4a`；元数据 / 封面 / 缩略图 / 章节 / 容器；`--download-sections` / `--split-chapters`；`--replace-in-metadata` / 输出模板。逐项有 L0 或 L2 断言（§3 表） |
| **P0-03** | 字幕 §4.3 全 8 项参数分支 | `--write-subs` 开关；`--sub-langs` 表达式与非法式校验；`--write-auto-subs` 与 `--extractor-args youtube:skip=translated_subs` 的取舍；`--convert-subs` 5 分支；`--embed-subs` → 强制 mkv；`--write-subs` 保留独立文件；按语言多选强制 `enabled=true`；仅音频模式禁用嵌入。逐项有断言（§3 表） |
| **P0-04** | 路径 §4.4 相关项 | 三目录分别落盘且重启保留；私有目录 `%LOCALAPPDATA%\YTVDLT\private` 且不写历史；`buildOutputDir()` 4 组合纯函数；输出模板渲染 + `--restrict-filenames`；`-P temp:` 自建临时目录；`--download-archive` 去重 `ALREADY_DOWNLOADED`（M2 已绿，M3 回归） |
| **P0-05** | **参数互斥裁决矩阵**（§4） | 5 组冲突各有正向 + 反向单测，冲突时输出**唯一确定**的 argv；全局优先级链可枚举、可断言；禁止「两个互斥参数同时出现」的 argv 通过验收 |
| **P0-06** | `PathResolver` Windows 边界 | 非法字符 `< > : " / \ \| ? *` + 控制字符；保留名 `CON/PRN/AUX/NUL/COM1-9/LPT1-9` 大小写不敏感且带后缀变体；结尾点 / 空格；`%(title).200B` 截断；259 / 260 / 261 字符边界；UNC 与 `\\?\` / `\\?\UNC\` 前缀。全部单测通过且不抛异常 |
| **P0-07** | 格式选择弹窗（三组分栏：仅视频 / 仅音频 / 音视频合并） | 按 §5.1 规格实现；默认勾选建议格式；搜索与多选；合计体积 = 选中项之和；确认回写 `format.formatId` / `audioMultistreams` |
| **P0-08** | 字幕选择弹窗（按语言多选） | 按 §5.2 规格实现；建议 / 其它 / 自动字幕三组；搜索与已选计数；确认回写 `subtitle.*` 六字段 |
| **P0-09** | 播放列表选择弹窗 | 按 §5.3 规格实现；由 `PlaylistInfo` DTO 渲染条目 / 数量 / 标题；确认只回写选中 id 列表，**不创建任务、不入队**（批量入队留 M4） |
| **P0-10** | 三弹窗禁用 / 空态 / 错误态与确认回写门禁 | probe 失败 → 错误态 + 重试；空数据 → 空态 + 确认按钮禁用；仅音频模式 → 字幕嵌入置灰；Command 模式 → 格式项禁用并说明；非法输入 → 行内错误且确认禁用 |
| **P0-11** | `ArgvBuilder` 组合单测 **≥60 例** | 覆盖清晰度 8 档 × 编码 2 × 音频 ≥5 档 × 字幕 5 格式 × 路径 4 组合；用例数 ≥60 且 0 FAIL；`EXPECTED_DOWNLOAD_ARGV` 为字面量数组；`argv.at(-1)===url`、`--` 恰好 1 个、`enginePath` 不在 argv 内 |
| **P0-12** | **36 条矩阵项各有断言** + 新增 `A-M3-01…12` | 断言 ID 沿用 `PRD-M1.md` §3，**不改号、不重排**；每条含「矩阵项 → 断言 ID → 验收判据 → 归属批次」；`scripts/acceptance.mjs` 新增 `runM3()` / `M3_ASSERTIONS` 并产出 `reports/acceptance-report-m3.json`（工程落地，本文档只定义） |
| **P0-13** | Windows 非法字符 / 保留名 / 260+ 长路径单测通过 | 同 P0-06，单测文件 `tests/unit/path-resolver.test.ts` 全绿；截图 / 报告写入 `acceptance-report-m3.json` |
| **P0-14** | 三个弹窗 Playwright 截图回归 | `npm run test:e2e` 全绿；固定窗口尺寸与字体渲染（§5.4）；三弹窗各至少 1 张基线截图 + 空态 / 禁用态截图 |
| **P0-15** | M2 遗留项收口（D-18 / D-28 / D-25） | ① video+audio 分离两段 0→100% 按 stage 分段处理，进度不回退；② 双流合并用例压测 `taskkill /T /F` 后 ffmpeg 无残留；③ `TaskQueue` 回填 `historyEntry` 激活 C11（不再恒 SKIP）；④ `IShellPort` 接 Electron `shell`，真实「默认播放器启动 / 资源管理器选中」L2 复验 |
| **P0-16** | 合规红线与 argv 安全（§7） | argv 组合中**不含** `--cookies-from-browser` / `--geo-bypass*` / `--no-check-certificates` / `--prefer-insecure` / `--exec` / PO Token 注入；不生成或注入 PO Token；不自动抓取浏览器 cookies；不降 TLS 校验；一律 `spawn(绝对路径, argv[], {shell:false, windowsHide:true})`，用户可控 token 置于 `--` 之后且 URL 为最后元素 |
| **P0-17** | 分层铁律不回归 | `node scripts/check-layering.mjs` → 0 违规；本轮离线静态 HTML/CSS 载体**不得引入** `react` / `react-dom` / `@mui/material` / `@playwright/test`、不接触子进程 / `node:fs` / `electron`；正式 React renderer 接入时仍须只经 IPC 发命令、不接触子进程 / `node:fs`；`core` / `engine-ytdlp` import 图不含 `electron`；M1 / M2 的 `acceptance --milestone M1|M2` 仍 exit 0 且两份报告并存 |
| **P0-18** | acceptance(M3) + 报告 + 停下 | `node scripts/acceptance.mjs --milestone M3` 产出 36 + 12 条断言与 gate，逐条含 `id / layer / status / expected / actual / durationMs / evidence`；`durationMs` 全为实测非零；按 HANDOFF §8 模板汇报后**停下等甲方放行**，未放行不进 M4；偏离（含 §5.5 的 B4 离线载体偏离）写入 `DECISIONS.md`（续 D-30 / D-31 起）并在汇报显式列出 |

### 2.2 P1 — M3 内可后置（不阻塞四条验收）

| ID | 需求 | 默认处理 |
|---|---|---|
| P1-01 | 参数互斥冲突的 **UI 实时提示**（如选 MP3 时音质档位置灰并说明原因） | M3 只要求 argv 裁决正确 + 弹窗禁用态；文案提示可后置到 M5 打磨，须在 `DECISIONS.md` 留痕 |
| P1-02 | 片段裁剪的**时间轴滑块** | M3 只要求 `--download-sections "*start-end"` 参数正确与产物约 30s；滑块 UI 可后置 |
| P1-03 | 合计体积在 `filesize` 与 `filesize_approx` 均缺失时的估算显示 | 默认显「—」，不做估算（避免虚构数据） |
| P1-04 | 弹窗键盘可达性 / 焦点管理 / a11y | M5 打磨阶段统一处理 |
| P1-05 | 三弹窗 i18n（zh-CN / en）文案 | M5；M3 全中文，与 PRD 语言一致 |
| P1-06 | `--ppa` 封面裁剪（显式 argv，不写临时 config） | 若当前随包 yt-dlp 版本对 `--ppa` 支持不稳定，允许降级为「不裁剪」并在 `DECISIONS.md` 记录；A-4.2-10 的封面裁剪判据相应调整（其余元数据嵌入判据不变） |

### 2.3 P2 — 明确不纳入 M3（§7.6 / §8）

| ID | 不做项 | 归属 |
|---|---|---|
| P2-01 | 并发调度（可配默认 3）、自动补位 | **M4** |
| P2-02 | 托盘常驻 / 系统通知 / 关窗最小化到托盘 | **M4** |
| P2-03 | 自定义命令模板 CRUD + 参数白名单、任务日志页 | **M4** |
| P2-04 | 播放列表**批量入队**（`--playlist-items` 每条独立任务） | **M4**（M3 只做解析 / 选择弹窗） |
| P2-05 | 七态完整状态机 + 快照持久化恢复的并发部分 | **M4**（M3 仅回填 `historyEntry` 激活 C11） |
| P2-06 | NSIS 安装版 / 便携版 EXE 打包、代码签名、C13–C16 | **M5** |
| P2-07 | L3 在线烟测（真实站点下载） | **M5**；网络不可达记 `SKIPPED` 不判 FAIL |
| P2-08 | 主题三态、全局快捷键、i18n、双通道自动更新 | **M5** |
| P2-09 | `probePlaylist()` **真实实现**（真实 spawn 播放列表解析） | **不做 / 留 M4**；M3 仅 L1 录制 fixture 解析 + 选择弹窗（详见 §10 Q-M3-04） |
| P2-10 | 真暂停、任务优先级、arm64 包 | v1.1 延后 |
| P2-11 | **本轮联网安装 UI / 测试依赖、搭建正式 React + MUI + `@playwright/test` + Electron renderer 基建** | 离线约束（`PROJECT-HANDOFF.md` §6.4）；属**临时载体偏离、非功能删减**，三弹窗规格与验收④仍为 P0；后续补齐清单见 §5.5，联网前必须先告知用户 |

---

## 3. M3 归属 36 条「矩阵项 → 断言 ID → 验收判据 → 归属批次」映射表

### 3.0 编号规则与口径裁决

- **ID 格式与稳定性**：`A-4.<节>-<两位序号>`，与 `docs/PRD-M1.md` §3 的 74 行映射一一对应，**稳定不可改号**（D-04 / PRD-M1 §3.0）。M3 只追加 `A-M3-xx`，不改任何既有 ID。
- **「36 条」口径**：以 `PRD-M1.md` §3.7 的统计为准 —— M1=7、M2=12、**M3=36**、M4=10、M5=9，合计 74。
- ⚠️ **口径冲突（详见 §9-①）**：`PROJECT-HANDOFF.md` §7.3 把 §4.2 写成「13 条全归 M3」并把 `A-4.4-30` 列入 M3；但 `PRD-M1.md` §3.2 / §3.4 / §3.7 与 `scripts/acceptance.mjs` 实际登记为：`A-4.2-06` 归 **M2**（`download-local` C6）、`A-4.4-30` 归 **M1**（Logger 脱敏）。二者相减恰为 36：`(13+8+8+3+4+2) − 2 = 36`。**本 PRD 以 PRD-M1 + acceptance.mjs 为准**，这两条列为「M3 回归复验项」（§3.7），不重编号、不计入 36。
- **层**：`L0` 零网络单测 / `L1` 引擎契约（录制 fixture 回放）/ `L2` 离线端到端（127.0.0.1 + 真实 yt-dlp，含 Playwright UI 回归）。
- **归属批次**：指该断言**首次判绿**的 M3-Bx 批次（§7.4：B0 门控修复、B1 纯函数、B2 PathResolver、B3 ArgvBuilder 全量、B4 三弹窗 UI、B5 全量回归）。
- **新增骨架断言**：`A-M3-01…A-M3-12`（§3.9），与 36 条并列构成 M3 判定集合：**48 条**。

### 3.1 §4.1 输入 / 解析 / 播放列表（3 条）

| 矩阵项 | 断言 ID | 验收判据（可判定条件） | 层 | 归属批次 |
|---|---|---|---|---|
| 粘贴 / 输入链接并解析 | `A-4.1-01` | `UrlExtractor` 单测：含 3 条链接文本 → 输出 3 条且 `toSet()` 去重；纯文本 → 返回空集且不抛异常；UI 行内错误不崩溃 | L0 | B3 |
| 播放列表解析 | `A-4.1-05` | 录制 `--flat-playlist --dump-single-json` fixture → `PlaylistInfo`，按 `_type` 分流，条目数与标题逐条一致；**不 spawn 真实进程、不触网** | L1 | B4 |
| 下载类型 4 种 | `A-4.1-07` | 切 Audio → 字幕嵌入项置灰；切 Command → GUI 格式项禁用并说明；四态互斥校验通过（Playwright 回归） | L2 | B4 |

### 3.2 §4.2 视频清晰度与格式（12 条）

| 矩阵项 | 断言 ID | 验收判据（可判定条件） | 层 | 归属批次 |
|---|---|---|---|---|
| 清晰度档位 | `A-4.2-01` | `ArgvBuilder` 单测：8 档分别断言 —— `2160p/1440p/1080p/720p/480p/360p` → `-S res:N`；`best` / `lowest` → 无 `res:` 约束（用 `-S` 排序而非 `-f` 硬指定） | L0 | B1 / B3 |
| 编码偏好 / AV1 | `A-4.2-02` | 质量 + AV1 → `-S` 含 `vcodec:av01`；关闭 AV1 → `vp9.2`；兼容 → `vcodec:h264`；桌面不做 Android 硬解检测 | L0 | B1 |
| 自定义格式排序 | `A-4.2-03` | 填 `res:720,ext:mp4` → `-S` 含该值；留空 → 回退预设排序；`sortingFields` 优先于 `quality` 预设（M2 代码已实现 if/else） | L0 | B1 |
| 手动格式选择弹窗 | `A-4.2-04` | 选 `137` + `251` → `-f 137+251`；合计体积 = 两者体积之和；弹窗三组分栏截图纳入回归 | L0 | B4 |
| 多音频流合并 | `A-4.2-05` | 单测覆盖 1 条 / 2 条 audio-only 分支：仅当选中 audio-only ≥2 时 `--audio-multistreams` 出现 | L0 | B1 |
| 音频质量档位 | `A-4.2-07` | `-S abr~192 / 128 / 64 / 32` + 最佳 / 最低分支；**⚠️ 实际 DTO 有 6 个枚举值**（§9-②），M3 全 6 档覆盖（≥5 满足验收①） | L0 | B1 / B3 |
| 音频编码偏好 | `A-4.2-08` | 选 OPUS → `-S` 含 `acodec:opus`；选 AAC → `acodec:aac` | L0 | B1 |
| 音频转码 | `A-4.2-09` | 开转 MP3 → 含 `--audio-format mp3` 且**不含** `-S abr~`（互斥裁决，§4.2 规则 R1）；mp3 编码器可用性 U4 在 M2 已实测有 | L0 | B1 / B3 |
| 元数据 / 封面嵌入 | `A-4.2-10` | 音频产物含标题 / 作者 / 封面标签；裁剪时封面为正方形（显式 `--ppa`，**不写临时 config**） | L2 | B3 |
| 缩略图 / 章节 / 容器 | `A-4.2-11` | 嵌入字幕 → 产物为 mkv 且含字幕轨；开缩略图 → 同目录 png；`--embed-chapters` / `--write-thumbnail` / `--convert-thumbnails` 出现（C9） | L2 | B3 |
| 片段裁剪 / 章节拆分 | `A-4.2-12` | 选 00:30-01:00 → `--download-sections "*00:30-01:00"` 且产物时长约 30s；有章节 → `--split-chapters` + `chapter:` 模板、每章一文件且历史逐条（C5 / C8） | L2 | B3 |
| 自定义标题 / 输出模板 | `A-4.2-13` | 标题含 `:` / emoji → `PathResolver` 净化后正常落盘且不抛异常；`--replace-in-metadata title .+ <newTitle>` 与 3 种内置模板 + 自定义模板生效 | L0 | B2 |

### 3.3 §4.3 字幕（8 条）

| 矩阵项 | 断言 ID | 验收判据（可判定条件） | 层 | 归属批次 |
|---|---|---|---|---|
| 字幕下载开关 | `A-4.3-01` | 开 → 含 `--write-subs`；关 → **不含任何字幕参数** | L0 | B1 |
| 字幕语言 | `A-4.3-02` | 填 `zh.*,en.*` → `--sub-langs` 值与产物语言一致；默认 `en.*,.*-orig`；非法表达式前端行内提示且确认禁用 | L0 | B1 / B4 |
| 自动字幕 | `A-4.3-03` | 开自动字幕且关翻译 → `--write-auto-subs` 与 `--extractor-args youtube:skip=translated_subs` **同时出现** | L0 | B1 |
| 自动翻译字幕 | `A-4.3-04` | 开启 → 命令**不含** `skip=translated_subs`；实验性确认提示保留 | L0 | B1 / B4 |
| 字幕格式转换 | `A-4.3-05` | `ass / srt / vtt / lrc / none` 五分支：命令 `--convert-subs` 值与文件后缀一致（C9），单测 5 分支全绿 | L0 | B1 / B3 |
| 字幕嵌入视频 | `A-4.3-06` | 视频嵌入 → 自动 `mergeToMkv=true` → argv 含 `--embed-subs --remux-video mkv --merge-output-format mkv`，产物 mkv 且容器内 subtitle 流存在；**Audio 模式该项不可点**（§4.2 规则 R2 / R3） | L2 | B3 / B4 |
| 保留独立字幕文件 | `A-4.3-07` | 嵌入 + `keepSubtitleFile` 同时开 → 既有 `.srt` 又有内嵌轨（额外 `--write-subs`）；仅 `!extractAudio && embed` 可用 | L2 | B3 / B4 |
| 格式页按语言多选 | `A-4.3-08` | 选 `zh-Hans` + `en` + 自动字幕 → `--sub-langs` 含两者且 `--write-auto-subs` 出现，已选计数正确，**强制 `enabled=true`** | L2 | B4 |

### 3.4 §4.4 路径 / 文件 / 网络 / 设置（7 条）

| 矩阵项 | 断言 ID | 验收判据（可判定条件） | 层 | 归属批次 |
|---|---|---|---|---|
| 视频 / 音频 / 命令三目录 | `A-4.4-01` | 分设 `D:\Videos` / `D:\Music` → `-P` 各落对应目录；重启后路径保留；默认 `%USERPROFILE%\Downloads\YTVDLT` 及 `Audio` 子目录 | L2 | B2 |
| 私有目录 | `A-4.4-02` | 开启 → 落 `%LOCALAPPDATA%\YTVDLT\private` 且历史不新增；隐藏属性、不进历史 | L2 | B2 |
| 按站点 / 播放列表建子目录 | `A-4.4-03` | `PathResolver.buildOutputDir()` 纯函数：两开关全开 → `<dir>/<extractor>/<playlist>/`；单测覆盖 **4 组合**（00 / 10 / 01 / 11） | L0 | B2 |
| 输出模板与文件名净化 | `A-4.4-04` | 超长含非法字符标题 → 截断且不抛异常；保留名 / 260+ 长路径单测通过；`--restrict-filenames` 出现 | L0 | B2 |
| 网络选项 | `A-4.4-25` | 设 500K → `-r 500K`；设代理 → `--proxy`；`--downloader aria2c` 与 `--concurrent-fragments` 互斥（§4.3 补充约束）；`-4` 仅在 `ipv4Only` 时出现 | L0 | B1 / B3 |
| Cookies / UA | `A-4.4-26` | 导入合法 `cookies.txt` → `--cookies <path>`；空文件 → 明确报错；**断言命令中不含 `--cookies-from-browser`** | L0 | B1 / B3 |
| SponsorBlock | `A-4.4-27` | 选分类 → `--sponsorblock-remove <categories>` 含对应值；模拟 API 失败 → 下载完成且仅 WARNING（降级，不判 FAIL） | L2 | B3 |

### 3.5 §4.5 错误处理（4 条）与 §4.6 平台等价（2 条）

| 矩阵项 | 断言 ID | 验收判据（可判定条件） | 层 | 归属批次 |
|---|---|---|---|---|
| 空链接 | `A-4.5-01` | 空输入 → 行内校验提示且「开始下载」按钮禁用；`ErrorMapper` 已注册 `INVALID_URL` | L0 | B3 / B4 |
| 链接无法匹配 | `A-4.5-02` | 粘贴非 URL → 明确提示、**不创建任务**；`UrlExtractor` 返回空集 | L0 | B3 |
| 格式不可用 | `A-4.5-04` | 手填不存在 id → `FORMAT_UNAVAILABLE`，保留重试；弹窗预校验 format id 与 `MediaInfo.formats[].format_id` | L0 | B4 |
| SponsorBlock API 失败 | `A-4.5-07` | 模拟失败 → 下载完成且仅 WARNING，不判 FAIL（与 `A-4.4-27` 同判据） | L2 | B3 |
| SAF 目录树 / SD 卡 URI | `A-4.6-01` | 选 UNC 路径 → 可写入且重启保留（持久化绝对路径）；原生目录对话框 | L2 | B2 |
| WebView 登录生成 Cookie | `A-4.6-04` | **断言不存在内置 WebView 登录路径**；仅接受用户手动导入自有 `cookies.txt`；空文件 → 明确报错 | L0 | B1 / B3 |

### 3.6 映射表统计（自检）

| 维度 | 分布 | 合计 |
|---|---|---|
| 按节 | §4.1=3、§4.2=12、§4.3=8、§4.4=7、§4.5=4、§4.6=2 | **36 条** |
| 按层 | L0=23、L1=1、L2=12 | **36 条** |
| 按批次 | B1 / B2 / B3 / B4 均有覆盖（每条首次判绿批次见 §3.1–§3.5 表），B5 全量回归 | **36 条** |
| 新增骨架断言 | `A-M3-01…A-M3-12` | **12 条** |
| **M3 判定集合** | 36 矩阵项 + 12 骨架 + B0 门控前置（P0-01） | **48 条断言 + 1 门控前置** |
| 回归复验（不计入 36） | `A-4.2-06`（M2）、`A-4.4-30`（M1）、`A-4.6-02`（M2，D-25 遗留） | **3 条** |

### 3.7 M3 回归复验项（归属更早里程碑，ID 不改号）

| 断言 ID | 原归属 | M3 必须复验的原因 | 复验判据 |
|---|---|---|---|
| `A-4.2-06` | **M2** / L2 / `download-local` C6 | M3 新增 `-x` 与字幕嵌入互斥、`--audio-format` 组合、`-P audioDir` 分支，需确认「仅音频产物无 video 流」不回归 | 仅音频模式 ffmpeg 产物 `streams[].codec_type` 不含 `video`（C6），且字幕嵌入参数不出现 |
| `A-4.4-30` | **M1** / L0 / Logger 脱敏 | M3 新增 `--cookies` / `--add-header` / `--proxy` / `--ppa` / `--replace-in-metadata` 等含用户数据的参数，脱敏面扩大 | argv 中 Cookie / 凭据 / token / UA 全部掩码；JSONL 结构化行；`report` 全字段脱敏 |
| `A-4.6-02` | **M2** / L0 / `IShellPort` argv 契约 | **D-25** 明确「真实系统默认播放器启动留 M3 接 Electron `shell`」；M2 只验了 `explorer.exe` argv 正确性 | 接 Electron `shell` 后 L2 复验：`openPath` 启动默认播放器、`showItemInFolder` 在资源管理器选中产物 |

### 3.8 新增骨架断言 `A-M3-01…A-M3-12`（弹窗交互 / PathResolver 边界 / 模板渲染 / 遗留收口）

> 沿用 M2 的追加式命名（`A-M2-01…25`，D-21），**只追加不改号**。`scripts/acceptance.mjs` 目前仅有 M1 / M2 分支（§9-⑦），M3 分支由工程落地。

| 断言 ID | 绑定来源 | 验收判据 | 层 | 归属批次 |
|---|---|---|---|---|
| `A-M3-01` | 格式选择弹窗三组分栏 | Playwright + DOM 断言：仅视频 / 仅音频 / 音视频合并三组均渲染；默认勾选建议格式（无建议时取最高 `tbr`）；确认回写 `format.formatId` | L2 | B4 |
| `A-M3-02` | 格式弹窗多选音频流 / 合计体积 | 选中 `137` + `251` → `-f 137+251`、合计体积 = 两者之和；选中 audio-only ≥2 → `format.audioMultistreams=true`；体积缺失显「—」不虚构 | L0 + L2 | B4 |
| `A-M3-03` | 字幕选择弹窗按语言多选 | 建议 / 其它 / 自动字幕三组 + 搜索 + 已选计数；确认回写 `subtitle.languages` 且强制 `enabled=true`（A-4.3-08） | L2 | B4 |
| `A-M3-04` | 播放列表选择弹窗 | `PlaylistInfo` DTO 驱动条目 / 数量 / 标题渲染；多选计数与合计时长正确；确认**只回写选中 id 列表**，断言未调用 `enqueueBatch` / 未产生任务（入队留 M4） | L2 | B4 |
| `A-M3-05` | 三弹窗禁用 / 空态 / 错误态 | probe 失败 → 错误态 + 重试；`formats=[]` / 无字幕语言 / `entries=[]` → 空态且确认按钮禁用；仅音频模式字幕嵌入置灰；Command 模式格式项禁用；非法语言表达式 → 行内错误且确认禁用 | L2 | B4 |
| `A-M3-06` | 三弹窗 Playwright 截图回归 | `npm run test:e2e` 全绿；固定窗口尺寸与字体渲染（§5.4）；三弹窗各 ≥1 张基线截图 + 空态 / 禁用态截图；跨机器 diff 稳定 | L2 | B4 |
| `A-M3-07` | Windows 非法字符净化 | `< > : " / \ \| ? *` + 控制字符 `\u0000-\u001f` + 结尾点 / 空格 → 净化后文件名合法、可落盘、不抛异常；`--restrict-filenames` 生效 | L0 | B2 |
| `A-M3-08` | 保留名 + 260+ 长路径 / UNC | `CON/PRN/AUX/NUL/COM1-9/LPT1-9` 大小写不敏感（含 `CON.txt` / `con` 变体）→ 改写；259 / 260 / 261 边界；`%(title).200B` 截断；UNC 与 `\\?\` / `\\?\UNC\` 前缀；超长路径不抛异常 | L0 | B2 |
| `A-M3-09` | 输出模板渲染 + 路径预览 | 3 种内置模板 + 自定义模板渲染 `%(title)s / %(id)s / %(ext)s / %(playlist)s / %(extractor_key)s`；`subdirByExtractor × subdirByPlaylist` 4 组合路径预览；`--replace-in-metadata title .+ <newTitle>` 与净化顺序（先渲染 → 净化 → 拼路径 → 截断） | L0 | B2 |
| `A-M3-10` | 参数互斥裁决矩阵 | §4.2 的 R1–R5 五组冲突各有正向 + 反向单测；全局优先级链可枚举；断言不存在「两互斥参数同时出现」的 argv | L0 | B1 / B3 |
| `A-M3-11` | ArgvBuilder 组合单测 ≥60 例 | 用例数 ≥60、0 FAIL；8 档 × 编码 2 × 音频 6 档 × 字幕 5 格式 × 路径 4 组合覆盖；M2 冻结 argv 顺序逐元素不回归（`A-M2-25` 复验）；每个测试文件映射到 ≥1 条断言（P3-5） | L0 | B3 |
| `A-M3-12` | M2 遗留收口 | ① 多流进度按 stage 分段递增（D-18）；② 双流合并后 `taskkill /T /F` 无 ffmpeg 孤儿（D-28）；③ 队列回填 `historyEntry` → C11 由 SKIP 转 PASS；④ Electron `shell` 真实打开 / 定位（D-25） | L2 | B3 / B4 / B5 |

> **B4 断言的离线载体口径（§5.5）**：`A-M3-01…06` 与 `A-4.2-04` / `A-4.3-08` / `A-4.1-07` 在本轮以「零依赖静态 HTML/CSS 弹窗 + 已缓存 `chromium_headless_shell-1234` 截图」判绿；DOM 断言、禁用 / 空态 / 错误态门禁、确认回写、截图 diff 判据**一律不变**，仅实现载体与截图工具等价替代。正式 React + `@playwright/test` 版本为联网后补做项，届时复验 `A-M3-06`；**断言 ID 不改号**（D-04）。B1–B3 纯 TS 参数分支不受此约束，仍是 P0。

---

## 4. 参数互斥矩阵与裁决优先级

> **总原则**：`ArgvBuilder` 产出的 argv **不得同时出现互斥参数**；冲突必须由 `FormatSelector` / `SubtitlePlanner` / `PathResolver` 在构造 `DownloadRequest` 之前裁决完毕，`buildDownload()` 仍是纯函数（同入参 → 同数组）。冲突时**高优先级规则抑制低优先级规则**，并在 UI 给出禁用态或说明（P1-01 可后置文案）。

### 4.1 全局裁决优先级链（从高到低）

| 级 | 规则 | 抑制对象 | 依据 |
|---|---|---|---|
| **P0** | **合规白名单**（不参与裁决，直接拒绝） | 任何绕过类参数 / PO Token / 浏览器 cookies 自动抓取 / 降 TLS 校验 | PROJECT-HANDOFF §3 硬约束 4；本 PRD §7 |
| **P1** | **模式约束**：`extractAudio===true` | 禁用字幕嵌入与 mkv 容器决策；禁用视频清晰度 / 编码 `-S res:N` `vcodec:*`；强制 `-x` + 落 `audioDir` | §4.3 `:169-186`；A-4.3-06；A-4.1-07 |
| **P2** | **显式音频转码**：`audioFormat!==null` | 抑制全部 `-S abr~N` 音质排序（**规则 R1**）；`acodec:` 编码偏好保留 | §4.2 `:592-601`；A-4.2-09 |
| **P3** | **手动格式选择**：`formatId!==null` | 清晰度档位 `-S res:N` 让位（用 `-f id+id` 而非 `-S` 硬指定）；自定义 `sortingFields` 仍优先于 `quality` 预设 | §4.2 `:194,197`；A-4.2-01 / 03 / 04 |
| **P4** | **片段裁剪 / 章节拆分**：`downloadSections!==null` > `splitChapters` | 二者互斥时裁剪优先；`splitChapters===true` 抑制 remux / merge mkv 与字幕嵌入（**规则 R5**） | §4.2 `:769-793`；HANDOFF §11；本 PRD 默认假设 §10 Q-M3-03 |
| **P5** | **字幕嵌入容器**：`embed===true` | 强制 `mergeToMkv=true` → `--remux-video mkv` + `--merge-output-format mkv`（**规则 R2**）；`keepSubtitleFile` 决定额外 `--write-subs` | §4.3 `:354-355,461-467`；A-4.3-06 / 07 |
| **P6** | **多音频流**：选中 audio-only ≥2 | 仅此时 `--audio-multistreams`（**规则 R4**）；1 条时禁止手动置位 | §4.2 `:445-447`；A-4.2-05 |
| **P7** | **自动预设**（无显式选择时） | 按 `quality` / `videoCodecPref` / `audioQuality` / `audioCodecPref` 生成 `-S` | §4.2 `:509-549` |

### 4.2 五组必测互斥（每条含裁决结论 + 可验证判据）

| # | 冲突组合 | 裁决结论（唯一确定） | 可验证判据 | 绑定断言 |
|---|---|---|---|---|
| **R1** | `--audio-format mp3\|m4a` ⟷ `-S abr~N` | **音频转码优先**：`audioFormat!==null` → 生成 `--audio-format <v>`，**完全不生成** `-S abr~`；音质档位在 UI 置灰。反转：无转码时按 `audioQuality` 生成 `-S abr~N`，不出现 `--audio-format` | argv 含 `--audio-format mp3` 且 `argv` 中不存在以 `abr~` 开头的 `-S` 值；两条反向分支各有单测 | `A-4.2-09` / `A-4.2-07` / `A-M3-10` |
| **R2** | `--embed-subs` ⟶ 容器 | **强制 `mergeToMkv=true`**：`embed===true` → 必须同时出现 `--embed-subs`、`--remux-video mkv`、`--merge-output-format mkv`；产物 mkv 且含 subtitle 流。用户无手动容器覆盖入口（M3 不提供） | argv 三参数同现；`ffprobe` 容器为 matroska 且 `streams[].codec_type` 含 `subtitle` | `A-4.3-06` / `A-4.2-11` / `A-M3-10` |
| **R3** | 仅音频模式 ⟷ 字幕嵌入 | **模式优先**：`extractAudio===true` → `subtitle.embed` 强制 `false`、UI 置灰并说明；`--embed-subs` / remux / merge mkv **均不出现**。注意 `--write-subs` 在音频模式下**仍允许**（HANDOFF §4.3 `:212`） | 音频模式 argv 不含 `--embed-subs` / `--remux-video` / `--merge-output-format`；可含 `--write-subs` | `A-4.3-06` / `A-4.1-07` / `A-M3-10` |
| **R4** | `--audio-multistreams` ⟷ 选中音频流条数 | **条数 ≥2 才置位**：由格式弹窗选中的 audio-only 格式条数派生；1 条时即使手动置 `true` 也被 `FormatSelector` 纠正为 `false` | 1 条 → argv 不含 `--audio-multistreams`；2 条 → 含；DTO 布尔与选中条数一致 | `A-4.2-05` / `A-M3-02` / `A-M3-10` |
| **R5** | `--split-chapters` / `--download-sections` / `--remux-video` | **裁剪 > 拆分 > 嵌入 mkv**：① `downloadSections!==null` 与 `splitChapters===true` 同时给出 → 只生成 `--download-sections`，抑制 `--split-chapters` 并在日志记 WARNING；② `splitChapters===true` → 生成 `--split-chapters` + `chapter:` 输出模板前缀，抑制 `--remux-video` / `--merge-output-format` 与 `--embed-subs`（拆分模式字幕嵌入 UI 置灰）；③ 章节列表为空 / `null` 时 `--split-chapters` 不可用（按钮禁用）；④ 三者皆无 → 按 R2 决定是否 remux mkv | 4 种组合各有单测；冲突组合的 argv 中不存在被抑制参数；`chapter:` 前缀只在 split 时出现 | `A-4.2-12` / `A-4.3-06` / `A-M3-10`；默认假设见 §10 Q-M3-03 |

### 4.3 补充组合约束（同样需单测，不新增断言 ID）

| 组合 | 约束 | 判据 |
|---|---|---|
| `--downloader aria2c` ⟷ `--concurrent-fragments` | 互斥；`aria2cPath!==null` 时抑制分片参数，反之亦然（A-4.4-25） | 二者不同现 |
| `sortingFields` ⟷ `quality` 预设 | 自定义排序优先（M2 `buildDownload` 已用 if/else 实现，⚠️ 见 §9-③） | `-S` 值等于 `sortingFields`，不含 `res:N` |
| `formatId` ⟷ 清晰度 `-S res:N` | 手动 `-f id+id` 时不再按档位生成 `res:N`（§4.2「用 -S 排序而非 -f 硬指定」的反向场景） | 不同现 |
| `--convert-subs` ⟷ `embed` | 嵌入前先转换：`convertTo!=='none'` 与 `embed===true` 可同现，顺序固定 `--convert-subs <v>` 在 `--embed-subs` 之前 | argv 顺序符合冻结表扩展段 |
| `skipTranslated` ⟷ `autoCaptions` | 仅 `autoCaptions===true && skipTranslated===true` 才生成 `--extractor-args youtube:skip=translated_subs`；`autoCaptions===false` 时该参数不出现 | A-4.3-03 / 04 |
| `--ppa` ⟷ 临时 config | 封面裁剪只用显式 `--ppa` argv，**绝不写临时配置文件**（§4.2 `:203`） | 无 `--config` / 临时文件写入 |

---

## 5. 三个弹窗 UI 规格

### 5.0 通用约定

- **M3 起才有 UI**：`packages/ui/` 当前不存在（§9-⑥），M3 新建（**本轮离线前提下只放零依赖静态 HTML/CSS，见 §5.5**）；正式 Renderer 只订阅事件、经 IPC 发命令，**不接触子进程 / `node:fs`**（PROJECT-HANDOFF §5.2 分层铁律）。
- **数据来源**：一律为 probe 结果 DTO —— `MediaInfo` / `PlaylistInfo`（`packages/shared/src/media.ts`）。⚠️ **`MediaFormat.url` 与 `SubtitleTrack.url` 可能含签名 / 凭据，禁止渲染、写日志或放进错误报告**（`media.ts:15-16, 23`）。
- **确认语义**：弹窗确认只回写 `DownloadRequest` 五域字段（`packages/shared/src/request.ts`，M1 冻结、**不改签名**），不直接调用 `download()`；由配置页统一下发。
- **禁用 / 空态 / 错误态三态齐全**：确认按钮在无有效选择时禁用；probe 失败显示错误态 + 「重试解析」；数据为空显示空态引导。
- **UI 载体（离线默认假设）**：`react` / `react-dom` / `@mui/material` / `@playwright/test` 目前只是根 `package.json` 的 `ytvdltPlannedDependencies` 登记项、**未安装**（§9-⑬）；本轮**不联网装依赖**，默认用**纯零依赖静态 HTML/CSS 弹窗 + 原生 DOM 交互**。不改 §2 拍板技术栈，属实现载体偏离，按 §5.5 留痕并联网后补齐（§10 Q-M3-07 / Q-M3-15）。不重新讨论技术栈（HANDOFF §9 禁止事项 1）。

### 5.1 格式选择弹窗 `FormatSelectorDialog`

| 项 | 规格 |
|---|---|
| **触发入口** | 下载配置页「格式」按钮；URL 解析完成（`probe()` 返回 `MediaInfo`）后可用；手动格式选择入口 |
| **数据来源** | `MediaInfo.formats: MediaFormat[]`，字段 `format_id / ext / width / height / vcodec / acodec / filesize / filesize_approx / tbr / fps / format_note`；**不读取 / 不渲染 `url`** |
| **控件与状态** | 三组分栏卡片：① **仅视频**（`vcodec!=='none' && acodec==='none'`）；② **仅音频**（`vcodec==='none' && acodec!=='none'`）；③ **音视频合并 / 预合并**（`vcodec!=='none' && acodec!=='none'`）。每组按分辨率 / 编码 / 码率 / 体积列示；视频单选 + 音频多选；搜索框（按 id / 分辨率 / 编码 / 备注）；**合计体积** = 选中项 `filesize ?? filesize_approx` 之和（均缺失显「—」）；默认勾选 yt-dlp 建议格式（无建议标记时取最高 `tbr`）；显示所选清晰度 / 编码 / AV1 开关 / 音质与转码档位 |
| **禁用 / 空态 / 错误态** | probe 失败 → 错误态 + 重试；`formats=[]` → 空态「没有可用格式」+ 确认禁用；`extractAudio===true`（仅音频模式）→ 仅视频 / 合并组禁用；**Command 模式 → 整弹窗禁用并说明**（A-4.1-07）；手填不存在的 format id → `FORMAT_UNAVAILABLE` 且保留重试（A-4.5-04）；选 MP3 转码 → 音质档位按 R1 置灰；仅选中 1 条 audio-only → 不允许勾「多音频流」 |
| **确认后回写** | `format.formatId`（如 `137+251`）、`format.audioMultistreams`（选中 audio-only ≥2 → `true`）、`format.extractAudio`（仅选音频流时）；`quality` / `videoCodecPref` / `audioQuality` / `audioCodecPref` / `audioFormat` / `sortingFields` 按档位控件回写。**合计体积仅供展示，不写入 DTO** |

### 5.2 字幕选择弹窗 `SubtitleSelectorDialog`

| 项 | 规格 |
|---|---|
| **触发入口** | 下载配置页「字幕」按钮；probe 完成后可用；格式页按语言多选入口（A-4.3-08） |
| **数据来源** | `MediaInfo.subtitles: Record<string, SubtitleTrack[]>` 与 `automatic_captions: Record<string, SubtitleTrack[]>`；`SubtitleTrack{lang, ext, name, url?}`，**不读取 / 不渲染 `url`**；建议语言取自默认 `en.*,.*-orig`（HANDOFF §11 默认值表） |
| **控件与状态** | 按语言多选，分三组：**建议语言** / **其它语言** / **自动字幕**；搜索框；**已选计数**；「自动字幕」「自动翻译字幕（实验性，带确认提示）」「嵌入视频」「保留独立字幕文件」开关；「格式转换」五选一 `ass / srt / vtt / lrc / 不转换`；「语言表达式」编辑框 + 预设 chips（可重置）+ 合法性校验；`embed===true` 时显示「将强制合并为 MKV」提示 |
| **禁用 / 空态 / 错误态** | 无任何字幕语言 → 空态 + 允许手动输入表达式（表达式非空方可确认）；**`extractAudio===true` → 「嵌入视频」「保留独立字幕」置灰并说明「仅音频模式不可嵌入」**（R3）；`splitChapters===true` → 「嵌入视频」置灰（R5）；自动翻译字幕开启时保留实验性提示；非法语言表达式 → 行内错误且确认禁用；`enabled=false` 时其余字幕控件全部禁用 |
| **确认后回写** | `subtitle.languages`（逗号分隔，如 `zh-Hans,en`）、`enabled`（选中任一语言即 `true`，A-4.3-08 强制）、`autoCaptions`、`skipTranslated`、`convertTo`、`embed`、`keepSubtitleFile`。**`mergeToMkv` 为 `SubtitlePlanner` 内部派生决策，不写入冻结 DTO**（`PathsDomain` 无此字段，§9-④） |

### 5.3 播放列表选择弹窗 `PlaylistSelectorDialog`

| 项 | 规格 |
|---|---|
| **触发入口** | URL 解析结果 `_type==='playlist'` 时自动弹出；配置页「选择条目」按钮 |
| **数据来源** | `PlaylistInfo{id, title, _type:'playlist', extractor_key, webpage_url, entries: PlaylistEntry[]}`；`PlaylistEntry{id,title,url,duration,_type}`；来自 `--flat-playlist --dump-single-json` 录制 fixture 的 L1 解析（A-4.1-05）。**⚠️ M3 不实现 `probePlaylist()` 的真实子进程调用**（接口仍为 `UNKNOWN` 占位，§10 Q-M3-04） |
| **控件与状态** | 条目列表（序号 / 标题 / 时长 / 缩略图占位）；全选 / 反选；搜索；**已选计数与合计时长**；路径预览（按 `subdirByPlaylist` 显示 `<dir>/<playlist>/`，A-4.4-03）；可预设视频 / 音频格式（回写 `format.*`，不产生任务） |
| **禁用 / 空态 / 错误态** | 单视频（`_type!=='playlist'`）→ 不弹 / 显示「不是播放列表」；`entries=[]` → 空态 + 确认禁用；probe 失败 → 错误态 + 重试；**M3 确认后不创建任务、不入队**，按钮文案明确「保存选择」而非「开始下载」 |
| **确认后回写** | **仅回写选中条目 id 列表**至配置 / 预览状态，供 M4 生成 `Task(Playlist(index))` + `--playlist-items`；断言未调用 `enqueueBatch()` / 未新增 `TaskRecord`（A-M3-04） |

### 5.4 Playwright 截图回归约定（A-M3-06）

- 固定窗口尺寸（默认 1280×800）与字体渲染（禁用系统字体回退差异、固定 `deviceScaleFactor`），否则跨机器 diff 不稳定（§7.5 第 6 条）。
- 三弹窗各 ≥1 张基线截图 + 空态 / 禁用态截图；基线文件纳入新建的 `tests/e2e/`；**本轮用已缓存的 `chromium_headless_shell-1234` 直调截图 + 基线 diff**（不依赖 `@playwright/test` / `playwright.config.*`，见 §5.5），`npm run test:e2e` 由本地截图脚本承担。
- 截图用例映射到 `A-M3-01` / `A-M3-03` / `A-M3-04` / `A-M3-05` / `A-M3-06`，避免 P3-5「测试文件失败不落在任何断言模式里」的粒度缺口。

### 5.5 B4 离线默认实现假设与偏离标注（本轮硬前提）

> **前提（已核验，见 §9-⑬…⑯）**：`react` / `react-dom` / `@mui/material` / `@playwright/test` 只是根 `package.json` 的 `ytvdltPlannedDependencies` 登记项，**未安装**、不在 `pnpm-lock.yaml`；`node_modules/@playwright/test`、`node_modules/electron/dist` 均不存在；`packages/ui/`、`tests/e2e/`、`apps/desktop/src/renderer`、`playwright.config.{ts,js,mjs}` **全部不存在**。本机仅有 Playwright 浏览器缓存 `C:/Users/leolee/AppData/Local/ms-playwright/` 下的 `chromium-1234` / `chromium_headless_shell-1234` / `ffmpeg-1011` / `winldd-1007`。按 `PROJECT-HANDOFF.md` §6.4「要联网前必须先告知用户」，**本轮离线推进、不联网装依赖**。

**默认实现假设（直接生效，不向用户提问）**

| 项 | 本轮默认 | 说明 |
|---|---|---|
| 弹窗载体 | **纯零依赖静态 HTML/CSS + 原生 DOM 交互**（三个独立弹窗页面），不引入 `react` / `react-dom` / `@mui/material` | 静态资源落 `packages/ui/` 或 `tests/e2e/`（架构师定）；不新增 npm 依赖、`pnpm-lock.yaml` 不变、`package.json` 的登记项原样保留 |
| 数据注入 | 由 **L1 录制的 `MediaInfo` / `PlaylistInfo` fixture JSON** 注入（与 `packages/shared/src/media.ts` 同源），禁止虚构格式 / 字幕 / 条目数据 | 仍受 §5.0 约束：`MediaFormat.url` / `SubtitleTrack.url` 含凭据，禁止渲染 / 日志 / 报告 |
| 交互与回写 | 原生 DOM 事件实现多选 / 搜索 / 已选计数 / 三态门禁；确认后产出与 `DownloadRequest` 五域**同构**的 JSON 回写结果，供纯 TS 断言核验 | 不改冻结 DTO 签名；`A-M3-01…05` 的 DOM 断言判据不变 |
| 截图回归 | 直调已缓存的 `chromium_headless_shell-1234` 可执行文件，固定窗口 1280×800 + 固定字体 / `deviceScaleFactor`，截图与 `tests/e2e/` 基线做 diff | **不依赖** `@playwright/test` 与 `playwright.config.*`；本轮 `npm run test:e2e` 由本地截图脚本承担，脚本与基线仍须可复现、可被 QA 反例复验 |
| 分层铁律 | 静态载体不接触子进程 / `node:fs` / `electron`；`core` / `engine-ytdlp` 仍零 electron、零 fs | P0-17 判绿口径相应兼容（§2.1） |

**相对任务书的偏离如何标注**

- 任务书（HANDOFF §8 M3 验收④ / §6.8 / §2）要求「React + 组件库 + Playwright 截图回归」；本轮以「零依赖静态 HTML/CSS + 缓存 chromium headless shell 截图」**等价替代实现载体与截图工具**。
- 定性：**实现载体 / 验收工具的临时等价替代，不是功能范围删减**。§5.1–§5.3 的触发入口、数据来源（probe 结果 DTO）、控件与状态、禁用 / 空态 / 错误态、确认后回写字段**全部不变且仍为 P0**；`A-M3-01…06`、验收④及四条验收的判定条件不变（只换载体）。**B1–B3 纯 TS 参数分支（FormatSelector / SubtitlePlanner / PathResolver / ArgvBuilder）不受离线约束，仍是 P0，且是 M3 主体交付**；验收①②③不受影响。
- **留痕**：必须写入 `docs/DECISIONS.md`，编号续 **D-31**（D-30 记 §4.2 R5 组合约束），格式按 DECISIONS（日期 / 偏离项 / 原因 / 等价性说明 / 影响范围）；`acceptance-report-m3.json` 的 ④ 证据须注明载体与缓存路径；M3 汇报「剩余 / 阻塞 / 偏离」显式列出。
- **禁止虚报**：不得声称「已完成 React + MUI + `@playwright/test` 正式基建」「Electron renderer 已接入」；不得把 `ytvdltPlannedDependencies` 登记项写成已安装依赖。

**后续需补什么（联网后，且必须先告知用户）**

| # | 补齐项 | 判据 |
|---|---|---|
| 1 | 联网安装 `react` / `react-dom` / `@mui/material` / `@playwright/test`，把 `ytvdltPlannedDependencies` 转正、更新 `pnpm-lock.yaml` | 四个包在 `node_modules` 与 lock 中可查；安装命令成功 |
| 2 | 补齐 `electron` dist 二进制，`apps/desktop/src/renderer` 真正接入 `packages/ui/` | Electron 窗口可启动，Renderer 只经 IPC 发命令（P0-17） |
| 3 | 新建 `playwright.config.ts` 与 `tests/e2e/*.spec.ts`，把静态弹窗迁移为 React 组件（MUI 可选用） | 三弹窗组件化且 §5.1–§5.3 规格不变；`npm run test:e2e` 由正式 runner 承担 |
| 4 | 用正式 `@playwright/test` 重跑三弹窗截图基线并**替换**本轮缓存 shell 基线，复验 `A-M3-06` | 新基线 diff 通过；`A-M3-01…06` **ID 不改号**（D-04） |
| 5 | 在 `DECISIONS.md` 追加「补齐完成」登记并在汇报注明 | 偏离闭环、可审计 |

---

## 6. 四条验收标准 → 可判定条件

> 来源 `PROJECT-HANDOFF.md` §7.2（= HANDOFF §8 M3）。`acceptance-report-m3.json` 每项含 `id / layer / status(PASS|FAIL|SKIPPED) / expected / actual / durationMs / evidence`；`durationMs` 必须为实测非零（D-23 / D-27）。

| # | 原标准 | 可判定 PASS 条件 | 执行命令 / 证据 | 绑定断言 | FAIL 判据 |
|---|---|---|---|---|---|
| **①** | `ArgvBuilder` 组合单测 ≥60 例（清晰度 8 档 × 编码 2 × 音频 5 档 × 字幕 5 格式 × 路径 4 组合） | 用例数 **≥60** 且 0 FAIL；8 档清晰度、2 类编码、音频 **≥5 档**（⚠️ 实际 DTO 6 档，全 6 档覆盖见 §9-②）、字幕 5 格式（`none/ass/srt/vtt/lrc`）、路径 4 组合（`subdirByExtractor × subdirByPlaylist`）均被覆盖；`EXPECTED_DOWNLOAD_ARGV` 为测试自带**字面量数组**（非引用实现常量）；`argv.at(-1)===url`、`argv.filter(x=>x==='--').length===1`、`enginePath` 不在 argv 内、无含空格拼接元素；M2 冻结顺序逐元素不回归 | `npm run test:unit -- --run ArgvBuilder --coverage`；`vitest run tests/unit/argv-builder*.test.ts --coverage` | `A-M3-11`、`A-M2-25`（复验）、`A-4.2-01…13`、`A-4.3-01…08`、`A-4.4-03/04` | 用例数 <60、任一维度未覆盖、断言引用实现常量、argv 顺序回归、出现 shell 元字符拼接 |
| **②** | 每个矩阵项有断言（M3 归属 36 条） | §3 的 **36 条**逐条有 `PASS` 且 ID 与 `PRD-M1.md` §3 完全一致（不改号）；12 条 `A-M3-01…12` 全 PASS；`scripts/acceptance.mjs --milestone M3` 产出 48 条断言，`acceptance-report-m3.json` 中 0 FAIL / 0 无证据项；**每个测试文件映射到 ≥1 条断言**（P3-5） | `node scripts/acceptance.mjs --milestone M3`；`reports/acceptance-report-m3.json`；`reports/acceptance-index.json` | 36 条矩阵项 + 12 条骨架断言 | 任一 ID 缺失 / 改号 / 重排、任一 FAIL、有测试文件未落断言 |
| **③** | Windows 非法字符 / 保留名 / 260+ 长路径单测通过 | `tests/unit/path-resolver.test.ts` 全绿：9 类非法字符 + 控制字符、保留名大小写不敏感（含带后缀变体）、结尾点 / 空格、`%(title).200B` 截断、259/260/261 边界、UNC 与 `\\?\` 前缀；超长含非法字符标题 → 截断后正常落盘且**不抛异常**；覆盖 4 组合路径预览 | `vitest run tests/unit/path-resolver.test.ts` | `A-M3-07` / `A-M3-08` / `A-M3-09`、`A-4.4-04` / `A-4.2-13` | 任一边界用例 FAIL、抛异常、产生非法 / 保留名文件、长路径未处理 |
| **④** | 三个弹窗 Playwright 截图回归 | **本轮离线载体判据**：三弹窗以 §5.5 的零依赖静态 HTML/CSS 呈现；用已缓存的 `chromium_headless_shell-1234` 固定窗口 1280×800 截图与基线 diff 通过；格式（三组分栏）/ 字幕（按语言多选）/ 播放列表三弹窗各 ≥1 张基线 + 空态 / 禁用态截图；禁用 / 空态 / 错误态与确认回写均有 DOM 断言；基线入新建 `tests/e2e/`。**正式 `@playwright/test` + React 组件版为联网后补做项，不阻塞本轮判绿**（§5.5 / D-31）；`A-M3-01…06` 判据不变 | 缓存 headless shell 直调截图脚本；`tests/e2e/**` 基线；`reports/` diff 记录 | `A-M3-01…06`、`A-4.2-04`、`A-4.3-08`、`A-4.1-07` | 截图 diff 失败、三态缺失、确认未回写 DTO、播放列表弹窗误入队、把登记项当已安装依赖 |

> **B0 前置（不计入四条但阻塞全部）**：P0-01 / R2-1 反例复验必须先 PASS；否则 ①–④ 的「全绿」不可信（`PROJECT-HANDOFF.md` §2.2.1）。
> **稳定性口径**：沿用 M2 实践 —— 验收命令连跑 N 次（建议 3 次）全绿才算稳；L2 串行（`fileParallelism:false`）；覆盖率只认全量运行（`npm test` / `vitest run --coverage`），定向数字仅作诊断。

---

## 7. 硬约束与合规红线（永久有效，违反即返工）

> 来源 `PROJECT-HANDOFF.md` §3（= HANDOFF §9 禁止事项 + §6.7 合规边界 + §3.6 许可证）。M3 新增参数分支与 UI **不得扩大攻击面**。

| # | 约束 | M3 具体落地 |
|---|---|---|
| 1 | 不重新讨论选型、命名、平台范围 | 沿用 Electron 45 + React + TS + Vite / Windows x64 / 官方 yt-dlp.exe 子进程 / 产品名 YTVDLT |
| 2 | 不复制 Seal 的 Kotlin/Java 源码、XML 资源、图标、字符串 | 只参照 HANDOFF §4 行为规格与 §11 CLI 参数语义；三弹窗按 HANDOFF §6.8 重新设计，不要求像素级复刻（U6） |
| 3 | 不用 "Seal" 作产品名 / 包名 / 窗口标题 / 图标 / 宣传语 | README / 弹窗文案统一 YTVDLT |
| 4 | **不实现任何绕过能力** | 不做 DRM / 付费墙 / 会员内容 / 登录限制 / 地区限制（`--geo-bypass*`）/ 年龄限制；**不生成或注入 PO Token**；**不自动抓取浏览器凭据**（`--cookies-from-browser`）；**不降低 TLS 校验**（`--no-check-certificates` / `--prefer-insecure`）；不内置 WebView 登录；`--cookies` 只接受用户手动导入的自有 `cookies.txt`（A-4.4-26 / A-4.6-04）。白名单拦截，遇到此类需求直接拒绝 |
| 5 | **不字符串拼接命令、不 `shell:true`** | 一律 `spawn(绝对路径, argv[], { shell:false, windowsHide:true })`；用户可控 token 置于 `--` 之后且 URL 为最后元素；`SpawnOptions.shell` 在类型层面锁死 `false`（`packages/shared/src/ports.ts:30-38`）；`--download-sections "*..."` 中的 `*` 是 yt-dlp 语法字面量、不是 shell 通配符，因 `shell:false` 不会被展开 |
| 6 | 不跳过完整性校验置 `Completed` | 必须 `verify().ok===true` 才置 Completed、才写历史（C12 时序铁律）；M3 新增后处理分支后 C2↔C8 动态二选一（D-19）不回归 |
| 7 | 不一次性生成大量未经验证的代码 | 按 B0…B5 分批，每批跑通验证再进下一批，每批一个 commit |
| 8 | 暂停 ≠ 暂停 | UI 统一命名「取消 / 重试」，不引入 `Paused` 状态 |
| 9 | `--cookies` 只接受手动导入，日志与报告中 Cookie 一律脱敏 | M3 新增 `--add-header` / `--proxy` / `--ppa` / `--replace-in-metadata` 后，A-4.4-30 脱敏面复验（§3.7） |
| 10 | **离线约束（本轮）** | 按 `PROJECT-HANDOFF.md` §6.4「要联网前必须先告知用户」，本轮**不联网安装任何依赖**；`ytvdltPlannedDependencies` 是登记项，不得当作已安装；不使用不存在的 `node_modules/electron/dist`；B4 载体按 §5.5 默认假设落地；B1–B3 纯 TS 参数分支不受此约束、仍为 P0 |
| 11 | **不虚报 UI 基建 / 偏离必须留痕** | 不得声称已建成 React + MUI + `@playwright/test` + Electron renderer 正式基建；B4 载体偏离须写入 `DECISIONS.md`（续 D-31）、在 `acceptance-report-m3.json` ④ 证据注明载体、并在 M3 汇报显式列出；不得把登记项写成已安装依赖 |

**合规提示语**（首次运行页与「关于」页，M5 落地、M3 文案预留）：帮助用户保存**其有权保存的公开可访问内容**；用户自行确认权利与站点条款。工具不做权利判断，也不提供规避技术措施的能力。

**M3 禁用参数清单（argv 组合断言必须逐项排除）**：`--cookies-from-browser`、`--geo-bypass` / `--geo-bypass-country` / `--geo-bypass-ip-block`、`--no-check-certificates`、`--prefer-insecure`、`--exec`、`--config-locations` 嵌套、`--ppa` 任意脚本注入、PO Token 相关生成 / 注入逻辑。

---

## 8. M3 明确不做（硬边界）

| # | 不做项 | 归属 / 依据 |
|---|---|---|
| 1 | **并发调度**（可配默认 3、自动补位） | M4 / HANDOFF §8 M4 / PROJECT-HANDOFF §7.6；M3 队列仍串行（maxActive=1） |
| 2 | **托盘 / 系统通知**（进度 / 完成 / 错误 / 取消、关窗最小化） | M4 / §7.6 |
| 3 | **自定义命令模板**（CRUD + 参数白名单 + 任务日志页） | M4 / §7.6；`AdvancedDomain.customCommand` 字段已冻结但 M3 不消费 |
| 4 | **打包**（NSIS 安装版 / 便携版 EXE、代码签名、C13–C16） | M5 / HANDOFF §8 M5 |
| 5 | **L3 在线烟测**（真实站点下载） | M5 / §7.1；M3 全程离线（L2 仅 127.0.0.1）；要联网前必须先告知用户 |
| 6 | **`probePlaylist()` 真实实现** | PROJECT-HANDOFF §7.6：M3 只做播放列表**解析（L1 fixture）与选择弹窗**，批量入队留 M4；接口保持 `UNKNOWN` 占位（§10 Q-M3-04） |
| 7 | 播放列表**批量入队**（`--playlist-items` 每条独立任务） | M4 / HANDOFF §8 M4 验收③ |
| 8 | 主题三态 / 全局快捷键 / i18n / 双通道自动更新 | M5 |
| 9 | 真暂停、任务优先级、arm64 包 | v1.1 延后 |
| 10 | 竞品分析 / 市场调研 | 本次为简单 PRD，用户未要求 |
| 11 | **推进 M4–M5** | M3 汇报后停下等甲方放行，未放行不自动推进（HANDOFF §8 / §10 Step 5） |
| 12 | **本轮不联网安装 UI / 测试依赖、不搭建正式 React + MUI + `@playwright/test` + Electron renderer 基建** | 离线约束（`PROJECT-HANDOFF.md` §6.4）；属**临时载体偏离、非功能删减**，三弹窗规格与验收④仍为 P0；后续补齐清单见 §5.5，联网前必须先告知用户 |

---

## 9. 文档 / 实际代码差异登记（⚠️ 以实际代码为准）

> 依据 `packages/shared/src/request.ts`、`packages/shared/src/media.ts`、`packages/shared/src/ports.ts`、`packages/engine-ytdlp/src/argv-builder*.ts`、`scripts/acceptance.mjs` 与目录实测。以下均为**观察与裁决**，不修改任何代码 / 文档（除本 PRD）。

| # | 差异 | 实际代码 / 依据 | 本 PRD 裁决 |
|---|---|---|---|
| **①** | **M3「36 条」口径冲突**：`PROJECT-HANDOFF.md` §7.3 写「§4.2 13 条全归 M3」并列入 `A-4.4-30`；`PRD-M1.md` §3.2 / §3.4 / §3.7 与 `scripts/acceptance.mjs` 实际登记 `A-4.2-06` = **M2**（`download-local` C6，`acceptance.mjs:135`）、`A-4.4-30` = **M1**（Logger 脱敏，`acceptance.mjs:25`） | `scripts/acceptance.mjs:25,135`；`docs/PRD-M1.md:131,185,218` | **以 PRD-M1 + acceptance.mjs 为准**，36 条按 §3 列出；两条不重编号、不计入 36，列为 §3.7 回归复验项；`A-4.6-02`（M2，D-25 遗留）同列 |
| **②** | **音频档位数**：验收①写「音频 5 档」，`FormatDomain.audioQuality` 实为 **6 个枚举值** `'best'\|'192'\|'128'\|'64'\|'32'\|'lowest'`；HANDOFF §4.2 文本自身也有「3 档 + 最佳/最低 = 5 分支」与「UI 文案含 32 Kbps」的出入 | `packages/shared/src/request.ts:29` | **以实际 DTO 为准**：M3 全 6 档覆盖（≥5 满足验收①），判据见 `A-4.2-07` / `A-M3-11`；写入 §10 Q-M3-02 |
| **③** | **M2 已实现部分「M3 全量参数」**：`buildDownload` 已生成 `-f` / `-S` / `-x` / `--audio-format` / `--audio-multistreams` 与字幕基础子集 `--write-subs` / `--sub-langs` / `--write-auto-subs` / `--embed-subs` / `--convert-subs`；`sortingFields` 优先于 `quality` 已用 if/else 实现 | `packages/engine-ytdlp/src/argv-builder-download.ts:63-88` | 文档 §7.1「全量分支」理解为**补全 + 加裁决**，不是从零实现；M3 必须在不破坏 `A-M2-25` 冻结顺序的前提下扩展（新增段插入位置由架构师定义并全量回归） |
| **④** | **大量 DTO 字段已冻结但 M2 未消费**：`videoCodecPref` / `audioQuality` / `audioCodecPref`、`subtitle.skipTranslated` / `keepSubtitleFile`、`paths.privateMode` / `subdirByExtractor` / `subdirByPlaylist` / `tempDir` / `commandDir`、`network.ipv4Only` / `aria2cPath`、`advanced.sponsorblockRemove` / `downloadSections` / `splitChapters` / `customTitle` / `debug` / `customCommand` 均未在 `buildDownload` 出现（仅 `downloadArchive` 被用） | `packages/shared/src/request.ts:23-74` vs `argv-builder-download.ts:51-117` | 这些正是 M3 补全清单；**不新增 / 不修改五域签名**（PROJECT-HANDOFF §5.3 冻结契约）。`mergeToMkv` 为 `SubtitlePlanner` 内部派生值，不写进 `PathsDomain`（`request.ts:45-54` 无该字段）；若架构判定必须加字段，须走 `DECISIONS.md` + 全量回归 |
| **⑤** | **HANDOFF 未明确 `--split-chapters` / `--download-sections` / `--remux-video` 的组合约束** | `YTVDLT_HANDOFF.md` §4.2 行 205、§11 行 746 只分别列出参数 | 按 §4.2 规则 R5 的默认优先级链裁决（裁剪 > 拆分 > 嵌入 mkv），属 M3 新增设计决定，须写入 `DECISIONS.md`（续 D-30 起），见 §10 Q-M3-03 |
| **⑥** | `packages/ui/` **不存在**（M1 REPORT 与 M2 REPORT 均声明无 UI / 无 `.tsx`） | `Glob packages/ui/**` → No files found；`docs/M2-REPORT.md:22` | M3 新建 `packages/ui/`；Renderer 只发命令，分层铁律不回归（P0-17） |
| **⑦** | `scripts/acceptance.mjs` **只有 M1 / M2 分支**，无 `runM3()` / `M3_ASSERTIONS` | `scripts/acceptance.mjs:363`（`if (milestone === 'M2') …`，默认 M1） | M3 由工程新增 `runM3()` 与 48 条断言定义、产出 `acceptance-report-m3.json`；沿用 `writeMilestoneReports()` 分文件不互覆盖（D-27） |
| **⑧** | `MediaFormat.url` / `SubtitleTrack.url` 可能含签名 / 凭据 | `packages/shared/src/media.ts:15-16, 23` 注释明写「NEVER log or put in a report」 | 三弹窗**禁止渲染 / 记录 / 上报**这两个字段（§5.0）；A-4.4-30 脱敏复验覆盖 |
| **⑨** | `IShellPort` 在 M2 只到 `explorer.exe` argv 契约，真实默认播放器启动未完成 | `docs/DECISIONS.md` D-25；`docs/M2-REPORT.md:151` | 列为 §3.7 回归复验项 + `A-M3-12` 收口，M3 接 Electron `shell` 后 L2 复验 |
| **⑩** | `PROJECT-HANDOFF.md` §5.3 说 `probePlaylist()` 在 M3 实现，§7.6 又说不做真实实现 | `docs/PROJECT-HANDOFF.md:282,415` | 以更具体的 §7.6 与 team-lead 边界为准：M3 只做 L1 fixture 解析 + 选择弹窗，接口保持占位（§10 Q-M3-04） |
| **⑪** | `PROJECT-HANDOFF.md` 有一处用户未提交修改 | 团队任务说明 | **本 PRD 不读写、不修改该文件**，原样保留 |
| **⑫** | `ProcessPort.shell` / `windowsHide` 在**类型层面**锁死 | `packages/shared/src/ports.ts:30-38`：`shell: false` / `windowsHide: true` | M3 不必再运行时判空；仍需在 `A-M3-11` 断言 argv 无 shell 元字符拼接 |
| **⑬** | **UI / 测试依赖只是登记项、未安装**：根 `package.json` 的 `ytvdltPlannedDependencies` 含 `react ^19.0.0` / `react-dom ^19.0.0` / `@mui/material ^6.0.0` / `@playwright/test ^1.50.0`；`node_modules/{react,react-dom,@mui/material,@playwright/test,playwright}` 均不存在，`pnpm-lock.yaml` 中 `react-dom` / `@mui/material` / `@playwright/test` 命中数均为 0 | `package.json:31-41`；`pnpm-lock.yaml`；`node_modules` 目录实测 | **以实际磁盘为准：未安装**。本轮离线不装（§7 第 10 条），B4 按 §5.5 零依赖静态载体；不得改 lock、不得把登记项写成已装依赖 |
| **⑭** | **Playwright 浏览器缓存存在，但 Electron dist 不在**：`C:/Users/leolee/AppData/Local/ms-playwright/` 含 `chromium-1234` / `chromium_headless_shell-1234` / `ffmpeg-1011` / `winldd-1007`；`node_modules/electron/dist` 不存在 | 本机目录实测（本项目复核） | 缓存 headless shell 可作本轮截图载体（§5.5）；Electron renderer 接入属联网后补齐项，M3 不声称已完成 |
| **⑮** | **UI / e2e / renderer / playwright 配置全部不存在**：`packages/ui/`、`tests/e2e/`、`apps/desktop/src/renderer`、`playwright.config.{ts,js,mjs}` 均无 | Glob / 目录实测（0 结果） | 三弹窗与截图回归基建**从零搭建**；本轮按 §5.5 建最小静态载体 + `tests/e2e/` 基线目录，不引入 npm 依赖 |
| **⑯** | **离线约束与 B4 载体偏离**：任务书要 React + 组件库 + Playwright 截图回归，本轮离线无法安装依赖 | `PROJECT-HANDOFF.md` §6.4；本 PRD §5.5 | 定性为「实现载体 / 验收工具的临时等价替代，非功能删减」；三弹窗规格与四条验收仍 P0；B1–B3 纯 TS 不受约束；偏离写入 `DECISIONS.md`（D-31）并在汇报列出 |

---

## 10. 待确认问题与默认假设（不阻塞开工，全部「记录并继续」）

> 遵循 HANDOFF §9 禁止事项 1 与 PRD-M1 §6 口径：**不中途向用户 / 甲方提问**，以下均给出默认假设直接生效；若实现阶段偏离，写入 `docs/DECISIONS.md`（续 **D-30** 起，B4 载体偏离另记 **D-31**）并在 M3 汇报显式列出。
> **本轮补充（离线）**：Q-M3-15…18 针对「依赖未安装 + 不联网」新增，默认假设直接生效；**B1–B3 纯 TS 参数分支不受影响，仍为 P0**。

| ID | 待确认点 | **默认假设（直接生效）** |
|---|---|---|
| **Q-M3-01** | 「36 条」口径冲突（§9-①）：`A-4.2-06` / `A-4.4-30` 是否被计入 M3 | 以 `PRD-M1.md` §3.7 + `acceptance.mjs` 为准，**不计入 36**；两条 + `A-4.6-02` 列为回归复验项（§3.7），ID 不改号 |
| **Q-M3-02** | 音频档位 5 vs 6（§9-②） | 以 `request.ts` 实际 6 个枚举值全量覆盖；验收①「≥5 档」按最低要求理解，6 档全绿更严格 |
| **Q-M3-03** | `split-chapters` / `download-sections` / `remux-video` 组合约束 HANDOFF 未定义（§9-⑤） | 按 §4.2 规则 R5 优先级链：裁剪 > 拆分 > 嵌入 mkv；拆分模式禁用字幕嵌入；章节为空禁用拆分；冲突记 WARNING。写入 `DECISIONS.md` D-30 |
| **Q-M3-04** | `probePlaylist()` 真实实现是否 M3 做（§9-⑩） | **不做**；M3 只做录制 flat-playlist fixture 的 L1 解析（A-4.1-05）+ 播放列表选择弹窗；接口维持 `UNKNOWN` 占位；批量入队留 M4 |
| **Q-M3-05** | `--ppa` 封面裁剪在当前 yt-dlp `2026.10.26` 上的支持性 | 默认用**显式 `--ppa` argv**、不写临时 config（§4.2 行 203）；若版本不支持，降级为「不裁剪」并在 `DECISIONS.md` 留痕，`A-4.2-10` 的其余元数据嵌入判据不变（P1-06） |
| **Q-M3-06** | 播放列表弹窗确认后的数据去向（M3 不入队） | 默认写入配置 / 预览状态（选中 id 列表），供 M4 消费；按钮文案「保存选择」，断言未创建 `TaskRecord` |
| **Q-M3-07** | 三弹窗是否引入 React / 第三方组件库（§9-⑬：**React 本身也未安装**） | 默认**本轮完全不引入 UI npm 依赖**，用零依赖静态 HTML/CSS（§5.5 / Q-M3-15）；联网后再按 §2 拍板技术栈接入 React（MUI 可选用），届时才谈组件库选型；不改 §2 拍板项，载体偏离写 `DECISIONS.md` D-31 |
| **Q-M3-08** | Playwright 基线窗口 / 字体参数 | 默认 1280×800、固定 `deviceScaleFactor` 与字体栈，截图基线入 `tests/e2e/`；具体数值由架构师定，须保证跨机器 diff 稳定 |
| **Q-M3-09** | `--restrict-filenames` 与自定义模板 / 自定义标题同开时的净化顺序 | 默认：**模板渲染 → 文件名净化 → 拼输出目录 → 长路径截断 / `\\?\` 前缀**；`PathResolver` 纯函数单测覆盖该顺序（A-M3-09） |
| **Q-M3-10** | R1 互斥中「音质档位」是完全抑制还是仅抑制 `abr~` | 默认**完全抑制 `-S abr~N`**，但保留 `acodec:opus/aac` 编码偏好（HANDOFF §4.2 行 201/202 为两个独立能力） |
| **Q-M3-11** | `mergeToMkv` 是否要新增到 `PathsDomain` | 默认**不新增**，作为 `SubtitlePlanner` 内部派生决策（§9-④）；冻结 DTO 不改，避免全量回归风险 |
| **Q-M3-12** | `A-M3-xx` 编号上限与后续追加 | 默认 `A-M3-01…12`（§3.8）；若工程实现需更多断言，**续号追加、不重编号**（D-04）；M3 汇报以实际 `acceptance-report-m3.json` 为准 |
| **Q-M3-13** | B0 的 R2-1 修复是否算 M3 断言 | 默认**不算矩阵断言**，作为门控前置（P0-01）单独留证；`guardMitigated` 记录 `originalStatus`，反例复验证据写入 `reports/` |
| **Q-M3-14** | M3 覆盖率目标 | 沿用 D-02 口径：四维最低 **≥70%** 判定，向 §7.1 的 ≥80% 收敛；M2 实测 85.42%，M3 不得因新增分支跌破 70% |
| **Q-M3-15** | B4 在「不联网、依赖未装」前提下如何实现三个弹窗 | 默认**纯零依赖静态 HTML/CSS + 原生 DOM 交互**，不引入 `react` / `react-dom` / `@mui/material`；数据由 L1 录制 `MediaInfo` / `PlaylistInfo` fixture JSON 注入（禁止虚构）；确认产出与 `DownloadRequest` 五域同构的回写结果供断言核验。属**载体偏离、非功能删减**（§5.5），§5.1–§5.3 规格与 `A-M3-01…06` 判据不变；B1–B3 纯 TS 参数分支仍是 P0 |
| **Q-M3-16** | 无 `@playwright/test` / `playwright.config.*` 时如何做截图回归 | 默认直调已缓存 `C:/Users/leolee/AppData/Local/ms-playwright/chromium_headless_shell-1234`，固定 1280×800 + 字体 / DPI，截图与 `tests/e2e/` 基线 diff；`npm run test:e2e` 本轮由本地截图脚本承担；正式 runner 为联网后补做项，**不阻塞 M3 判绿**；`A-M3-06` 届时复验、ID 不改号 |
| **Q-M3-17** | 弹窗数据来源与 Electron renderer 缺失 | 默认用 L1 录制 fixture（与 Core DTO 同源），禁止虚构数据；不声称 Electron renderer 已接入；`MediaFormat.url` / `SubtitleTrack.url` 含凭据仍禁止渲染 / 日志 / 报告（§5.0） |
| **Q-M3-18** | 载体偏离如何留痕、后续补什么 | 默认写入 `DECISIONS.md` **D-31**（D-30 记 §4.2 R5）、`acceptance-report-m3.json` ④ 注明载体与缓存路径、M3 汇报显式列出；联网后（须先告知用户）按 §5.5「后续补齐清单」5 项补依赖 / renderer / playwright 配置 / 正式基线 / 闭环登记，`A-M3-01…06` ID 不改号 |

---

## 11. M3 汇报模板（照 HANDOFF §8 执行）

```
## M3 汇报
- 完成了什么：            （对照 P0-01..P0-18 逐条；§7.1 五块 + 四条验收）
- 改了哪些文件：          （packages/{core,engine-ytdlp,ui,shared}/**、apps/desktop/src/main/**、
                           scripts/acceptance.mjs、tests/{unit,contract,integration,e2e}/**、docs/DECISIONS.md）
- 如何运行：              npm test / npm run test:e2e / node scripts/acceptance.mjs --milestone M3
- 如何验收：              ① ArgvBuilder 组合 ≥60 例  ② 36 条矩阵项 + 12 条 A-M3 断言
                          ③ path-resolver 边界单测  ④ 三弹窗 Playwright 截图回归
                          + reports/acceptance-report-m3.json 链接
- 矩阵项 → 断言 ID 对照表：本 PRD §3（36 行全表）+ §3.8（A-M3-01…12）+ §3.7（3 条回归复验）
- 剩余 / 阻塞 / 偏离：     Q-M3-01…18 的实际取舍、D-30 / D-31 起的偏离、M2 遗留收口结果
- B4 载体偏离：        （§5.5：离线零依赖静态弹窗 + 缓存 headless shell 截图；DECISIONS D-31；
                          联网后按 §5.5 补齐清单 5 项，A-M3-01…06 不改号）
- 停下声明：              未获甲方放行，不进入 M4
```

---

*文档结束 · 本 PRD 仅覆盖 M3，不含业务代码；断言 ID 稳定不改号；未获甲方放行不进入 M4。*
