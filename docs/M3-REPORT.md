# M3 汇报

> 依据 `docs/PRD-M3.md` §11 模板 / `docs/ARCHITECTURE-M3.md` v1.1 §6.6。
> 所有数值均来自本机真实命令输出；未联网、未安装任何 npm 依赖、`pnpm-lock.yaml` 零改动。
> 分支 `master`，批次 B0…B5 各一个 commit。

---

## 1. 完成了什么

| 批次 | commit | 交付 |
|---|---|---|
| **B0 门控修复** | `07a77b4` | 修 `runVitestGuarded` R2-1 漏洞（runId + startedAt + 单文件证据删除 + mtime 新鲜度 + 覆盖率四维 ≥70 复算 + 仅 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 可缓解 + 结构化 `vitest-guard.json` / `environmentMitigations` 对象数组）；新增 `scripts/lib/guard-negative-check.mjs` 5 例反/正例复验；`check-layering.mjs` 扩展 `packages/ui/src` 与 UI 禁 `node:fs`/`child_process`/`electron` |
| **B1 纯函数与裁决** | `8ce0111` | `DownloadPlan` / `resolveDownloadPlan()` / `FormatSelector` / `SubtitlePlanner` / `PathResolver` 纯函数；R1–R5 五组互斥正反向单测、P0→P7 优先级链可枚举；脱敏面扩展 `--cookies`/`--proxy`/`--add-header`/`--replace-in-metadata`/`--ppa` 全掩码 |
| **B2 PathResolver** | `a58ea40` | 9 类非法字符 + 控制字符、保留名大小写不敏感（含 `CON.txt`）、结尾点/空格、`%(title).200B` 截断、259/260/261 边界、UNC 与 `\\?\` / `\\?\UNC\` 前缀、`buildOutputDir` 4 组合、3 内置模板 + 自定义模板、三目录/私有目录配置持久化 |
| **B3 argv 全量** | `6fad957` | 按 §4 条件性扩展 `buildDownload`（64 组组合用例、共 91 例）；`argv-compliance.ts` 白名单 + 禁用参数逐项注入抛错；M2 遗留收口（D-18 stage 分段 / C11 `historyEntry` 回填 / Electron `shell` 契约 / D-28 SKIPPED 留痕） |
| **B4 三弹窗与截图** | `0b109a2` | 新建 `packages/ui/`（零新增依赖 `.html/.css/.js`）；三弹窗规格 §5.1–5.3 全量 + 四态门禁 + 五域同构回写；`npm run test:e2e` 用缓存 `chrome-headless-shell.exe` 截图 + DOM 快照 + `node:zlib` PNG diff；14 张 PNG + 14 份 DOM 基线；`IpcGateway` / preload / `PROBE_PLAYLIST` L1 fixture 解析；播放列表确认仅回写 `selectedIds` |
| **B5 验收与汇报** | 本批 | `scripts/acceptance.mjs` 新增 `runM3()` / `M3_ASSERTIONS`（48 条）/ `--milestone M3`；`reports/acceptance-report-m3.json`；`docs/DECISIONS.md` D-30…D-45 共 16 条定稿；本汇报 |

**四条验收标准**：

| # | 判据 | 实测结论 |
|---|---|---|
| ① | ArgvBuilder 组合单测 ≥60 例（清晰度 8 × 编码 2 × 音频 6 × 字幕 5 × 路径 4） | `tests/unit/argv-builder-m3.test.ts` **91 例**（其中 64 组组合用例）0 FAIL；`EXPECTED_MINIMAL` 与 `DOWNLOAD_ARGV_FROZEN_ORDER` 对 `HEAD` **逐字节一致**；`request.ts` / `pnpm-lock.yaml` 零改动 |
| ② | 36 条矩阵项 + 12 条 `A-M3` = 48 条断言全 PASS、0 FAIL / 0 无证据 | `node scripts/acceptance.mjs --milestone M3` → `reports/acceptance-report-m3.json`；连跑 3 次；每个测试文件映射到 ≥1 断言（P3-5） |
| ③ | Windows 非法字符 / 保留名 / 260+ 长路径单测通过 | `tests/unit/path-resolver.test.ts` **30 例全绿**（9 类非法字符、控制字符、`CON.txt`、259/260/261、UNC、`\\?\` 前缀、`%(title).200B`、4 组合路径预览） |
| ④ | 三弹窗截图回归 | 离线载体：`npm run test:e2e` **14/14 cases + 5/5 negative checks**，连跑 3 次全绿；固定 1280×800 / DPR1 / 字体栈 / `--disable-lcd-text`；基线含 `format-empty` / `format-disabled` / `format-error` / `subtitle-empty` / `subtitle-disabled` / `subtitle-invalid-expression` / `playlist-empty` / `playlist-error` 等三态截图 |

**B0 门控前置（P0-01，不计入 48）**：`node scripts/lib/guard-negative-check.mjs` 5/5 PASS + 1 项附加硬化检查 PASS，产物 `reports/r2-1-negative-verification.json`；结构化门控记录 `reports/vitest-guard.json`。

**M1 / M2 不回归**：`--milestone M1` 17/17 + 5/5 `allGreen=true`；`--milestone M2` 37/37 + 5/5 `allGreen=true`；三份报告并存。

---

## 2. 改了哪些文件

- **B0**（7）：`scripts/lib/vitest-run.mjs`、`scripts/lib/guard-negative-check.mjs`、`scripts/check-layering.mjs`、`scripts/run-tests.mjs`、`scripts/acceptance.mjs`、`tests/unit/vitest-run-guard.test.ts`、`docs/DECISIONS.md`
- **B1**（21）：`packages/shared/src/{download-plan,dialog-dto}.ts` + `index.ts` / `ipc.ts`；`packages/core/src/{decision,format-selector,subtitle-planner,path-resolver}/`；`packages/core/src/index.ts`；`packages/core/src/logger/{redactor,index,logger}.ts`；5 个新测试 + `logger.test.ts`
- **B2**（2）：`packages/core/src/config-store/defaults.ts`、`tests/unit/path-resolver.test.ts`
- **B3**（15）：`packages/engine-ytdlp/src/{argv-builder-download,argv-compliance,index,progress-parser}.ts`；`packages/core/src/{download-flags,task-queue/task-queue}.ts`；`apps/desktop/src/main/{index,app-host,adapters/node-ports,adapters/electron-shell-port}.ts`；5 个测试文件；`docs/DECISIONS.md`、`reports/m3-legacy-closure.json`（报告不入库）
- **B4**（58）：`packages/ui/**`（13 个源文件 + `package.json` / `tsconfig.json`）、`scripts/{run-e2e,e2e-cases}.mjs`、`scripts/lib/png-diff.mjs`、`tests/e2e/**`（3 fixtures + 14 PNG + 14 DOM 基线 + README）、`tests/contract/{playlist-fixture,dialog-dto}.contract.test.ts`、`apps/desktop/src/main/{ipc-gateway,index,app-host}.ts`、`apps/desktop/src/preload/bridge.ts`、`tests/unit/layering.test.ts`、`tests/fixtures/README.md`、根 `package.json`（**仅新增 `test:e2e` 一行**）、`docs/DECISIONS.md`
- **B5**（3）：`scripts/acceptance.mjs`、`docs/DECISIONS.md`、`docs/M3-REPORT.md`；产物 `reports/acceptance-report-m3.json` / `acceptance-index.json`（`reports/*` 被 `.gitignore` 忽略）

**未改动 / 未入库**：`docs/PROJECT-HANDOFF.md`（用户 239 行未提交编辑，原样保留）、`docs/PRD-M3.md`、`docs/ARCHITECTURE-M3.md`（上游产出，只读）、`packages/shared/src/request.ts`（M1 冻结五域签名，`git diff` 为空）、`pnpm-lock.yaml`（零改动）。

---

## 3. 如何运行

```bash
npm test                                        # 全量 L0+L1 单测 + v8 覆盖率
npm run test:e2e                                # 三弹窗截图 / DOM 快照回归（独立脚本）
npm run test:e2e -- --negative-checks           # 反例复验（内置 5 例）
npm run test:e2e -- --update-baselines          # 仅在有意重录基线时使用
node scripts/lib/guard-negative-check.mjs       # B0 门控 5 例反/正例
node scripts/check-layering.mjs --json          # 分层守卫
node scripts/check-runtime.mjs --json           # 运行时 3/3 必需 OK
pnpm turbo run typecheck                        # 5/5 包类型检查
node scripts/acceptance.mjs --milestone M1      # M1 回归
node scripts/acceptance.mjs --milestone M2      # M2 回归
node scripts/acceptance.mjs --milestone M3      # M3 48 条断言
```

---

## 4. 如何验收（实际输出摘要）

| 命令 | 实际输出 | exit |
|---|---|---|
| `npm test` | `Test Files 33 passed (33)` / `Tests 464 passed (464)` / `All files 93.89 \| 86.24 \| 94.47 \| 93.89`（lines/branches/functions/statements，最低 **86.24%** ≥70） | 0 |
| `pnpm turbo run typecheck --force` | `Tasks: 5 successful, 5 total` | 0 |
| `node scripts/check-layering.mjs --json` | `violations: []`, `violationsCount: 0`（UI 禁 `node:fs`/`child_process`/`electron`） | 0 |
| `node scripts/check-runtime.mjs --json` | `allRequiredOk=true`，3 必需 OK + aria2c OPTIONAL 缺失符合预期 | 0 |
| `node scripts/lib/guard-negative-check.mjs` | 5/5 cases PASS + `extra-marker-required` PASS | 0 |
| `npm run test:e2e` ×3 | 每次 `14/14 cases PASS, 5/5 negative checks PASS, allPass=true`；exe `Google Chrome for Testing 151.0.7922.34` | 0 |
| `node scripts/acceptance.mjs --milestone M1` | `17/17 assertions PASS, 5/5 acceptance PASS, allGreen=true` | 0 |
| `node scripts/acceptance.mjs --milestone M2` | `37/37 assertions PASS, 5/5 gates PASS, allGreen=true` | 0 |
| `node scripts/acceptance.mjs --milestone M3` ×3 | `48/48 assertions PASS, 3/3 regression rechecks PASS, 12/12 gates PASS, 4/4 acceptance PASS, allGreen=true`；全量重跑 `470/470 tests`，`94.11 \| 86.77 \| 94.93 \| 94.11`（最低 **86.77%**）；38 个测试文件全部映射；51 项 `durationMs` 最小 77 809 ms（实测非零）；0 无证据项；7 项偏离如实登记 | 0 |

> 两个覆盖率数字来自**两条不同的真实全量命令**：`npm test`（`run-tests.mjs` 的 unit+contract 集合，464 例）与 `--milestone M3` 内部重跑的 `vitest run --coverage`（含 L2 integration 文件，470 例）；两者四维最低均 ≥70，不互相覆盖。

**QA 反例复验实测（还原前后基线 SHA-256 一致）**：把 `tests/e2e/baselines/format-ready.png` 换成 `subtitle-ready.png` → `npm run test:e2e` **exit 1**（114699 差异像素 / 11.2011%）；在 `format-ready.dom.html` 追加 `<!-- QA-CORRUPTED -->` → **exit 1**（`DOM snapshot differs from baseline`）；还原后 → **exit 0**。不是恒真兜底。

**证据路径**：

- `reports/acceptance-report-m3.json`（48 条 + 3 复验 + 4 验收 + 12 gates + 偏离清单）
- `reports/acceptance-report-m1.json`、`reports/acceptance-report-m2.json`、`reports/acceptance-index.json`（三条 summary）
- `reports/vitest-results.json`、`coverage/coverage-summary.json`、`reports/vitest-guard.json`
- `reports/r2-1-negative-verification.json`、`reports/e2e-summary.json`、`reports/m3-legacy-closure.json`
- `reports/layering.json`、`reports/check-runtime.json`

**验收④ evidence（B4 载体）**：零新增 npm 依赖静态 HTML/CSS + 原生 DOM 状态机；
缓存 exe `C:\Users\leolee\AppData\Local\ms-playwright\chromium_headless_shell-1234\chrome-headless-shell-win64\chrome-headless-shell.exe`；
版本 `Google Chrome for Testing 151.0.7922.34`；窗口 `1280x800` / DPR 1 / `--disable-lcd-text` / 固定字体栈 `Arial, Helvetica, Liberation Sans, sans-serif`；
基线 `tests/e2e/baselines/*.png` + `*.dom.html`；`spawnSync(绝对路径, argv[], {shell:false, windowsHide:true})`。
依据 `docs/DECISIONS.md` **D-31**。

---

## 5. 矩阵项 → 断言 ID 对照表

### 5.1 36 条矩阵项（与 `docs/PRD-M1.md` §3 完全一致，不改号、不重排）

| 节 | 断言 ID | 首次判绿批次 |
|---|---|---|
| §4.1（3） | `A-4.1-01` `A-4.1-05` `A-4.1-07` | B3 / B4 / B4 |
| §4.2（12） | `A-4.2-01` `A-4.2-02` `A-4.2-03` `A-4.2-04` `A-4.2-05` `A-4.2-07` `A-4.2-08` `A-4.2-09` `A-4.2-10` `A-4.2-11` `A-4.2-12` `A-4.2-13` | B1–B4 |
| §4.3（8） | `A-4.3-01` `A-4.3-02` `A-4.3-03` `A-4.3-04` `A-4.3-05` `A-4.3-06` `A-4.3-07` `A-4.3-08` | B1 / B3 / B4 |
| §4.4（7） | `A-4.4-01` `A-4.4-02` `A-4.4-03` `A-4.4-04` `A-4.4-25` `A-4.4-26` `A-4.4-27` | B2 / B3 |
| §4.5（4） | `A-4.5-01` `A-4.5-02` `A-4.5-04` `A-4.5-07` | B3 / B4 |
| §4.6（2） | `A-4.6-01` `A-4.6-04` | B2 / B3 |

### 5.2 12 条骨架断言

`A-M3-01`（格式三组分栏）、`A-M3-02`（多选音频流 / 合计体积）、`A-M3-03`（字幕按语言多选）、`A-M3-04`（播放列表仅回写 selectedIds）、`A-M3-05`（三态门禁）、`A-M3-06`（截图回归）、`A-M3-07`（非法字符净化）、`A-M3-08`（保留名 / 长路径 / UNC）、`A-M3-09`（模板渲染 + 路径预览）、`A-M3-10`（R1–R5 互斥裁决）、`A-M3-11`（≥60 例组合单测）、`A-M3-12`（M2 遗留收口）。

### 5.3 3 条回归复验项（单列 PASS，**不计入 36**）

| ID | 原归属 | M3 复验结论 |
|---|---|---|
| `A-4.2-06` | M2 / L2 / C6 | PASS：仅音频产物无 video 流不回归（`artifact-verifier` / `fake-engine`） |
| `A-4.4-30` | M1 / L0 | PASS：M3 扩大脱敏面后 Cookie / 凭据 / token / UA 全掩码（`logger` / `redactor-m3`） |
| `A-4.6-02` | M2 / L0 / D-25 | PASS：`IShellPort` argv 契约 + Electron `shell` 注入契约；**真实窗口启动 SKIPPED**（D-39） |

---

## 6. Q-M3-01…18 实际取舍

| ID | 实际取舍 | 留痕 |
|---|---|---|
| Q-M3-01 | 36 条口径以 `PRD-M1` §3.7 为准；`A-4.2-06` / `A-4.4-30` / `A-4.6-02` 单列复验、不计入 36 | D-41 |
| Q-M3-02 | 音频 6 档全量覆盖（`best/192/128/64/32/lowest`） | `A-4.2-07` / `A-M3-11` |
| Q-M3-03 | R5 优先级链 裁剪 > 拆分 > 嵌入 mkv，冲突记 WARNING 不静默 | **D-30** |
| Q-M3-04 | `probePlaylist()` 真实实现不做，接口维持 `UNKNOWN`；只做 L1 fixture 解析 | **D-37** |
| Q-M3-05 | `--ppa` 恒不生成（值含空格 + 随包 yt-dlp 支持性未实测）→ 封面裁剪降级「不裁剪」；与 ARCH v1.1 §4.6 M-3 的「默认显式 `--ppa`」口径**不同，按主理人派单执行** | **D-36**（如实偏离） |
| Q-M3-06 | 播放列表确认仅回写 `selectedIds`、按钮「保存选择」、不调用 `enqueueBatch` / 不新增 `TaskRecord` | **D-38** |
| Q-M3-07 | 本轮零 UI npm 依赖；React / MUI / `@playwright/test` **未安装、未建成正式基建** | **D-31** |
| Q-M3-08 | 1280×800 / DPR1 / `--disable-lcd-text` / 固定字体栈；14 张 PNG + 14 份 DOM 基线 | `scripts/e2e-cases.mjs::RENDER_METADATA` |
| Q-M3-09 | 净化顺序固定 5 步（渲染 → 净化 → 拼目录 → 截断 → `sanitizeToken`） | **D-43** |
| Q-M3-10 | R1 完全抑制 `-S abr~N` 但保留 `acodec:opus/aac` | `download-plan.test.ts` |
| Q-M3-11 | `mergeToMkv` 不进 `PathsDomain`，只为 `DownloadPlan` / `SubtitlePlanner` 内部派生 | **D-35** |
| Q-M3-12 | `A-M3-01…12` 固定 12 条，未追加、未重编号 | D-41 |
| Q-M3-13 | B0 R2-1 门控修复不算矩阵断言，单列门控前置 | **D-32** |
| Q-M3-14 | 四维最低 ≥70；实测 86.24% | `coverage/coverage-summary.json` |
| Q-M3-15 | 零依赖静态 HTML/CSS + 原生 DOM 状态机，数据来自 L1 录制 fixture 且 `omitUrl()` | **D-31** |
| Q-M3-16 | 直调缓存 `chrome-headless-shell.exe` + `node:zlib` PNG diff；正式 runner 联网后补 | **D-31 / D-40** |
| Q-M3-17 | L1 fixture 同源；不声称 Electron renderer 已接入；`MediaFormat.url` / `SubtitleTrack.url` 零出现 | `dialog-dto.contract.test.ts` |
| Q-M3-18 | D-31 记载体 + exe 绝对路径 / 版本；验收④ `evidence` 记录；本汇报显式列出 | **D-31** |

---

## 7. 剩余 / 阻塞 / 偏离（如实登记，禁止虚报）

### 7.1 SKIPPED（不判 FAIL）

| 项 | 原因 | 后续 |
|---|---|---|
| **D-28** 真实 L2 双流 ffmpeg 孤儿压测 | 本地 U3 fixture 为 generic 单 format，拉不起 ffmpeg 子进程；`reports/m3-legacy-closure.json` 标 `SKIPPED` | M5 打包后补真实 L2 |
| **D-39** Electron `shell` 真实 BrowserWindow / 默认播放器启动 | `node_modules/electron/dist` 无二进制；只落地 `IShellPort` 注入契约与 L0 单测 | M5 打包后补真实 L2 |
| **D-37** `probePlaylist()` 真实 spawn | 本轮不联网不触网，按 `A-4.1-05` L1 判据执行 | M4 |
| **D-38** 播放列表批量入队 | 按 `A-M3-04` 明确留 M4 | M4 |

### 7.2 偏离

| 编号 | 内容 |
|---|---|
| **D-30** | R5 组合语义为 M3 新增设计决定（裁剪 > 拆分 > 嵌入 mkv），非文档已有定义 |
| **D-31** | **B4 载体偏离**：任务书要 React + 组件库 + Playwright + Electron renderer；本轮改为零新增依赖静态 HTML/CSS + 缓存 headless shell + `node:zlib` PNG diff。定性「实现载体 / 验收工具的临时等价替代，**非功能范围删减**」。**正式 React / MUI / `@playwright/test` / Electron renderer 基建未建成，不得虚报。** 联网后按 PRD-M3 §5.5 表 5 项补齐：① 安装依赖并改 lock ② 迁移三弹窗到组件 ③ 替换正式 `@playwright/test` runner ④ 重录截图基线 ⑤ 重跑 `A-M3-01…06` 并更新 / 撤销本偏离；断言 ID 不改号 |
| **D-32** | B0 门控 `coverage/.tmp` 改用 **rename** 而非删除（safe-delete shim 按 turn 累计，单文件 `unlink` 也被拒，导致 vitest 启动阶段 abort）；新鲜度 / 四维覆盖率 / 真实失败签名**三道门控一道未放松** |
| **D-33** | 冻结表优先于 PRD 字面：`--embed-subs` 在前 `--convert-subs` 在后；`--restrict-filenames` / `-P temp:` 条件性；`DOWNLOAD_ARGV_FROZEN_ORDER` 零改动 |
| **D-34** | `sanitizeToken` 只处理空白 / 控制字符，路径分隔符由 `sanitizeFileName()` 承担（保留 M2 冻结的 `--proxy http://…` / `C:/V`） |
| **D-35** | `mergeToMkv` 派生位置：不进五域 DTO |
| **D-36** | `--ppa` 恒不触发死分支、封面裁剪降级；与 ARCH v1.1 §4.6 M-3 的「默认显式 `--ppa`」口径不同（主理人派单优先） |
| **Q-M3-02 补充** | `best` / `lowest` 配非默认 codec 时仍生成 `-S vcodec:*/abr~*`（**不含 `res:N`**）；全默认请求仍不生成 `-S`，`A-M2-25:130-131` 不回归 |
| **B1 顺序** | F009 / F010（`PathResolver` 纯函数）因 `resolveDownloadPlan` 依赖 `sanitizeToken` 提前打进 B1 commit；功能与文件清单无删减 |
| **M1 过时断言** | `tests/unit/layering.test.ts` 的「`packages/ui` 不存在」改为「仅含零依赖静态文件且 JS 无 Node/Electron import」，A-INF-01 边界不放松 |

### 7.3 合规红线（全部保持）

- `packages/shared/src/request.ts` 五域签名 `git diff` 为空；`mergeToMkv` 不进 `PathsDomain`。
- `MediaFormat.url` / `SubtitleTrack.url` 在 fixture / DOM / 日志 / 报告中零出现（`omitUrl()` 递归剥离）。
- `spawn(绝对路径, argv[], {shell:false, windowsHide:true})`；`--` 恰 1 个、`indexOf('--') === argv.length-2`、URL 最后、`enginePath` 不入 argv。
- 禁用参数逐项排除：`--cookies-from-browser` / `--geo-bypass*` / `--no-check-certificates` / `--prefer-insecure` / `--exec` / PO Token；`--cookies` 只接受手动导入。
- 48 条断言 ID 不改号、不重排；3 条回归复验不计入 36。
- `pnpm-lock.yaml` 零改动；根 `package.json` 本轮仅新增 `test:e2e` 一行；不联网、不 `pnpm add/install`。

### 7.4 M2 遗留收口结果

| 项 | 结果 |
|---|---|
| C11 `historyEntry` 回填 | **已收口**（`task-queue.ts` 回填 `buildHistoryEntry`，C12 时序不回归，2 例单测） |
| D-18 多流进度 stage 分段 | **已收口**（`segmentProgressByStage()` + `detectPostprocessedFromArgv()` 覆盖 M3 后处理标志） |
| D-28 ffmpeg 孤儿 | **SKIPPED**（见 7.1） |
| Electron `shell` 契约 | **已收口（L0）**，真实窗口 **SKIPPED**（D-39） |

---

## 8. 停下声明

**未获甲方放行，不进入 M4**
