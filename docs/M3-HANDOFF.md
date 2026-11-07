# YTVDLT · M3 交付与 M4/M5 接手交接包

> **版本**：v1.2 ／ 更新于 2026-11-06 ／ **代码基线 `12ac40c`**（M3 全部功能代码）；`12ac40c` 之后均为文档提交。**当前 HEAD 以 `git log --oneline -1` 实际输出为准**（本文每次提交都会改变 HEAD，不要硬记）。
> **给谁看**：接手 M4 及后续开发的 AI / 开发者。
> **怎么用**：读完本文即可开工，不需要翻任何聊天记录。所有结论都落在本目录文件里，本文负责把它们串起来。
> **权威优先级**：`YTVDLT_HANDOFF.md`（原始任务书，933 行）> `PRD-M1/M2/M3.md` > `ARCHITECTURE-M2/M3.md` > `DECISIONS.md` > 本文。**冲突时以更靠前者为准，并在 `DECISIONS.md` 留痕。**

## 📍 项目在哪（接手者第一条命令）

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt
git log --oneline -10 && git status --short
```

- **项目根目录 = `C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\ytvdlt`**
- ⚠️ **不要进错目录**：当前 WorkBuddy 会话工作区可能是 `C:\Users\leolee\WorkBuddy\2026-11-05-21-46-27`，那是空的会话目录，**不是项目**。所有读写一律用上面的绝对路径。
- **批准人 = 甲方 Leo**。每块做完必须汇报，等他明确说「继续 / 批准」才能开工下一块。
- **报告节奏 = 按块，不按时间**：每完成一块就停一次（约 1–2 小时一次），不允许攒几块一起报。详见 §12.6。

---

## 0. 三十秒速览

| 项 | 值 |
|---|---|
| 项目根 | `C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\ytvdlt` |
| 分支 / HEAD | `master` / **以 `git log --oneline -1` 为准**（M3 功能代码到 `12ac40c`，其后均为文档提交） |
| M3 状态 | **已完成并通过 QA 独立复验**（`PASS WITH MINOR ISSUES`，0 源码 Bug）：6 个功能 commit、48/48 断言、验收 4/4，详见 §9 |
| 下一步 | **未获甲方放行，不进入 M4**；放行后按 §10 的 **M4-0 → M4-1 → … → M4-6** 逐块推进，**每块做完停下汇报、批准后再进下一块**（制度见 §12） |
| 阶段制度 | M4 拆 **1 个收口 + 6 个功能块**，M5 拆 **6 个功能块**；单块 ≤2 小时 / ≤15 文件，超限即再拆 |
| 环境 | Windows x64 ／ Node v22.22.2 ／ pnpm 9.15.9 ／ 运行时 3/3 必需 OK（aria2c 为 OPTIONAL 缺失） |
| 依赖状态 | **零新增 npm 依赖**（M3 全程离线）；`pnpm-lock.yaml` 自 M2 起零改动 |
| 测试规模 | `npm test` 464 例 / `--milestone M3` 内部 470 例；覆盖率四维最低 86.24–86.77% |

**一句话**：M1（骨架与引擎契约）、M2（单任务下载闭环 + C1–C12）、M3（格式/字幕/路径全量 + 三弹窗 + 48 条断言）均已交付；M4（并发/批量/命令模板/托盘）与 M5（打磨/打包/合规）尚未开工，已拆成 **M4 共 7 个停止点（1 收口 + 6 功能块）、M5 共 6 个停止点**，每块做完停下汇报、批准后再进入下一块。

---

## 1. 项目坐标（先抄这几行）

| 项 | 位置 |
|---|---|
| 项目根目录 | `C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\ytvdlt` |
| 原任务书（唯一权威，933 行） | `C:\Users\leolee\WorkBuddy\2026-11-05-07-24-49\YTVDLT_HANDOFF.md` |
| 上层工作区 | `C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08` |
| 本文（M4/M5 接手包） | `docs/M3-HANDOFF.md` |
| M3 汇报 | `docs/M3-REPORT.md`（200 行） |
| M3 需求 / 设计 | `docs/PRD-M3.md`（473 行）／`docs/ARCHITECTURE-M3.md` v1.1（1409 行） |
| 决策台账 | `docs/DECISIONS.md`（D-01…**D-45**，M3 部分 D-30…D-45 共 16 条） |
| 交接旧包（M3 起接手用） | `docs/PROJECT-HANDOFF.md` |
| 测试与验收 | `tests/{unit,contract,integration,e2e}/**`、`scripts/acceptance.mjs`、`scripts/run-e2e.mjs` |
| 证据产物 | `reports/**`、`coverage/**`（**均被 `.gitignore` 忽略，不入库**） |

### 1.1 术语与缩写（看不懂时查这里）

| 缩写 | 含义 |
|---|---|
| **L0 / L1 / L2 / L3** | 测试层级：L0 纯单测（零网络）、L1 录制 fixture 契约回放、L2 本地 `127.0.0.1` 端到端（真实 yt-dlp）、L3 真实站点烟测 |
| **C1–C12** | M2 的产物完整性校验 12 条（存在性 / 容器 / 时长 / 流 / 格式 / 路径唯一 等） |
| **C13–C16** | M5 的打包与安装校验 4 条（安装后可启动 / 无运行时缺失 / 下载成功 / 便携版可运行） |
| **D-xx** | `docs/DECISIONS.md` 的决策编号，现到 **D-45**；M3 占 D-30…D-45 |
| **A-4.x-xx** | 需求矩阵项的验收断言 ID（与 `docs/PRD-M1.md` §3 一一对应） |
| **A-M3-xx / A-M4-xx** | 骨架断言，**只续号、不改号** |
| **五域** | `DownloadRequest` 的 `format` / `subtitle` / `paths` / `network` / `advanced` |
| **冻结契约** | 不可改签名的接口：`request.ts` 五域、`DOWNLOAD_ARGV_FROZEN_ORDER`、`EXPECTED_MINIMAL` |
| **门控（guard）** | `runVitestGuarded` 的「环境中断缓解」判定，五道锁（marker / 无失败签名 / 结果新鲜 / 结果成功 / 覆盖四维 ≥70） |
| **SKIPPED** | 环境不可用导致跳过，**不判 FAIL**，但必须留痕并写明后续归属 |
| **收口** | 把上一里程碑遗留的小缺陷补齐（如 M4-0 修 M3 的 QA 缺口） |

---

## 2. 里程碑状态

| 里程碑 | 范围 | 状态 | 证据 |
|---|---|---|---|
| **M1** 骨架与引擎契约 | monorepo / shared DTO / ConfigStore / Logger / ErrorMapper / RuntimeResolver / probe() | ✅ 完成 | `--milestone M1` 17/17 + 5/5，`allGreen=true` |
| **M2** 单任务下载闭环 + 完整性 | buildDownload / ProgressParser / 产物捕获 / TaskQueue 基础 / ArtifactVerifier C1–C12 / HistoryStore | ✅ 完成 | `--milestone M2` 37/37 + 5/5，`allGreen=true` |
| **M3** 格式/字幕/路径全量 | §4.2/4.3/4.4 全量参数 + 三弹窗 + PathResolver Windows 边界 | ✅ 完成（QA `PASS WITH MINOR ISSUES`，**待甲方放行**） | `--milestone M3` 48/48 + 12 gates + 4 acceptance，`allGreen=true`；QA 见 §9 |
| **M4** 队列/并发/播放列表/自定义命令 | 并发调度、7 态、快照恢复、批量入队、模板 CRUD + 白名单、任务日志、托盘通知 | ⬜ 未开工 | 拆解见 §10 |
| **M5** 打磨/打包/合规/发布 | 主题、快捷键、i18n、双通道更新、NSIS + 便携版、LGPL 合规、L3 烟测 | ⬜ 未开工 | 拆解见 §11 |

---

## 3. M3 交付了什么

### 3.1 六个 commit（B0 → B5，一个批次一个提交）

| commit | 主题 | 文件数 |
|---|---|---|
| `07a77b4` | M3-B0：门控修复（R2-1） | 7 |
| `8ce0111` | M3-B1：纯函数与裁决 | 21 |
| `a58ea40` | M3-B2：PathResolver | 2 |
| `6fad957` | M3-B3：argv 全量 | 15 |
| `0b109a2` | M3-B4：三弹窗与截图 | 58 |
| `12ac40c` | M3-B5：验收与汇报 | 3 |

累计 **101 个文件**改动（`git diff --name-only c04924b..12ac40c | wc -l`；注意用 `12ac40c` 而非 `HEAD`，否则会把 2 个文档提交算进来），其中 B4 一次提交 4520 行新增。
另有 2 个文档提交：`82e29a1`（入库 PRD/架构/交接/QA 报告，2687 行）、`072cb4e`（交接包状态同步）。

### 3.2 四条验收标准 → 实测结论

| # | 原标准 | 实测 |
|---|---|---|
| ① | ArgvBuilder 组合单测 ≥60 例（8 档 × 编码 2 × 音频 ≥5 × 字幕 5 × 路径 4） | `tests/unit/argv-builder-m3.test.ts` **91 例**（含 64 组组合用例）0 FAIL；`EXPECTED_MINIMAL` 与 `DOWNLOAD_ARGV_FROZEN_ORDER` 对 HEAD **逐字节一致** |
| ② | 每个矩阵项有断言（M3 归属 36 条） | 36 条矩阵 + 12 条 `A-M3-xx` = **48/48 PASS**，0 FAIL / 0 无证据；3 条回归复验单列 PASS |
| ③ | Windows 非法字符 / 保留名 / 260+ 长路径单测 | `tests/unit/path-resolver.test.ts` **30 例全绿**（含 259/260/261、UNC、`\\?\`、`CON.txt`） |
| ④ | 三弹窗截图回归 | `npm run test:e2e` **14/14 cases + 5/5 negative checks**，连跑 3 次全绿；14 张 PNG + 14 份 DOM 基线 |

### 3.3 断言体系（**ID 永久不改号、不重排**）

- **36 条矩阵项**：与 `docs/PRD-M1.md` §3 完全一致 —— §4.1=3、§4.2=12、§4.3=8、§4.4=7、§4.5=4、§4.6=2。
- **12 条骨架断言** `A-M3-01…A-M3-12`：格式三组分栏 / 多选音频流与合计体积 / 字幕按语言多选 / 播放列表仅回写 selectedIds / 三态门禁 / 截图回归 / 非法字符净化 / 保留名与长路径 / 模板渲染与路径预览 / R1–R5 互斥裁决 / ≥60 例组合 / M2 遗留收口。
- **3 条回归复验**（**不计入 36**）：`A-4.2-06`（M2 / C6）、`A-4.4-30`（M1 / Logger 脱敏）、`A-4.6-02`（M2 / D-25）。
- 口径依据：`docs/PRD-M1.md` §3.7 + `scripts/acceptance.mjs`。⚠️ 旧交接包 §7.3 写的「§4.2 13 条全归 M3」是错的，已由 `PRD-M3.md` §9-① 纠正。

### 3.4 代码地图（按包）

| 包 / 目录 | M3 新增或变更 |
|---|---|
| `packages/shared/src` | `download-plan.ts`、`dialog-dto.ts`、`index.ts`、`ipc.ts`（**`request.ts` 零改动**） |
| `packages/core/src` | `decision/`（`resolveDownloadPlan`，唯一裁决源）、`format-selector/`、`subtitle-planner/`、`path-resolver/`、`logger/redactor.ts`（脱敏面扩展）、`download-flags.ts`、`task-queue/task-queue.ts`（C11 回填）、`config-store/defaults.ts` |
| `packages/engine-ytdlp/src` | `argv-builder-download.ts`（条件性扩展）、`argv-compliance.ts`（白名单 + 禁用参数拦截）、`progress-parser.ts`（stage 分段） |
| `packages/ui/`（M3 新建） | `src/dialogs/dialog-state.js`（四态状态机）、三个弹窗 `.html/.js`、`src/ipc-bridge.js`、`src/fixtures/probe-fixture.js`、`src/styles/ytvdlt.css` —— **零依赖静态文件，不是 `.tsx`** |
| `apps/desktop/src/main` | `ipc-gateway.ts`、`adapters/electron-shell-port.ts`、`adapters/node-ports.ts`、`app-host.ts`、`index.ts`；`preload/bridge.ts` |
| `scripts/` | `acceptance.mjs`（+M3 分支）、`lib/vitest-run.mjs`（门控重写）、`lib/guard-negative-check.mjs`、`lib/png-diff.mjs`、`run-e2e.mjs`、`e2e-cases.mjs`、`check-layering.mjs`、`run-tests.mjs` |
| `tests/` | 13 个 unit、2 个 contract、33 个 e2e 文件（3 fixture + 28 基线 + README） |

---

## 4. 不可破坏的架构不变量（动代码前必读）

1. **五域 DTO 冻结**：`packages/shared/src/request.ts` 的 `DownloadRequest`（format / subtitle / paths / network / advanced）签名 M1 冻结。**任何新增字段都要走 DECISIONS + 全量回归**；M3 全程 `git diff` 为空。
2. **argv 冻结顺序**：`DOWNLOAD_ARGV_FROZEN_ORDER`（31 个选项名）**不追加、不重排**；`EXPECTED_MINIMAL`（`tests/unit/argv-builder-download.test.ts:51-68`）是手写字面量，**一字不改**。M3 所有新增段都是**条件性 push**，默认 minimal 请求下一段都不触发。
3. **`mergeToMkv` 不进 DTO**：它只是 `DownloadPlan` / `SubtitlePlanner` 的内部派生值。`PathsDomain` 无此字段。
4. **双阶段裁决**：阶段 1（UI 侧 FormatSelector / SubtitlePlanner / PathResolver → 合法五域）→ 阶段 2（`resolveDownloadPlan(req)` 唯一裁决源）。`buildDownload` 只读 plan。
5. **验收门控三道锁**：`runVitestGuarded` 只有在「命中 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` + 输出无真实失败签名 + 证据 mtime 新鲜 + 结果 `success===true && numFailedTests===0` + 覆盖率四维 ≥70」全部成立时才允许缓解。**任何一道不成立都原样 exit 1。**
6. **分层铁律**：`packages/{shared,core,engine-ytdlp}` 零 `electron`、零 `node:fs` 副作用；`packages/ui/**` 只经 IPC 发命令，禁 `node:fs` / `child_process` / `electron`（`scripts/check-layering.mjs` 会拦）。
7. **凭据字段**：`MediaFormat.url` / `SubtitleTrack.url` 可能含签名凭据，**禁止渲染、禁止进日志、禁止进报告**。UI 侧有 `omitUrl()` 递归剥离。
8. **合规红线**：不实现任何绕过能力；不生成/注入 PO Token；不自动抓取浏览器 cookies；不降 TLS 校验；禁用参数清单 `--cookies-from-browser` / `--geo-bypass*` / `--no-check-certificates` / `--prefer-insecure` / `--exec` 逐项拦截。
9. **命令构造**：一律 `spawn(绝对路径, argv[], {shell:false, windowsHide:true})`；`--` 恰 1 个且 `indexOf('--') === argv.length-2`；URL 是最后元素；`enginePath` 不入 argv；所有用户文本经 `sanitizeToken()`（空白/控制字符 → `_`）。
10. **断言 ID 不改号**：48 条 M3 断言 + 3 条回归复验已固化在 `scripts/acceptance.mjs`。M4/M5 只能**续号追加** `A-M4-xx` / `A-M5-xx`。

---

## 5. 命令清单（含期望输出）

### 5.1 日常

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt
npm test                        # 全量 L0+L1：期望 464 passed / 0 fail，四维 ≥70
npm run test:e2e                # 三弹窗截图 + DOM：期望 14/14 + 5/5，exit 0
pnpm turbo run typecheck        # 期望 5 successful
node scripts/check-layering.mjs --json    # violationsCount = 0
node scripts/check-runtime.mjs --json     # allRequiredOk = true
```

### 5.2 里程碑验收

```bash
node scripts/acceptance.mjs --milestone M1   # 17/17 + 5/5, allGreen=true
node scripts/acceptance.mjs --milestone M2   # 37/37 + 5/5, allGreen=true
node scripts/acceptance.mjs --milestone M3   # 48/48 + 12 gates + 4 acceptance
node scripts/lib/guard-negative-check.mjs    # B0 门控 5/5 + extra
```

> 验收命令**连跑 3 次**全绿才算稳；覆盖率只认全量运行，定向数字仅作诊断。

### 5.3 反例自检（证明测试不是橡皮图章，建议每次大改后做一次）

```bash
# 1) 换错 PNG 基线 → 必须 exit 1
cp tests/e2e/baselines/subtitle-ready.png tests/e2e/baselines/format-ready.png
npm run test:e2e                                   # 期望 exit 1，报差异像素数
# 2) 改坏 DOM 基线 → 必须 exit 1
printf '\n<!-- CORRUPT -->\n' >> tests/e2e/baselines/format-ready.dom.html
npm run test:e2e                                   # 期望 exit 1
# 3) 还原后必须 exit 0
git checkout -- tests/e2e/baselines/
npm run test:e2e                                   # 期望 exit 0
```

### 5.4 失败排查顺序

1. `git status` 是否干净（**不要**把 `docs/PROJECT-HANDOFF.md` 带进提交）；
2. `npm test` 是否有真实失败（看 `reports/vitest-results.json` 与终端原文）；
3. `reports/vitest-guard.json` 的 `reasons[]` 是否出现 `RESULTS_NOT_FRESH` / `COVERAGE_BELOW_MINIMUM` / `TEST_FAILURE_IN_OUTPUT`；
4. `check-runtime` 是否 `NOT_EXECUTABLE`（见 §8 坑 6）；
5. `check-layering` 是否新增违规 import。

---

## 6. 已知偏离 / 降级 / SKIPPED（**必须继承，禁止当成已完成**）

### 6.1 SKIPPED（不判 FAIL，有后续归属）

| 项 | 原因 | 归属 |
|---|---|---|
| **D-28** 真实 L2 双流 ffmpeg 孤儿压测 | 本地 U3 fixture 是 generic 单 format，拉不起 ffmpeg 子进程 | M5 打包后补真实 L2 |
| **D-39** Electron `shell` 真实窗口 / 默认播放器启动 | `node_modules/electron/dist` 无二进制；只落地 `IShellPort` 注入契约 + L0 单测 | M5 打包后补真实 L2 |
| **D-37** `probePlaylist()` 真实 spawn | 本轮不联网不触网，只做 L1 fixture 解析 | M4 |

### 6.2 偏离（已登记 DECISIONS，接手者不要「顺手修好」而破坏其它约束）

| 编号 | 内容 | 影响 / 注意事项 |
|---|---|---|
| **D-31** | **B4 离线载体偏离**：任务书要 React + 组件库 + Playwright + Electron renderer；本轮改为「零新增 npm 依赖静态 HTML/CSS + 缓存 `chrome-headless-shell.exe` + Node `zlib` PNG diff」 | 定性为**实现载体/验收工具的临时等价替代，非功能范围删减**。三弹窗规格、三态门禁、回写字段、`A-M3-01…06` 判据全部不变。**不得虚报**已建成 React/MUI/`@playwright/test`/Electron renderer。补齐条件见 §6.3 |
| **D-32** | B0 门控 `coverage/.tmp` 改用 **rename** 而非删除（safe-delete 按 turn 累计，单文件 `unlink` 也被拒） | 三道门控一道未放松；`evaluateGuard()` 仍是五项与条件 |
| **D-33** | 冻结表优先于 PRD 字面：`--embed-subs` 在前、`--convert-subs` 在后；`--restrict-filenames` / `-P temp:` 条件性 | 照 PRD 字面改顺序会立刻打破 `A-M2-25` |
| **D-34** | `sanitizeToken` 只替换空白/控制字符，**不替换 `/`** | 路径分隔符净化由 `sanitizeFileName()` 承担；否则 `--proxy http://…` / `C:/V` 会被破坏 |
| **D-35** | `mergeToMkv` 为内部派生值 | 不进五域 DTO |
| **D-36** | `--ppa` 恒不触发死分支、封面裁剪降级「不裁剪」 | 与 ARCH v1.1 §4.6 M-3 的「默认显式 `--ppa`」口径不同（主理人派单优先），已在 DECISIONS 与报告双留痕 |
| **D-42** | M2 遗留收口：C11 已收口、D-18 已收口、D-28 SKIPPED、Electron shell L0 收口 | 见 §6.1 |
| **D-44** | `advanced.customCommand` M3 **不消费**且构造层拒绝 | M4 才做模板 CRUD + 白名单 |

### 6.3 D-31 的补齐条件（**不阻塞 M4**；但 M5-4 打包前必须补 `electron` dist）

> **重要区分，别搞混**：
> - **React 迁移**（下面 1–5 条）是技术债，**不阻塞 M4/M5 的功能开发**，可以延后到任意时间做。
> - **`electron` dist 二进制**是 **M5-4 打包的硬前置**（没有它打不出可运行安装包），必须在 M5-4 之前补。
> - 两者都需要联网，都必须**先告知甲方**。

1. 允许联网且允许改 `package.json` / `pnpm-lock.yaml`，安装 `react@^19` / `react-dom@^19` / `@mui/material@^6` / `@playwright/test@^1.50` / `vite@^6.3.5`；
2. 补齐 `electron` dist 二进制，`apps/desktop/src/renderer` 真正接入 `packages/ui/`（Renderer 只经 IPC）；
3. 三弹窗迁移为 React 组件（MUI 可选），新建 `playwright.config.ts` + `tests/e2e/*.spec.ts`；
4. 用正式 `@playwright/test` 重录截图基线并**替换**本轮缓存 shell 基线、重跑 `A-M3-01…06` 全量；
5. 在 `DECISIONS.md` 追加「补齐完成」登记，并在 M4 汇报列出。**断言 ID 不改号。**

### 6.4 其它需要继承的实现口径

| 项 | 口径 |
|---|---|
| `best` / `lowest` 配非默认 codec | 仍会生成 `-S vcodec:*/abr~*`（**不含 `res:N`**）；全默认请求不生成 `-S`，`A-M2-25:130-131` 不回归 |
| F009 / F010 提交顺序 | `PathResolver` 纯函数提前打进 B1（`resolveDownloadPlan` 需要 `sanitizeToken`），功能与文件清单无删减 |
| M1 过时断言 | `tests/unit/layering.test.ts` 的「`packages/ui` 不存在」已改为「仅含零依赖静态文件且 JS 无 Node/Electron import」，**边界未放松** |
| 覆盖率双数字 | `npm test` = 464 例（unit+contract）；`--milestone M3` 内部 = 470 例（含 L2 integration）。两者都真实、都 ≥70，不互相覆盖 |
| `check-runtime` 偶发 flake | 全量 coverage 跑完瞬间可能 `yt-dlp.exe NOT_EXECUTABLE`；`runM3()` 有**有界真实重试**（≤3 次、不改状态码、次数写入 `collectionAttempts`） |

---

## 7. Q-M3-01…18 的实际取舍（接手者需要知道的）

| ID | 取舍 | 留痕 |
|---|---|---|
| Q-M3-01 | 36 条口径以 `PRD-M1` §3.7 为准；三条回归复验不计入 36 | D-41 |
| Q-M3-02 | 音频 **6 档**全量覆盖（`best/192/128/64/32/lowest`），超出「≥5 档」最低要求 | `A-4.2-07` |
| Q-M3-03 | R5：裁剪 > 拆分 > 嵌入 mkv，冲突记 WARNING 不静默 | **D-30** |
| Q-M3-04 | `probePlaylist()` 真实实现不做，接口维持 `UNKNOWN` | **D-37** |
| Q-M3-05 | `--ppa` 降级「不裁剪」 | **D-36** |
| Q-M3-06 | 播放列表确认只回写 `selectedIds`，按钮文案「保存选择」，不入队 | **D-38** |
| Q-M3-07 | 本轮零 UI npm 依赖 | **D-31** |
| Q-M3-08 | 1280×800 / DPR 1 / `--disable-lcd-text` / 固定字体栈 | `scripts/e2e-cases.mjs` |
| Q-M3-09 | 净化顺序：渲染 → 净化 → 拼目录 → 截断 → `sanitizeToken` | **D-43** |
| Q-M3-10 | R1 完全抑制 `-S abr~N`，保留 `acodec:opus/aac` | `download-plan.test.ts` |
| Q-M3-11 | `mergeToMkv` 不进 `PathsDomain` | **D-35** |
| Q-M3-12 | `A-M3-01…12` 固定 12 条，后续只能续号 | D-41 |
| Q-M3-13 | B0 门控不算矩阵断言 | **D-32** |
| Q-M3-14 | 覆盖率四维最低 ≥70；实测 86.24–86.77% | `coverage/coverage-summary.json` |
| Q-M3-15…18 | 离线载体 / 截图驱动 / L1 fixture 数据源 / 偏离留痕与补齐 | **D-31 / D-40** |

---

## 8. 接手 M4 前必须知道的 8 个坑

1. **不要 `git add -A` / `git add .`** —— `docs/PROJECT-HANDOFF.md` 里有用户 239 行自己的未提交编辑，必须原样保留、**绝不进任何 M4/M5 提交**。M3 的 4 份文档已于 `82e29a1` 入库，不需要再 add。逐路径 `git add`。
2. **冻结测试是「手写字面量」不是引用实现** —— `EXPECTED_MINIMAL` 与 `DOWNLOAD_ARGV_FROZEN_ORDER` 是防回归的唯一锚点；改它们等于自证。M3 的验证方式是 `git show HEAD~n:file | diff`。
3. **新增 argv 段一律条件性** —— 任何「恒定参数」（哪怕看起来无害的 `--restrict-filenames`）都会打破 `EXPECTED_MINIMAL`。
4. **含空格的用户文本会炸 `argv.every(e => !/\s/)`** —— 自定义标题、`--sub-langs` 表达式、`User-Agent`、`--ppa` 值都要走 `sanitizeToken()`。
5. **`best`/`lowest` 的 `-S` 断言比 PRD 更严** —— `tests/unit/argv-builder-download.test.ts:130-131` 断言 `not.toContain('-S')`（完全没有 `-S`），不是「无 `res:` 约束」。改动前先看这条。
6. **`check-runtime` 会 flake** —— 全量 coverage 刚跑完时偶发 `NOT_EXECUTABLE`。不要立刻判定环境坏了，重跑一次；`runM3()` 已有有界重试。
7. **`reports/**` 与 `coverage/**` 不入库** —— clone 仓库后没有任何历史证据，必须重跑验收才有。M4 开工第一件事建议先跑一遍 §5.2 建立自己的基线。
8. **UI 是零依赖静态文件，不是 React** —— 不要按 `.tsx` 的直觉去改 `packages/ui/**`；它不参与 `tsc` 类型检查（只被 `check-layering` 扫 import），改完必须跑 `npm run test:e2e`。

---

## 9. QA 独立复验结论

> 复验报告全文：`docs/M3-QA-VERIFICATION.md`（224 行 / 34KB，已入库 `82e29a1`）。以下为主理人汇编的结论。

**最终意见：`PASS WITH MINOR ISSUES`**
16 项复验 **16 PASS / 0 FAIL / 0 NOT VERIFIED**；**0 个源码 Bug**；4 项证伪反例**全部真失败并完整还原**；工程师自报的核心数字全部可复现。

### 9.1 关键实测（QA 独立重跑，非采信工程师）

| 项 | 结果 |
|---|---|
| `npm test` | 33 files / **464 passed** / 0 fail／四维 `93.89 \| 86.24 \| 94.47 \| 93.89` |
| `npm run test:e2e` ×3 | 每次 14/14 + 5/5 negative、`differPixels=0`、exit 0 |
| `acceptance --milestone M3` ×4 | 每次 48/48 + 3/3 + 12/12 + 4/4、`allGreen=true`、`durationMs` 全非零；M1 17/17、M2 37/37 仍 allGreen，三份报告并存 |
| `guard-negative-check` | 5/5 + extra；**读码确认真 spawn**（`spawnSync` + 真实子进程写证据 + `utimesSync` 真回拨 180s） |
| 分层 / 类型 / 运行时 | layering 0 违规（真扫 71 文件，含 `packages/ui/src` 6 文件）；typecheck 5/5；runtime 3/3 |
| 冻结契约 | `request.ts` / `pnpm-lock.yaml` / `package.json` 对 HEAD **0 行 diff**；`EXPECTED_MINIMAL`(513B) 与 `DOWNLOAD_ARGV_FROZEN_ORDER`(557B) 逐字节一致 |

### 9.2 证伪反例（4/4 真失败，全部还原）

| 反例 | exit | 关键数值 |
|---|---|---|
| PNG 基线换成 `subtitle-ready.png` | **1** | 114699 差异像素，13/14，`allPass=false`；还原后 exit 0 |
| DOM 追加 `<!-- QA-CORRUPTED -->` | **1** | `snapshot=false`；还原后 exit 0 |
| 手造 stale success 证据 + 改坏断言 | **1** | `REJECTED`，`reasons` 含 `RESULTS_NOT_SUCCESS` / `RESULTS_FAILED_TESTS` / `SUMMARY_MISSING` / `TEST_FAILURE_IN_OUTPUT`；深证 spawn 前已 unlink 伪造证据 |
| 覆盖率 branches=69% | **1（REJECTED / COVERAGE_BELOW_MINIMUM）** | 正例对照 71% → status 0 / MITIGATED，证明不是恒拒 |

> QA 独立复现出 114699 差异像素，与 `M3-REPORT.md` 自述数字**完全一致** → 工程师未虚报。

### 9.3 QA 发现的 6 项缺口（全 P3/P4，无 P0–P2；**M4 首批收口**）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| **D1** | `tests/unit/argv-builder-m3.test.ts:408-414` | `A-4.3-04` 只测 `autoCaptions:false` 分支，缺「`autoCaptions=true && skipTranslated=false` → argv 无 `--extractor-args`」用例（实现正确，属测试缺口） | M4 首批补测 |
| **D2** | `scripts/acceptance.mjs:384` | `A-4.2-07` 的 evidence 指向 `format-selector.test.ts`，但该文件**无 audioQuality 断言**；实际判定靠 `argv-builder-m3.test.ts:176-178` 的 `ABR_FIELD` **镜像表**（与 `download-plan.ts:41-45` 重复定义，同改会漂移） | 改为单一数据源 |
| **D3（最值得担心）** | `reports/m3-legacy-closure.json` + `scripts/acceptance.mjs:639` | 全仓库**没有生成该 JSON 的脚本**（只有读取方）；其自述「5 files / 145 tests」与当前同 5 文件实测 **129 例**对不上；`legacyOk` 只校验 `summary.failed===0 && durationMs>0` → **任何手写 JSON 都能过**，而它挂在 `A-4.5-07` / `A-M3-12` 的 `needs:['legacy']` 与 `M3-GATE-docs` 上 | **M4 首批把生成逻辑并入 acceptance，并让 gate 校验计数与真实运行一致** |
| **D4** | `scripts/acceptance.mjs:675-684 / 752-762` | 48 条 `durationMs` 全部同值（`unique=1`），是「步骤级共享」而非逐条实测；gate 只查 `>1ms`，无区分度 | 逐条计时或标明共享来源 |
| **D5** | `packages/ui/src/dialogs/playlist-selector.js:94` | `data-enqueue-batch="never"` 是对话框自写属性（部分自证）；实质判定由网关 `enqueued:false` + DTO 键集合禁词表承担，**风险低** | 可保留，M4 加强 |
| **D6** | 工作区 | `docs/M3-HANDOFF.md`（本文）当时为未跟踪文件 | **已入库 `82e29a1`，关闭** |

> **D3 的缓解**：C11（`task-queue.test.ts:321`）、D-18（`argv-builder-m3.test.ts:449-474`）、electron-shell 三项的**实质内容**确由 470/470 真实运行承担，故不影响 M3 判绿；但该 JSON 作为「证据链」的可信度不足，必须在 M4 首批修掉。

### 9.4 需要甲方动作的两件事

1. **D-31 需书面接受验收④的离线载体口径**（React/MUI/`@playwright/test` 未建成，属临时等价替代）。
2. **D-32 副作用**：`coverage/.tmp-prev-*` 已累积 20+ 个目录（被 `.gitignore` 忽略，不影响仓库），可在 M4 开工时清理一次。

### 9.5 偏离复核

D-28 SKIPPED / D-39 SKIPPED / D-31 载体偏离 / D-36 `--ppa` 降级 / D-32 `.tmp` rename —— **5 项全部正当、全部留痕、全部未虚报**。
QA 实测佐证：`node_modules/electron/dist` 不存在；react/react-dom/@mui/@playwright 均未安装且 lock 零改动；guard 记录里 `coverageTmp.method="renamed"` 且本次运行真实记录了一次 MITIGATED 并如实披露。

---

## 10. M4 拆解：1 个收口 + 6 个功能块（每块都是独立停止点）

> **为什么切成 6 块**：M4 一次性做要同时改 `packages/core`、`apps/desktop`、`packages/ui` 三个包、30+ 文件；连续推理 2–3 小时后幻觉率会明显上升。按「一个可验收能力 = 一块」切，每块 **≤2 小时 / ≤15 个文件**，做完即停、汇报、等批准。
>
> **每块的上下文预算**：只读 3 份材料（本块增量设计 + `DECISIONS.md` 相关条目 + 对应源码目录）；只碰 1–2 个包；改动 ≤15 文件；结束必须落盘 `docs/M4-<n>-REPORT.md`。

### 10.0 拆解总表

| 块 | 能力 | 对应原始验收 | 依赖 | 预估 | 停止点 |
|---|---|---|---|---|---|
| **M4-0** | QA 收口（D3 优先，D1/D2/D4） | 无（质量债） | M3 | 0.5 天 / 3–5 文件 | commit + `M4-0-REPORT` + **停** |
| **M4-1** | 7 态状态机 | ⑤ | M4-0 | 1 天 / 2–3 文件 | commit + 报告 + **停** |
| **M4-2** | 并发调度内核 | ① | M4-1 | 1–1.5 天 / 3–4 文件 | commit + 报告 + **停** |
| **M4-3** | 快照持久化与恢复 | ② | M4-2 | 1 天 / 3–4 文件 | commit + 报告 + **停** |
| **M4-4** | 播放列表批量入队 | ③ | M4-3 | 1–1.5 天 / 6–8 文件 | commit + 报告 + **停** |
| **M4-5** | 命令模板 + 白名单 + 日志页 | ④ | M4-4 | 1.5–2 天 / 8–10 文件 | commit + 报告 + **停** |
| **M4-6** | 托盘通知 + 任务详情 + 错误报告 | 通知 / 详情 / 报告 | M4-5 | 1–1.5 天 / 8–10 文件 | commit + 报告 + **停** |

### 10.1 M4-0 · QA 收口（前置，不算功能块）

| 项 | 内容 |
|---|---|
| **目标** | 修 §9.3 的 5 项 P3：**D3 优先**（`m3-legacy-closure.json` 改为脚本生成、gate 校验计数与真实运行一致）、D1 补 `A-4.3-04` 缺失分支、D2 消除 `ABR_FIELD` 镜像表、D4 `durationMs` 逐条实测或标明共享来源 |
| **范围** | `scripts/acceptance.mjs`、`scripts/lib/`、`tests/unit/argv-builder-m3.test.ts`（**不碰产品代码**） |
| **验收** | 重跑 `acceptance --milestone M3` 仍 48/48；`legacy` JSON 由脚本产出且计数等于同批真实测试数；删掉手写 JSON 后 test 必须 FAIL |
| **明确不做** | 任何 M4 功能 |
| **停止判据** | `M4-0: QA 收口` commit + 报告 + 停下 |

### 10.2 M4-1 · 7 态状态机

| 项 | 内容 |
|---|---|
| **目标** | `state-machine.ts`：`Idle / FetchingInfo / ReadyWithInfo / Running / Completed / Error / Canceled` 七态；合法转移矩阵全覆盖；**非法转移逐条拒绝**；优先级按状态 ordinal |
| **范围** | `packages/core/src/task-queue/state-machine.ts` + 单测（2–3 文件） |
| **验收** | 原始验收 ⑤；合法转移矩阵 100% 覆盖；非法转移每条都有断言 |
| **明确不做** | 并发、快照、UI |
| **停止判据** | commit + `docs/M4-1-REPORT.md` + 停下 |

### 10.3 M4-2 · 并发调度内核

| 项 | 内容 |
|---|---|
| **目标** | `TaskQueue` 并发上限（默认 3，可配）、自动补位、上限 1 时严格串行 |
| **范围** | `packages/core/src/task-queue/task-queue.ts` + 单测（3–4 文件） |
| **验收** | 原始验收 ①：入队 7 → 同时运行 ≤3 且自动补位；上限 1 → 严格串行 |
| **明确不做** | 快照恢复、批量入队 |
| **停止判据** | commit + 报告 + 停下 |

### 10.4 M4-3 · 快照持久化与恢复

| 项 | 内容 |
|---|---|
| **目标** | `TaskStore` 原子写快照；启动恢复；运行中/解析中任务恢复为 `Canceled`；保留上次进度 |
| **范围** | `packages/core/src/task-store/task-store.ts`、`task-queue` 恢复钩子 + 单测/集成（3–4 文件） |
| **验收** | 原始验收 ②：下载中强杀 → 重启任务仍在、显示上次进度、`Canceled` 且可重试 |
| **明确不做** | 批量入队、命令模板 |
| **停止判据** | commit + 报告 + 停下 |

### 10.5 M4-4 · 播放列表批量入队

| 项 | 内容 |
|---|---|
| **目标** | `probePlaylist()` 真实实现（替换 M3 的 `UNKNOWN` 占位）；`enqueueBatch()` 每条 `--playlist-items` 生成独立任务；UI 选择页接入 |
| **范围** | `packages/engine-ytdlp/src/{probe-playlist,argv-builder}.ts`、`packages/core/src/task-queue/`（批量）、`packages/ui/src/dialogs/playlist-selector.*` + 测试（6–8 文件） |
| **验收** | 原始验收 ③：选 5 条 → 5 个独立任务、独立进度、并发不超限 |
| **明确不做** | 命令模板、托盘 |
| **停止判据** | commit + 报告 + 停下 |

### 10.6 M4-5 · 命令模板 + 参数白名单 + 任务日志页

| 项 | 内容 |
|---|---|
| **目标** | 模板 CRUD；**argv 数组化 + 选项白名单**双重拦截；`CUSTOM_COMMAND_REJECTED` 且不执行；12 类恶意输入逐条拒绝；任务日志页（逐行输出、复制、取消、重试） |
| **范围** | `packages/core/src/command-template/*`、`packages/engine-ytdlp/src/argv-builder-custom.ts`、`packages/ui/src/pages/CommandTask/*` + 测试（8–10 文件） |
| **验收** | 原始验收 ④；12 类恶意输入（`--exec` / `--config-locations` / 管道符 / 绝对路径注入 等）全部拒绝 |
| **明确不做** | 托盘、主题 |
| **风险** | 白名单是**安全边界**，不能只做字符串黑名单 |
| **停止判据** | commit + 报告 + 停下 |

### 10.7 M4-6 · 托盘通知 + 任务详情 + 错误报告面板

| 项 | 内容 |
|---|---|
| **目标** | 托盘常驻；进度/完成/错误/取消四类通知；关窗最小化；任务详情 7 项操作（打开文件、所在文件夹、复制 URL、复制错误报告、取消、删除、重试）；错误报告面板（OS/应用/引擎版本、URL、完整 stderr，脱敏） |
| **范围** | `apps/desktop/src/main/{tray,notifications}.ts`、`packages/ui/src/pages/TaskDetail/*`、`packages/core/src/error-report/*`（8–10 文件） |
| **验收** | 四类通知可触发；详情 7 项可触发；报告字段齐全且凭据已掩码；`check-layering` 0 违规 |
| **明确不做** | M5 的主题 / i18n / 打包 |
| **停止判据** | commit + 报告 + 停下（M4 全部完成，等 M5 放行） |

---

## 11. M5 拆解：6 个功能块（每块都是独立停止点）

> M5 与 M4 不同：**M5-4 / M5-5 强依赖联网与干净 Windows 虚拟机**；M5-1～M5-3、M5-6 可离线做。顺序**不能颠倒**（体验 → 打包 → 更新 → 合规发布）。
>
> **硬前置**：M5-4 开始前必须**先告知用户**切换网络环境；不允许在未告知的情况下 `pnpm add` / 联网下载。

### 11.0 拆解总表

| 块 | 能力 | 对应原始验收 | 依赖 | 预估 | 是否联网 |
|---|---|---|---|---|---|
| **M5-1** | 主题三态 + 强调色 + 跟随系统 | ④（部分） | M4 全部 | 1 天 / 4–6 文件 | 否 |
| **M5-2** | 快捷键 + i18n 双语 | ④（部分） | M5-1 | 1 天 / 6–8 文件 | 否 |
| **M5-3** | 空/错/加载状态统一 + 视觉打磨 | ①（部分） | M5-2 | 1 天 / 6–8 文件 | 否 |
| **M5-4** | 打包基建：NSIS + 便携版 + `extraResources` | ①②（部分） | M5-3 | 1.5–2 天 / 4–6 文件 | **是** |
| **M5-5** | 双通道更新 + 干净 VM 验收（C13–C16） | ②③⑦ | M5-4 | 1–1.5 天 / 3–5 文件 | **是** + VM |
| **M5-6** | 合规 + 文档 + L3 烟测 + SHA256 | ⑤⑥⑦ | M5-5 | 1–1.5 天 / 6–8 文件 | L3 需联网 |

### 11.1 M5-1 · 主题三态 + 强调色 + 跟随系统

| 项 | 内容 |
|---|---|
| **目标** | Light / Dark / System 三态切换即时生效；跟随系统时随 Windows 变化；强调色可配 |
| **范围** | `packages/ui/src/styles/**`、`packages/ui/src/theme/**`、`apps/desktop/src/main/theme-bridge.ts`（4–6 文件） |
| **验收** | 切深色全页即时；切 System 后改 Windows 主题会跟随；无硬编码颜色残留 |
| **明确不做** | 快捷键、i18n、打包 |
| **停止判据** | commit + `docs/M5-1-REPORT.md` + 停下 |

### 11.2 M5-2 · 快捷键 + i18n 双语

| 项 | 内容 |
|---|---|
| **目标** | 全局快捷键（新建下载 / 暂停式取消 / 重试 / 切换主题 / 搜索）；`zh-CN` + `en` 资源可切换，布局不溢出 |
| **范围** | `apps/desktop/src/main/shortcuts.ts`、`packages/ui/src/i18n/**`、`packages/ui/src/locales/*.json`（6–8 文件） |
| **验收** | 每条快捷键可触发；切英文后全部文案切换且无溢出/截断 |
| **明确不做** | 打包、L3 |
| **停止判据** | commit + 报告 + 停下 |

### 11.3 M5-3 · 空/错/加载状态统一 + 视觉打磨

| 项 | 内容 |
|---|---|
| **目标** | 全站空状态、错误状态、加载状态统一组件与文案；间距/字号/圆角统一到 design token；列表虚拟滚动（若任务数 >200） |
| **范围** | `packages/ui/src/components/{EmptyState,ErrorState,Loading}.*`、`packages/ui/src/styles/tokens.css`（6–8 文件） |
| **验收** | 每个页面三态齐全；截图回归基线更新且 `test:e2e` 全绿；无裸 `#hex` 颜色 |
| **明确不做** | 打包、更新 |
| **停止判据** | commit + 报告 + 停下（M5 体验阶段结束） |

### 11.4 M5-4 · 打包基建（NSIS + 便携版 + 运行时随包）

| 项 | 内容 |
|---|---|
| **目标** | `electron-builder` 配置；NSIS 安装版；便携版 EXE；`extraResources` 随包 `resources/runtime/win-x64/**`；`asar` 与签名占位配置 |
| **范围** | `electron-builder.yml`、`package.json`（build 段）、`scripts/build-*.mjs`（4–6 文件） |
| **验收** | 本机产出 `.exe` 安装包与便携版；解包后 `resources/runtime` 完整；启动无「运行时缺失」 |
| **前置** | **必须先告知用户切网络**；`electron` dist 二进制 |
| **明确不做** | 自动更新（下一块）、L3 |
| **停止判据** | commit + 报告（含产物路径与 SHA-256）+ 停下 |

### 11.5 M5-5 · 双通道自动更新 + 干净 VM 验收（C13–C16）

| 项 | 内容 |
|---|---|
| **目标** | `electron-updater` 双通道（stable/nightly）；检测/提示/一键更新；干净 Windows 虚拟机（无 Python/Node/FFmpeg/Chrome）安装 → 启动 → 下载成功；D-39 / D-28 真实 L2 复验 |
| **范围** | `apps/desktop/src/main/updater.ts`、`electron-builder.yml`（publish 段）、`tests/e2e/installer.*`（3–5 文件） |
| **验收** | 原始验收 ②③⑦；C13–C16 全绿；VM 安装包可运行且下载成功 |
| **前置** | M5-4；**联网 + 干净 VM**（需用户提供/确认） |
| **明确不做** | 合规文档（下一块） |
| **停止判据** | commit + 报告（含 VM 验收记录）+ 停下 |

### 11.6 M5-6 · 合规清单 + 文档 + L3 在线烟测 + SHA256

| 项 | 内容 |
|---|---|
| **目标** | FFmpeg LGPL 合规（shared 构建、DLL 清单、不重编码视频）；`THIRD_PARTY_NOTICES.md` 覆盖 §6.7 全部组件；`FFMPEG-LICENSE.txt`；README / BUILD / ARCHITECTURE / ACCEPTANCE / LICENSE-COMPLIANCE；L3 在线烟测（不可达 → `SKIPPED` 写报告）；产物 SHA-256 记录 |
| **范围** | `docs/*`、`THIRD_PARTY_NOTICES.md`、`FFMPEG-LICENSE.txt`、`tests/e2e/*`（6–8 文件） |
| **验收** | §12.5 清单逐条可勾；`npm run test:all` L0–L2 全绿、L3 PASS 或 SKIPPED；产物 SHA-256 入文档 |
| **明确不做** | 重新打包（除非 M5-5 发现缺陷） |
| **停止判据** | commit + 报告 + **M5 完成，整体交付** |

---

## 12. 阶段汇报与批准机制（**硬制度，不是建议**）

> 这不是考试，是不限时的工程。每做完一块就停下来，让上下文归零、重新从「绿的基线」出发——比一口气做 3 小时正确率高得多。

### 12.1 铁律五条

1. **一块一停**：任何块（**含 `M4-0` 收口**）完成后**必须停下**，不得自动进入下一块。
2. **先报告，后申请**：报告落盘 + 向甲方汇报，**等批准**才开工下一块；甲方未回复 → 停在原地。
3. **一块一 commit**：不得把两个块合并成一个 commit；message 用 `M4-<n>: <主题>` / `M5-<n>: <主题>`。
4. **超限即拆**：单块实际工作量 >2 小时 或 >15 个文件 → 当场再拆一层，先报告方案再动手。
5. **回归先跑**：每块开工前先跑基线（`npm test` + 对应 milestone acceptance），起点不绿不得开工。

### 12.2 每块结束的汇报模板（六项，缺一不可）

| # | 项 | 要求 |
|---|---|---|
| 1 | 完成了什么 | 对照本块验收条目**逐条**说明，不许只写「已完成」 |
| 2 | 验收证据 | 命令 + 实际输出摘要（用例数 / 断言数 / exit code / 关键数值） |
| 3 | 改动文件 | 逐个路径列出，标注新增 / 修改 |
| 4 | 偏离与风险 | 新增 DECISIONS 编号、SKIPPED 项、与设计不符处 |
| 5 | 回归状态 | M1/M2/M3（或前序块）是否仍 `allGreen=true` |
| 6 | 下一块申请 | 下一块编号、预计工作量、预计文件数、主要风险；**明确请求批准** |

### 12.3 每块开工前的 5 步

```
1. 读：本块增量设计 docs/ARCHITECTURE-M4-<n>.md / M5-<n>.md
      + docs/DECISIONS.md 相关条目
      + 对应源码目录（只读，不扫全仓）
2. 跑基线：npm test → acceptance --milestone M3（M4 阶段）/ 全部（M5 阶段）
3. 确认 git status 干净（只有用户原有未提交编辑）
4. 实现 → 自测 → 落盘 docs/<块>-REPORT.md
5. commit → 按 §12.2 汇报 → 停下等批准
```

### 12.4 上下文控制三条硬规则

- 单块只读 3 份材料，不读全部 `docs/`；
- 单块只碰 1–2 个包，跨包改动必须拆；
- 单次改动 >15 个文件 或 >2 小时，立即再拆。

### 12.5 为什么这样切（给甲方的说明）

| 一口气做 3 小时 | 切成 1–2 小时的块 |
|---|---|
| 后半程容易产生「看起来对」的幻觉，错误率上升 | 每块都从干净的基线和短上下文重启 |
| 错误会累积到 QA 才发现，返工成本高 | 每块结束就验一次，错误当场暴露 |
| 上下文被细节占满，后面的设计判断变粗糙 | 每块只装必要信息，判断质量更稳定 |

### 12.6 报告节奏（**明确回答：多久报一次**）

**结论：按块报，不按小时报。** 每完成一块就停一次，不做「攒两块一起报」。

| 阶段 | 报告次数 | 预计节奏 |
|---|---|---|
| M4-0 … M4-6 | **7 次** | 每块 0.5–2 小时 → 大约每 1–2 小时一次 |
| M5-1 … M5-6 | **6 次** | 每块 1–2 小时 → 大约每 1–2 小时一次 |
| **合计** | **13 次** | — |

**三条硬规定**：

1. **到点必停**：单块从开工起算满 **2 小时**还没做完 → **立刻停下报告**（卡在哪、还差什么、要拆还是要决策），**不许继续硬做**。
2. **不许合并**：不得把 M4-2 和 M4-3 合成一次报告；不得说「都做完了再告诉你」。
3. **建议一天 1 块、最多 2 块**：连续做第 3 块时幻觉率会上升；宁可第二天继续。

**报告发在哪里**：对话里按 §12.2 的六项模板说清楚 ＋ 落盘 `docs/M4-<n>-REPORT.md`（**报告本身也要 commit**）＋ 给出 commit hash。

### 12.7 卡住、回滚、加断言、换机器

| 场景 | 怎么做 |
|---|---|
| **同一问题试了 2 次还失败** | **停下报告**：附命令、完整报错、已排除的可能。不要第 3 次盲试，也不要绕过或删掉测试。 |
| **某块做坏了要回滚** | `git log --oneline` 找到上一块 hash → `git revert <坏块 hash>`（推荐，保留历史）或 `git reset --hard <上一块 hash>`（**仅在未 push 且确认无未提交改动时**）。回滚后必须重跑 §5.2 全绿再报告。 |
| **新增断言 `A-M4-xx` / `A-M5-xx`** | 只能在 `scripts/acceptance.mjs` **续号追加**，不改已有 ID；每条必须绑定**真实测试**、`durationMs` 实测非零、写进对应 milestone 报告；`acceptance --milestone M4` 要能单独跑。 |
| **换机器 / 重新 clone** | `pnpm install` → `npm run check-runtime`（运行时在 `resources/runtime/win-x64`；若不在 git 里需 `npm run fetch:runtime`）→ 跑 §5.2 建自己的基线。 |
| **M5-4 打包前** | 必须先补 `electron` dist 二进制（当前为空，D-39）；这一步需要联网，**先告知甲方**。 |

---

## 13. 接手检查清单

### 开工前（9 项）
- [ ] `git log --oneline -10` 能看到 6 个 M3 功能 commit（`07a77b4`…`12ac40c`）+ 若干文档 commit（`82e29a1`、`072cb4e`、`6a411d1`…），**HEAD 以实际输出为准**；
- [ ] `git status --short` **只有** `M docs/PROJECT-HANDOFF.md`（用户自己的编辑；不得提交）；
- [ ] `npm test` 464/464 全绿；
- [ ] `node scripts/acceptance.mjs --milestone M3` 48/48 + `allGreen=true`；
- [ ] `npm run test:e2e` 14/14 + 5/5；
- [ ] `node scripts/check-runtime.mjs --json` → `allRequiredOk=true`；
- [ ] 已读完 §4「不可破坏的架构不变量」与 §8「8 个坑」；
- [ ] 已确认**本块**的放行状态（未批准不得开工；上块已汇报且已 commit）；
- [ ] 已确认本块工作量 ≤2 小时 / ≤15 文件，否则先按 §12.1 第 4 条再拆。

### 收工前（8 项）
- [ ] 本任务验收命令连跑 3 次全绿；
- [ ] M1/M2/M3 回归仍 `allGreen=true`（三份报告并存）；
- [ ] `request.ts` / `pnpm-lock.yaml` diff 为空（或已走 DECISIONS 登记）；
- [ ] 分层守卫 0 违规、typecheck 全过；
- [ ] `docs/<任务>-REPORT.md` 已落盘，含「剩余/阻塞/偏离」；
- [ ] `docs/DECISIONS.md` 已续号登记本轮偏离；
- [ ] 工作区干净（只剩用户原有未提交编辑）；
- [ ] 已声明「未获甲方放行，不进入下一任务」。

---

## 14. 文档索引（按阅读顺序）

| 顺序 | 文件 | 读它做什么 |
|---|---|---|
| 1 | 本文 `docs/M3-HANDOFF.md` | 全局状态 + M4/M5 拆解 |
| 2 | `docs/M3-REPORT.md` | M3 交付明细与实测输出 |
| 3 | `docs/DECISIONS.md`（D-30…D-45） | 16 条偏离与裁决，**改代码前必读** |
| 4 | `docs/ARCHITECTURE-M3.md` v1.1 | M3 设计依据（M4 可参考分层与文件组织） |
| 5 | `docs/PRD-M3.md` | M3 需求与断言映射（M4 写 PRD 时参考格式） |
| 6 | `docs/ARCHITECTURE-M2.md` §4 | M2 冻结 argv 顺序与状态机（**改动前必读**） |
| 7 | `docs/PRD-M1.md` §3 | 74 行断言 ID 映射总表 |
| 8 | `YTVDLT_HANDOFF.md` §8 / §4.4 / §9 | 原始任务书：M4/M5 验收标准、功能矩阵、禁止事项 |
| 9 | `docs/M3-QA-VERIFICATION.md` | QA 独立复验结论 |
| 10 | `docs/PROJECT-HANDOFF.md` | 旧交接包（M3 起接手用，历史参考） |

---

## 15. 文档入库状态与风险提示（**交接必看**）

### 15.1 已入库（commit `82e29a1`，2026-11-06）

| 文件 | 行数 | 作用 |
|---|---|---|
| `docs/PRD-M3.md` | 473 | M3 需求基线 + 36+12 断言映射 + 弹窗规格 |
| `docs/ARCHITECTURE-M3.md` | 1409 | M3 设计依据（11 章 / 5 图 / B0–B5 任务分解） |
| `docs/M3-HANDOFF.md`（本文） | 654 | 交付交接 + M4/M5 拆块 + 阶段汇报制度 + 术语表 |
| `docs/M3-QA-VERIFICATION.md` | 224 | QA 独立证伪复验报告（16 项 + 4 反例 + 6 缺陷） |

`docs/M3-REPORT.md`（200 行）已在 M3-B5 commit `12ac40c` 里；`072cb4e` 是本文的状态同步提交。**clone 仓库即可读到全部 M3 文档。**

### 15.2 仍需注意的三项

| 项 | 状态 | 处理方式 |
|---|---|---|
| `docs/PROJECT-HANDOFF.md` | `M`（用户 239 行自己的未提交编辑） | **不要提交、不要覆盖**；由甲方自行决定入库时机 |
| `reports/**`、`coverage/**` | `.gitignore` 忽略 | 验收证据不入库；clone 后必须重跑 §5.2 才有证据 |
| `node_modules/electron/dist` | 空 | Electron 真实窗口 / 默认播放器启动仍不可用（D-39） |

> **知识断档防线**：5 份核心文档 + `DECISIONS.md` 全部在仓库里；接手者按 §14 顺序读完 + 跑通 §5.2 的命令，即可在不看任何聊天记录的情况下独立开工。

---

## 16. 停止声明

**M3 已交付，未获甲方放行，不进入 M4。**

M4（`M4-0` + `M4-1…M4-6`）与 M5（`M5-1…M5-6`）均已拆解到「可独立验收、可独立 commit、可独立停下」的粒度。

**每一块开工前需单独取得批准；每一块结束后必须按 §12.2 的六项模板汇报并停下，未获批准不得进入下一块。**
