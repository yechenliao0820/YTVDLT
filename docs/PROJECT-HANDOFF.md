# YTVDLT · 项目交接包（M3 起接手用）

> **给谁看**：接手 M3 及后续开发的 AI / 开发者。  
> **怎么用**：本文是**一站式入口**，读完不需要看任何聊天记录。所有结论都落在本目录文件里，本文负责串起来。



---

## 📍 项目在哪（先抄这几行）

| 项                    | 位置                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| **项目根目录**            | `C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\ytvdlt`                                                   |
| **本文档（交接包）**         | `C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\ytvdlt\docs\PROJECT-HANDOFF.md`                           |
| **原任务书（唯一权威，933 行）** | `C:\Users\leolee\WorkBuddy\2026-11-05-07-24-49\YTVDLT_HANDOFF.md`                                        |
| **上层工作区**            | `C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08`                                                          |
| **git 仓库**           | 同项目根，分支 `master`。**代码主体到 `457c12c`**（M2 修复完成），其后是文档提交（本交接包）。交接时共 12 个提交；**以 `git log --oneline` 实际输出为准** |
| **开发环境**             | Windows x64 ／ Node v22.22.2 ／ pnpm 9.15.9 ／ 依赖已装、运行时四件已就位 —— **可直接开工，无需重新安装**                            |

> **一句话状态**：M1（骨架与引擎契约）与 M2（单任务下载闭环 + 完整性）已完成并通过独立复验；M3 尚未开工。下一步见 §13。

---

## 0. 接手前必读（三分钟版）

| 问题                  | 答案                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 这是什么项目？             | YTVDLT = YouTube Video Download Tool，Windows 桌面视频/音频下载器。是开源 Android 应用 **Seal** 的**功能等价桌面移植**（干净室重写，不复制其源码/资源/名称）。 |
| 最终要交付什么？            | 双击即用的 `.exe`：**NSIS 安装版** + **免安装便携版**，全自包含（yt-dlp / ffmpeg / node 随包），目标机不需要预装 Python/Node/FFmpeg/浏览器。            |
| 现在做到哪了？             | **M1 + M2 已完成**（代码、测试、验收、独立复验、文档齐全）。M3/M4/M5 未开始。                                                                  |
| 我接下来要做什么？           | **M3：格式/字幕/路径的全量参数分支 + 三个弹窗 UI**。详见 §7。                                                                            |
| 什么时候能看 YouTube 真下载？ | **M5 的 L3 在线烟测**才验真实站点。M1/M2 全部是本地 fixture + 真实 yt-dlp 离线验证。                                                       |
| 什么时候要联网？            | ① M5 的 L3 在线烟测；② 引擎自更新功能验证。**其余全程离线**。要联网前必须先告知用户，由用户切换网络环境。                                                       |
| 有哪些绝对不能做的？          | 见 §3「硬约束」。任何绕过 DRM/付费墙/登录/地区/年龄限制的能力**永久不做**。                                                                      |

---

## 1. 项目全景

### 1.1 是什么

**YTVDLT** 把 Android 应用 Seal 的行为规格（`YTVDLT_HANDOFF.md` §4 功能矩阵，74 项）干净室重写为 Windows x64 桌面应用：

- **Electron 主进程**以 `spawn(argv[])`（绝不 `shell:true`）编排随包自带的 `yt-dlp.exe / ffmpeg / ffprobe / node.exe`；
- **纯 TypeScript Core** 负责参数构造、队列状态机、完整性校验、本地持久化（零 electron、零 fs 副作用）；
- **React Renderer**（M3 起逐步引入）只订阅事件、发命令，不接触子进程。

Seal 本质是 yt-dlp 的 GUI 外壳，桌面版沿用这一架构，只把 Android 专用的 JNI 封装换成 Windows 官方 `yt-dlp.exe` 子进程。

### 1.2 为什么这么设计

任务书 §6.1 已做过选型比较，结论**不再讨论**：Electron 45 + React + TS + Vite。理由是本项目难点在「子进程编排 + 大量 yt-dlp 参数组合 + 队列状态机 + 可测试性」，不在渲染；Node 主进程正是 spawn 外部 exe 的主场。体积劣势（安装后约 500–700MB）对本地下载工具不敏感。

### 1.3 权威输入文档（按优先级）

| 文档                                      | 位置                                                                         | 作用                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **HANDOFF v1.1**                        | `C:/Users/leolee/WorkBuddy/2026-11-05-07-24-49/YTVDLT_HANDOFF.md`（933 行）   | **唯一权威**。§4 功能矩阵（74 项）、§7 验收方案（L0–L3、C1–C12）、§8 里程碑 M1–M5、§9 禁止事项、§11 CLI 参数速查、§12 EXE 分发与 LGPL 合规。**任何与本文档冲突的，以 HANDOFF 为准。** |
| PRD-M1                                  | `docs/PRD-M1.md`（348 行）                                                    | M1 需求基线 + **74 行「矩阵项→断言 ID」映射** + 17 条 M1 必须绿断言。断言 ID **稳定不改号**。                                                               |
| ARCHITECTURE-M1                         | `docs/ARCHITECTURE-M1.md`（1901 行）                                          | M1 施工单：106 文件清单、接口签名、端口注入、U3 实测方案。                                                                                             |
| ARCHITECTURE-M2                         | `docs/ARCHITECTURE-M2.md`（1020 行）                                          | M2 施工单：64 文件清单、下载 argv 顺序、C1–C12 细则、状态机转移表、6 批批次。                                                                              |
| M1-REPORT / M2-REPORT                   | `docs/`                                                                    | 里程碑汇报（含验收数据、断言对照表、偏离）。                                                                                                         |
| M1-QA-VERIFICATION / M2-QA-VERIFICATION | `docs/`                                                                    | **独立复验证据**（证伪视角）。M1 是两轮（初验 + 修复确认）。                                                                                            |
| DECISIONS                               | `docs/DECISIONS.md`                                                        | **全部偏离与决定**（D-01…D-29）。任何新偏离必须续写。                                                                                              |
| 验收报告                                    | `reports/acceptance-report-m1.json` / `-m2.json` / `acceptance-index.json` | 机器可读验收结果。                                                                                                                      |

### 1.4 五个里程碑（总览）

| 里程碑    | 范围                                                                                                                                                    | 状态          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **M1** | monorepo 骨架、shared DTO、ConfigStore、Logger、ErrorMapper、RuntimeResolver、YtDlpEngine.probe()、JsonMapper、运行时四件 + manifest + extraResources、U3 实测、L0/L1 测试 | ✅ **完成**    |
| **M2** | ArgvBuilder 下载分支、ProgressParser、产物精确捕获、CancelHandle（杀进程树）、TaskQueue 七态串行、ArtifactVerifier C1–C12、HistoryStore、TaskStore、L0–L2 测试基建                    | ✅ **完成**    |
| **M3** | §4.2/4.3/4.4 **全量参数分支**、FormatSelector/SubtitlePlanner/PathResolver、格式/字幕/播放列表三弹窗 UI、Windows 文件名边界、自定义标题/模板/裁剪/章节                                     | ⬜ **待做（你）** |
| **M4** | 并发调度（可配默认 3）、七态完整状态机 + 快照恢复、播放列表批量入队、自定义命令模板 CRUD + 白名单、任务日志页、托盘与通知                                                                                   | ⬜ 待做        |
| **M5** | 深浅色主题、快捷键、i18n、双通道自动更新、**NSIS 安装版 + 便携版 EXE**、FFmpeg LGPL 合规清单、NOTICE、L3 在线烟测、C13–C16                                                                 | ⬜ 待做        |

---

## 2. 当前完成状态（截至 2026-11-05）

### 2.1 M1（骨架与引擎契约）

| 项           | 结果                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| 验收（§8 五条）   | **5/5 PASS**                                                                                          |
| 断言          | **17/17 PASS**（7 条矩阵项 + A-INF-01…10）                                                                  |
| 覆盖率（全量四维最低） | **81.53%**（要求 ≥70%）                                                                                   |
| U3 实测       | **SUPPORTED** —— yt-dlp generic extractor 可解析本地直链，L2 走真实 `YtDlpEngine.probe()`，`FakeEngine` 保留作可替换性证明 |
| 独立复验        | **BASELINE-ACCEPTED**（两轮：初验 PASS-WITH-ISSUES → 修复后复核放行）                                               |
| 基线提交        | `50499e2`（`chore(m1): baseline after QA fixes`）                                                       |
| 运行时         | yt-dlp `2026.10.26` / ffmpeg `n9.0.2-47-gb204e94e90`（LGPL shared）/ node `v24.22.2`，全部 SHA-256 可校验     |

### 2.2 M2（单任务下载闭环 + 完整性）

| 项           | 结果                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| 验收（§8 六条）   | **6/6 PASS**（真实下载、进度含 %/速度/ETA、取消无残留且 `.part` 保留、重试续传哈希一致、C1–C12、历史唯一）                                      |
| 断言          | **37/37 PASS**（沿用 12 条 + A-M2-01…25）                                                                        |
| 覆盖率（全量四维最低） | **85.42%**（要求 ≥70%）                                                                                         |
| 测试          | **206 例全绿**（unit + contract）+ 5 条 L2 离线端到端                                                                  |
| C1–C12      | 10 PASS + 2 SKIPPED（C8 纯下载无后处理、C11 无历史条目），0 FAIL                                                            |
| 施工提交        | `3bba355` `85b83e8` `186ce92` `fcbb0da` `615da08` `a5d86c4`（B0–B5，每批一个）                                     |
| 修复提交        | `b924f06`（P1-2 manifest 深合并）`420c6f7`（P1-1 ETA 断言）`9e25594`（P2-1/2 durationMs + 分里程碑报告）`457c12c`（D-29 环境守卫） |

**M2 复验共三轮（重要，说明质量关卡是真生效的）**：

1. **一轮复验判 FAIL**：产品实现是真的，但**验收门有问题**——
   - `download-local` 的 ETA 断言在小文件快速下载下天然不可靠（4 次跑 3 次红）；
   - **最严重**：跑 M1 验收会静默删掉 `tests/fixtures/manifest.json` 里的 `expectedFormat` / `c8Golden`，导致 **C7 从“比对宽高编码”退化成“只记录”、C8 永远 SKIPPED**。方向是“让检查变绿”，这类问题不修，后续所有里程碑的“全绿”都不作数。
2. **修复（4 项）**：`b924f06`（manifest 深合并保留未知键 + 守卫测试）、`420c6f7`（ETA 断言加限速 40KB/s）、`9e25594`（durationMs 实测 + duration 门控 + M1/M2 报告分文件）、`457c12c`（D-29 环境守卫）。
3. **二轮复验：PASS-WITH-ISSUES，正式放行 M3**：
   - 4 项修复 **4/4 PASS**（含独立复算：`u3-verify` 后 `git diff manifest.json` 为空、C7 真比对 320x240/h264/25fps、C8 理由是“纯下载”而非 golden 缺失）；
   - **acceptance M2 三连跑 3/3 全绿**（37/37 + 5/5 gate，coverage min 85.42–85.48%，durationMs 全实测无 1ms）；
   - 六条验收全 PASS（含取消用例的**进程快照**：跑前 NO-PROCESS → 跑后 NO-PROCESS）；
   - C1–C12：10 PASS + 2 SKIPPED（C8 纯下载、C11 无历史入口），0 FAIL；  
     |  |  |  
     | --- | --- |
   - **反例测试成立（证据链完整）**：故意把 `download-flags.test.ts:20` 的断言改坏 → `acceptance --milestone M2` **exit 1**（`[acceptance] M2: vitest failed`）→ 用失败结果聚合时 `M2-GATE-vitest: FAIL | 212 tests, 1 failed`、`allGreen=false`、exit 1 → 还原后 37/37 全绿 exit 0。证据：`reports/qa-evidence-m2r2/A3-acceptance-m2-broken-real.log`、`A3b-acceptance-m2-gate-fail.log`、`A4-acceptance-m2-restored.log`。**门控真的会红，不是放水。**（曾有一处“测试失败却仍报全绿”的疑点，已查清是测试文件被外部还原后的正常绿，非 P0 漏判。）
   - 206 vs 207 例差异查明：**不是删测试**，是新增了 5 例 manifest 守卫测试（201+5=206），全量 212 例。

> 详见 `docs/M2-QA-VERIFICATION.md`（557 行，含二轮章节）与 `reports/qa-verification.json` 的 `m2Recheck` 段，原始证据在 `reports/qa-evidence-m2r2/`。

### 2.2.1 ⚠️ 放行 M3 的硬性待办（R2-1，必须做）

QA 发现 `scripts/lib/vitest-run.mjs` 的 `runVitestGuarded()`（为绕开本机 safe-delete 批量删除限制而加的“退出码守卫”）**有一个已证实的漏洞**：

- 判定只看 `vitest-results.json` 的内容（`success===true && numFailedTests===0`），**不校验新鲜度**（不删旧文件、无 run-id/mtime 校验）；
- 反例 B 证明：让子进程 exit 1 + 打印 guard 标记、不写结果文件 → 被上一轮的绿结果骗过，`1 → 0`；
- 真实场景：vitest 崩溃/OOM/被杀未及重写结果文件时，**真实失败会被误判为环境中断**；
- 附带：条件③ 只查“测试全绿”，**不查覆盖率四维 ≥70**，覆盖率阈值失败理论上也能被吞。

**M3 首批必须收紧三处（约 10 分钟）**：

1. spawn 前**删除/隔离**旧的 `vitest-results.json` 与 `coverage-summary.json`（或加 mtime/run-id 新鲜度校验）；
2. guard 判定**补上覆盖率四维 ≥70 的复算**；
3. `guardMitigated` 时记录 `originalStatus`（留痕，便于审计）。

**做完后必须用反例复验**：改坏一个断言 + 手造陈旧成功结果 → 仍必须 FAIL。这一条在 **M3 复验前完成**，否则 M3 的“全绿”不可信。

### 2.3 已验证有效的工程实践（请沿用）

这些是 M1/M2 花真金白银换来的，不要丢：

1. **QA 用证伪视角**，不盖章；必须独立重跑、独立复算哈希、做反例测试、跑前/跑后进程快照。
2. **验收命令连跑 N 次**（M2 要求 3 次）才能算稳，单次全绿可能是运气。
3. **每个里程碑分批提交**（M2 每批一个 commit），便于 diff 级审计。  
   |  |  |  |  |  |  
   | --- | --- | --- | --- | --- |
4. **门控不能有恒真兜底**（M1 踩过：`|| exists(...)` 让门控形同虚设）。凡有 `||`/`?? true`/吞异常的判定，一律视为可疑。
5. **测试要能被故意改坏**（反例测试），否则无法证明门控真的会红。
6. **fixture 基准必须被保护**（M2 踩过：脚本硬编码重写 manifest 删掉新增键）。
7. **产品代码与验收脚本分开修**：验收问题不要去动业务逻辑掩盖。

---

## 3. 硬约束（永久有效，违反即返工）

来源：HANDOFF §9 禁止事项 + §6.7 合规边界 + §3.6 许可证。

| # | 约束                                          | 说明                                                                                                                                                                                                 |
| - | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | **不重新讨论选型、命名、平台范围**                         | §2 已拍板：Electron 45.2.2 + React + TS + Vite；仅 Windows x64；官方 yt-dlp.exe 子进程；产品名 YTVDLT。                                                                                                             |
| 2 | **不复制 Seal 的 Kotlin/Java 源码、XML 资源、图标、字符串** | 干净室重写，只参照 §4 行为规格与 CLI 参数语义。                                                                                                                                                                       |
| 3 | **不用 "Seal" 作产品名、包名、窗口标题、图标或宣传语**           | 上游 README 明令禁止。README 注明“功能参照 Seal，非官方、无关联”。                                                                                                                                                       |
| 4 | **不实现任何绕过能力**                               | DRM / 付费墙 / 会员内容 / 登录限制 / 地区限制（`--geo-bypass*`）/ 年龄限制；**不生成或注入 PO Token**；**不自动抓取浏览器凭据**（`--cookies-from-browser`）；**不降低 TLS 校验**（`--no-check-certificates`、`--prefer-insecure`）。白名单拦截，遇到此类需求直接拒绝。 |
| 5 | **不字符串拼接命令、不 `shell:true`**                 | 一律 `spawn(绝对路径, argv[], { shell:false, windowsHide:true })`；用户可控 token 置于 `--` 之后。                                                                                                                 |
| 6 | **不跳过完整性校验置 `Completed`**                   | 必须 `verify().ok===true` 才置 Completed、才写历史。                                                                                                                                                         |
| 7 | **不一次性生成大量未经验证的代码**                         | 分批执行，每批跑通验证再进下一批。                                                                                                                                                                                  |
| 8 | **暂停 ≠ 暂停**                                 | 上游的“暂停图标”实为取消。UI 统一命名「取消 / 重试」，README 说明与上游差异。M2 已按此实现（`Canceled` + `restart()`）。                                                                                                                  |
| 9 | **`--cookies` 只接受用户手动导入的自有 `cookies.txt`**  | 日志与报告中 Cookie 一律脱敏。                                                                                                                                                                                |

**合规提示语**（首次运行页与“关于”页）：帮助用户保存**其有权保存的公开可访问内容**；用户自行确认权利与站点条款。工具不做权利判断，也不提供规避技术措施的能力。

---

## 4. 如何复跑验证（接手第一步就做这个）

在项目根执行。**全部离线**（L2 仅用 127.0.0.1）。

```bash
# 0) 环境（应输出 Node v22.22.2 / pnpm 9.15.9）
node -v && pnpm -v

# 1) 全量测试 + 覆盖率门控（206 例，四维最低应 ≥70%）
npm test

# 2) M1 / M2 验收（应分别为 17/17+5/5、37/37+gate，exit 0）
node scripts/acceptance.mjs --milestone M1
node scripts/acceptance.mjs --milestone M2

# 3) 运行时自检（3 必需 OK + aria2c OPTIONAL，exit 0）
npm run check-runtime

# 4) 分层守卫（core/engine-ytdlp 零 electron/零 fs import，0 违规）
node scripts/check-layering.mjs

# 5) L2 离线端到端（真实 yt-dlp + 127.0.0.1 mock server）
npm run test:integration:offline -- --case probe-local
npm run test:integration:offline -- --case download-local
npm run test:integration:offline -- --case cancel-local
npm run test:integration:offline -- --case retry-local
npm run test:integration:offline -- --case artifact-local

# 6) 定向覆盖率诊断（按文件名匹配，会真跑全部相关用例）
npm run test:unit -- --run ArgvBuilder --coverage
```

**判据速查**：

| 命令                          | 通过标准                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `npm test`                  | 全部 PASS、四维最低 ≥70%、exit 0                                                                 |
| `acceptance --milestone M1` | 17/17 + 5/5，exit 0                                                                       |
| `acceptance --milestone M2` | 37/37 + 全部 gate，exit 0；**连跑 3 次应 3 次全绿**                                                 |
| `check-runtime`             | 3 必需 OK、绝对路径、版本非空；aria2c 缺失仅 OPTIONAL；移走 `node.exe` 应报 `JS_RUNTIME_MISSING` + **exit 2** |
| `check-layering`            | violations = 0                                                                           |
| L2 五用例                      | 各自 exit 0                                                                                |

**已知的稳定性注意**：

- **L2 必须串行**（`fileParallelism: false`），不要并行，否则端口冲突。
- `download-local` 依赖 mock-server 限速（`rateBytesPerSec: 40960`）；调快会抓不到“下载中”，ETA 断言会随机红。
- `cancel-local` 依赖限速（20KB/s），否则瞬间下完无法取消。
- 覆盖率**只认全量**（`pnpm exec vitest run --coverage` 或 `npm test`）；定向运行的数字只作诊断，不是覆盖率结论。
- `durationMs` 按证据步骤记录、同步骤多条断言共享（非逐断言计时），属预期口径。

---

## 5. 代码结构与契约快照

### 5.1 目录结构

```
ytvdlt/
├─ package.json / pnpm-workspace.yaml / turbo.json / tsconfig.base.json
├─ vitest.config.ts / .npmrc / .gitignore
├─ packages/
│  ├─ shared/            # DTO / ErrorCode / 端口类型（纯类型，零 node import）
│  │  └─ src/{index,errors,events,media,request,runtime,engine,ipc,ports,
│  │           progress,verification,task,history}.ts
│  ├─ core/              # 纯 TS，零 electron / 零 fs 副作用（构造函数注入端口）
│  │  └─ src/{config-store,logger,error-mapper,runtime-resolver,
│  │           task-queue,task-store,history-store,artifact-verifier,...}/
│  └─ engine-ytdlp/      # DownloadEngine 唯一实现 + FakeEngine
│     └─ src/{yt-dlp-engine,argv-builder,progress-parser,json-mapper,
│             artifact-manifest,download-flags,fake-engine,...}/
├─ apps/desktop/
│  ├─ src/main/{index,app-host,ipc-gateway}.ts   # 空桩（M1 起不 createWindow）
│  ├─ src/main/adapters/node-ports.ts            # 唯一 I/O 实现点
│  ├─ src/main/runtime-resolver.ts               # 唯一 electron import 点
│  └─ electron-builder.yml                       # extraResources（运行时不入 asar）
├─ scripts/
│  ├─ {fetch-runtime,check-runtime,u3-verify,acceptance,run-tests,
│  │   check-layering,verify-artifact}.mjs
│  └─ lib/{vitest-run,fixture-manifest,mock-server,...}.mjs
├─ resources/runtime/win-x64/                    # 随包运行时（不入库）
│  ├─ yt-dlp.exe / node.exe / ffmpeg/{ffmpeg.exe,ffprobe.exe,*.dll}
│  ├─ runtime-manifest.json / SHA2-256SUMS / FFMPEG-LICENSE.txt
├─ tests/
│  ├─ unit/          # L0 零网络单测
│  ├─ contract/      # L1 契约（录制 fixture 回放）
│  ├─ integration/offline/   # L2 真实 yt-dlp + 127.0.0.1
│  └─ fixtures/      # media/fixture.mp4、info-*.json、manifest.json、golden
└─ docs/             # 本文档 + 前述全部文档
```


### 5.2 分层铁律（编译期 + 静态双重锁定）

1. `packages/{shared,core,engine-ytdlp}` 的 tsconfig 设 `"types": []` —— `process`/`Buffer`/`fs` 在**编译期**即不可用。
2. 全仓库**唯一 I/O 实现点** = `apps/desktop/src/main/adapters/node-ports.ts`。
3. **唯一 electron import 点** = `apps/desktop/src/main/runtime-resolver.ts`（只读 `app.isPackaged` 后组装）。
4. `scripts/check-layering.mjs` 扫 import 黑名单（`electron` / `node:fs` / `fs` / `child_process` / `crypto` / `os`），**0 违规**才算过。
5. 所有 Core 类**构造函数注入端口**，类内绝不 `new` Node 适配；测试用 `tests/unit/helpers/in-memory-ports.ts`。

### 5.3 冻结契约（**不得随意更改**，要改必须走 DECISIONS 并全量回归）

**错误码（17 个，`packages/shared/src/errors.ts`）**：  
`INVALID_URL` `UNSUPPORTED_SITE` `FORMAT_UNAVAILABLE` `NETWORK_TIMEOUT` `DNS_FAILURE` `HTTP_403` `HTTP_429` `ALREADY_DOWNLOADED` `DISK_FULL` `PERMISSION_DENIED` `ENGINE_MISSING` `JS_RUNTIME_MISSING` `FFMPEG_MISSING` `EJS_FAILED` `ARTIFACT_INCOMPLETE` `CUSTOM_COMMAND_REJECTED` `UNKNOWN`

**`DownloadEngine` 接口（5 方法）**：`version()` / `probe()` / `probePlaylist()` / `download()` / `selfUpdate()`。`probePlaylist`/`selfUpdate` 目前是 `UNKNOWN` 占位（M3/M5 实现）。`FakeEngine` 实现同一接口，证明可替换性。

**probe argv 顺序（冻结）**：

```
-J --dump-single-json --no-playlist --no-warnings --socket-timeout 5 -R 1
--no-js-runtimes --js-runtimes node:<随包 node.exe 绝对路径> [--proxy v] [--cookies v] [--add-header v] -- <url>
```

**download argv 要点**（M2，完整表见 `ARCHITECTURE-M2.md` §4.1）：`-f`/`-S`、`-x`、`--audio-format`、字幕参数、`-P`、`-o`、`-r`、`--download-archive`、`--no-mtime`、`--concurrent-fragments`、`--proxy`/`--cookies`/`--add-header`、`--ffmpeg-location`、`--newline`、`--progress-template`、`--print-to-file after_move:filepath`。**M3 要在此基础上补全 §4.2/4.3/4.4 的全量组合。**

|                            |                               |                          |                                   |                    |                  |                        |
| -------------------------- | ----------------------------- | ------------------------ | --------------------------------- | ------------------ | ---------------- | ---------------------- |
| **进度模板**：\`download:YTVDLT | %(progress.downloaded_bytes)s | %(progress.total_bytes)s | %(progress.total_bytes_estimate)s | %(progress.speed)s | %(progress.eta)s | %(progress.elapsed)s\` |

**产物清单**：`--print-to-file "after_move:%(filepath)q" <临时清单>`，**append 模式**（每次下载前必须 unlink 旧清单）；`%(filepath)q` 会加外层引号，解析要剥一层同种引号。**禁止目录扫描找产物。**

|                                                                            |       |                                                                                                                    |
| -------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| **任务状态机（7 态）**：\`Idle → FetchingInfo → ReadyWithInfo → Running → Completed | Error | Canceled`。13 条合法转移，36 条非法组合一律拒绝（抛 `IllegalTaskTransitionError`）。`Completed\` 是终态。**M2 为串行（maxActive=1），并发调度留 M4。** |

**完整性判据 C1–C12**（详见 `ARCHITECTURE-M2.md` §4.4）：

- **C4 只判 `stderr.trim()===''`，绝不看 exit code**（exit 0 但有解码警告 = 坏文件）。
- **C5** 在 `MediaInfo.duration===null` 时降级与 `manifest.durationSec` 比较，两者都无则 `SKIPPED`，绝不 FAIL。
- **C2 vs C8 按 `postprocessed` 动态二选一**：纯下载判 C2（字节哈希）、C8 记 SKIPPED；后处理判 C8（framemd5）、C2 记 SKIPPED。
- **C12 时序铁律**：`HistoryStore.add` 与置 `Completed` 只能在 `verify().ok===true` 之后。

**端口扩展（向后兼容，只增不改）**：`FileSystemPort` `HashPort` `ClockPort` `EnvPort` `LogSinkPort` + `ProcessPort`（`spawn` / **`spawnStreaming` / `isAlive`**）+ `IShellPort`（`openPath` / `showItemInFolder`，M2 用 `explorer.exe` argv 实现，真实默认播放器留 M3 接 Electron `shell`）。

**取消语义**：`CancelHandle.cancel()` 用 `taskkill.exe /PID <pid> /T /F`（argv[] + 绝对路径）**杀进程树**，不用 `child.kill()`（会留 ffmpeg 孤儿）；取消后断言 pid 已消失、`.part` 保留、不写历史。**没有“真暂停”**，UI 语义是「取消 + 重试」。

---

## 6. 环境与工具链

### 6.1 开发环境

| 项      | 值                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| OS     | Windows x64（目标 Win10 1809+ / Win11 x64；**Win7/8/8.1 不支持**，Electron 23 起移除）                                  |
| Node   | **v22.22.2**（开发用）；随包另带 node.exe v24.22.2（yt-dlp EJS 的 JS runtime）                                           |
| 包管理    | **pnpm 9.15.9**（`corepack enable && corepack prepare pnpm@9.15.9 --activate`；**不要换包管理器**）                   |
| Python | 3.13.14（仅本机工具；运行时不依赖 Python，yt-dlp.exe 是 PyInstaller 单文件自带解释器）                                              |
| 关键依赖   | Electron 45.2.2、TypeScript 5.8.3、Vitest 3.2.4（**`@vitest/coverage-v8` 必须同 3.2.4**）、Vite 6.3.5、tsx 4、turbo 2 |

### 6.2 随包运行时（`resources/runtime/win-x64/`，不入库）

| 组件                                 | 版本                      | 许可                                                          | 来源                                       |
| ---------------------------------- | ----------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| `yt-dlp.exe`                       | `2026.10.26`            | 源码 Unlicense；standalone exe 含第三方组件                          | 官方 release + `SHA2-256SUMS` 交叉校验         |
| `node.exe`                         | `v24.22.2`              | MIT                                                         | nodejs.org 官方 zip                        |
| `ffmpeg.exe` + `ffprobe.exe` + DLL | `n9.0.2-47-gb204e94e90` | **LGPL-3.0**（实测随包 LICENSE.txt 为 v3，**非**任务书假设的 2.1+，见 D-08） | BtbN `*-win64-lgpl-shared.zip` 整个 `bin/` |
| `aria2c.exe`                       | —                       | GPL-2.0-or-later                                            | **不捆绑**，用户自备，可选项                         |

`runtime-manifest.json` 记录每项 `path / sha256 / size / version / sourceUrl / releaseTag / license`；`path` 为相对 runtime 根、**不含 `win-x64` 层**（开发态与打包态共用同一份 manifest）。

### 6.3 本机沙箱已知坑（务必知道）

| 坑                  | 表现                                                                                     | 处理                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **safe-delete 限制** | 单次批量删除 >50 文件被拦截，导致 `vitest run --coverage` 收尾清理 `coverage/.tmp` 时进程非零退出（测试和覆盖率其实都成功了） | 已有 `scripts/lib/vitest-run.mjs` 的 `runVitestGuarded()`：**仅当**「退出非零 + 命中 guard 标记 + `vitest-results.json` 证明 success 且 0 失败 + `coverage-summary.json` 存在」四条件同时成立，才判为环境性中断并分批清理；否则原样上报失败。**这个东西必须持续受反例测试监督**（故意改坏断言不能被它吞掉）。若你的环境没有该 shim，它完全不触发。 |
| Bash 可用性           | 本会话 Bash 可用（coreutils 齐全）；历史上出现过不可用（`dirname: command not found`），与 WorkBuddy 版本/会话有关  | 开工先跑 `echo ok` 探测；不通改用 PowerShell                                                                                                                                                                                                              |
| PowerShell 编码      | `Invoke-WebRequest` 会把 UTF-8 当 ANSI 解码成乱码                                              | 用 `curl.exe -o` 落原始字节再按 `utf-8` 解码                                                                                                                                                                                                             |
| 大文件删除              | 同上 safe-delete                                                                         | 批量 ≤20 个/批                                                                                                                                                                                                                                     |

### 6.4 联网需求（**要联网前必须先告知用户**）

| 场景          | 是否联网                  | 何时          |
| ----------- | --------------------- | ----------- |
| M1/M2 全部验收  | **否**（L2 仅 127.0.0.1） | —           |
| M3/M4 大部分工作 | 否（本地参数分支、UI、状态机）      | —           |
| 下载运行时四件     | 是（约 130MB）            | 首次搭建 / 引擎更新 |
| **L3 在线烟测** | **是**（真实站点下载）         | **M5**      |
| 引擎/应用自更新验证  | 是                     | M5          |
| npm install | 是                     | 首次 / 依赖变更   |

**给用户的沟通口径**：真实视频下载能力（YouTube 等真实站点）要到 **M5 的 L3 在线烟测**才验证；届时需要用户切换到可联网环境，并提供一个**其有权保存的公开视频链接**。现在不要声称“YouTube 一定能下载”。

---

## 7. M3 任务说明书（你现在要做的）

### 7.1 范围（严格按 HANDOFF §8 M3，不许多做）

把 §4.2/4.3/4.4 的**全量参数分支**做完，并开始 UI（三个弹窗）：

1. **格式与清晰度（§4.2，13 项）**：清晰度档位 `-S res:N`、编码偏好/AV1、自定义格式排序、手动格式选择（`-f id+id`）、多音频流合并 `--audio-multistreams`、仅音频 `-x`、音频质量 `abr~N`、音频编码 `acodec:`、音频转码 `--audio-format`（与 `-S abr~` 互斥）、元数据/封面嵌入、缩略图/章节/容器决策（`--remux-video mkv`）、片段裁剪 `--download-sections`、章节拆分 `--split-chapters`、自定义标题 `--replace-in-metadata` / 输出模板。
2. **字幕（§4.3，8 项）**：下载开关、语言表达式 `--sub-langs`、自动字幕 `--write-auto-subs`、自动翻译字幕（`youtube:skip=translated_subs` 的取舍）、格式转换 ass/srt/vtt/lrc、嵌入 `--embed-subs`（强制 mkv）、保留独立字幕、格式页按语言多选。
3. **路径（§4.4 相关项）**：视频/音频/命令三目录、私有目录、按站点/播放列表建子目录、输出模板与**文件名净化**（Windows 非法字符/保留名/260+ 长路径）、临时文件与清理、下载归档去重。
4. **三个 UI 弹窗**：格式选择弹窗（三组分栏：仅视频/仅音频/音视频合并）、字幕选择弹窗、播放列表选择弹窗。**M3 起才开始写 UI**（`packages/ui/` 与 React 组件）。
5. **`PathResolver` Windows 边界**：非法字符、保留名（CON/PRN/AUX/NUL/COM?/LPT?）、260+ 长路径、UNC 路径。

### 7.2 验收标准（§8 M3，四条）

1. `ArgvBuilder` 组合单测 **≥60 例**（清晰度 8 档 × 编码 2 × 音频 5 档 × 字幕 5 格式 × 路径 4 组合）；
2. **每个矩阵项有断言**（M3 归属共 36 条，ID 见 PRD-M1 §3.2–§3.4）；
3. Windows 非法字符/保留名/260+ 长路径单测通过；
4. 三个弹窗 **Playwright 截图回归**。

### 7.3 断言映射（M3 归属 36 条，ID 不改号）

- §4.2：`A-4.2-01`…`A-4.2-13`（13 条）
- §4.3：`A-4.3-01`…`A-4.3-08`（8 条）
- §4.4：`A-4.4-01`…`A-4.4-04`、`A-4.4-25`、`A-4.4-26`、`A-4.4-27`、`A-4.4-30`（部分）等
- 另需新增 `A-M3-01…` 骨架断言（弹窗交互、PathResolver 边界、模板渲染）

### 7.4 建议批次（M3-B0…B5）

| 批      | 目标                                                                                                           | 验证命令                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **B0** | **先做 R2-1（§2.2.1）：收紧 `runVitestGuarded` 新鲜度校验 + 覆盖率复核 + 反例复验**，再写增量设计 `ARCHITECTURE-M3.md`（基于实际 M2 代码）+ 任务分解 | 反例复验（改坏断言必须 FAIL）+ 设计评审                                                             |
| **B1** | 格式/字幕/路径**纯函数**（FormatSelector/SubtitlePlanner 的参数决策）                                                        | `vitest run tests/unit/format-selector.test.ts tests/unit/subtitle-planner.test.ts` |
| **B2** | `PathResolver` + Windows 边界（非法字符/保留名/长路径/UNC）                                                                | `vitest run tests/unit/path-resolver.test.ts`                                       |
| **B3** | `ArgvBuilder` 全量参数分支（组合 ≥60 例）                                                                               | `vitest run tests/unit/argv-builder*.test.ts --coverage`                            |
| **B4** | 三个弹窗 UI（React + 组件库）+ Playwright 截图回归                                                                        | `npm run test:e2e`                                                                  |
| **B5** | 全量回归 + acceptance(M3) + 报告 + 停下等放行                                                                           | `npm test` / `acceptance --milestone M3`                                            |

### 7.5 技术难点与踩坑预警

1. **参数互斥矩阵**：音频转码 `--audio-format` 与 `-S abr~` 互斥；字幕嵌入强制 `mergeToMkv=true`；音频模式禁用字幕嵌入；多音频流 ≥2 才 `--audio-multistreams`。这些分支必须单测覆盖。  
   |  |  |  
   | --- | --- |
2. **Windows 文件名净化**：非法字符 `<>:"/\|?*`、控制字符、保留名（大小写不敏感）、结尾点/空格、260+ 路径（需 `\\?\` 前缀或截断）、超长标题截断到 200B（`%(title).200B`）。
3. **多流进度回退**：video+audio 分离时 yt-dlp 会输出两段 0→100%，`percent` 会回退。M2 只承诺单流递增；**M3 必须按 stage 分段处理**（D-18 已留痕）。
4. **ffmpeg 孤儿未压测**：M2 的 fixture 是单 format（不启动 ffmpeg）。**M3 的双流合并用例必须压测 `taskkill /T /F` 后 ffmpeg 无残留**（D-28 已记）。
5. **C11 生产链路恒 SKIP**：`task-queue.ts` 目前传 `historyEntry: null`。M3 接入 history 后由队列回填激活 C11。
6. **Playwright 截图回归**要固定窗口尺寸与字体渲染，否则跨机器会 diff。

### 7.6 M3 不做什么

- 不做并发调度（M4）、不做托盘/通知（M4）、不做自定义命令模板（M4）。
- 不做打包（M5）、不做在线烟测（M5）。
- 不做 `probePlaylist()` 的真实实现（播放列表**解析**在 M3，**批量入队**在 M4；若 M3 做了解析，入队逻辑留 M4）。

---

## 8. M4 任务说明书（M3 之后）

### 8.1 范围（§8 M4）

1. **并发调度**：`TaskQueue` 支持可配置并发（**默认 3**，对齐源码 `MAX_CONCURRENCY=3`），按状态 ordinal 挑任务，自动补位；并发上限 1–8 可配。
2. **七态完整状态机 + 快照持久化与恢复**：`TaskStore` 快照未完成任务，重启后**运行/解析中一律转 `Canceled`**（保留上次进度，可重试）。
3. **播放列表批量入队**：`--playlist-items` 每条独立任务、独立进度、并发不超限。
4. **自定义命令模板 CRUD + 白名单**：参数逐项过**选项白名单**，禁用 `--exec`、`--config-locations` 嵌套、`--ppa` 任意脚本及合规禁用清单；未知选项拒绝并提示行号。任务 4 态、逐行日志、复制/取消/重试。
5. **任务日志页**：左任务列表 + 右实时日志（等宽、级别着色、自动滚动、复制、导出）。
6. **托盘与通知**：托盘常驻 + 系统通知（进度/完成/错误/取消）+ 关窗最小化到托盘；错误附 `stackTraceToString()` 可复制。

### 8.2 验收标准（§8 M4，五条）

1. 7 任务同时运行 **≤3** 且自动补位；
2. 强杀重启后队列恢复为 `Canceled` 且保留进度；
3. 播放列表 5 条 → 5 个独立任务；
4. 含禁用选项的模板 → `CUSTOM_COMMAND_REJECTED` 且不执行；
5. 状态机非法转移单测全绿。

### 8.3 断言映射（M4 归属 10 条）

`A-4.1-06`（播放列表批量）、`A-4.4-09`（并发队列）、`A-4.4-10`（状态机）、`A-4.4-15`（快照恢复）、`A-4.4-17`（任务详情操作）、`A-4.4-18`（通知与错误报告）、`A-4.4-23`（自定义命令）、`A-4.4-24`（备份导入导出）、`A-4.6-03`（前台服务→托盘）、`A-4.6-05`（计量网络确认）。

### 8.4 难点预警

1. **并发下的取消竞态**：多个任务同时运行时取消一个，不能影响其他；进程组终止要按 pid 隔离。
2. **快照恢复的原子性**：崩溃时快照可能写到一半，必须 tmp+rename；恢复时校验 schemaVersion 并迁移。
3. **自定义命令注入面**：这是**高风险项**（HANDOFF R8）。argv 数组 + 白名单 + 单测含 **12 类恶意输入**（`--exec`、`;`、`&&`、反引号、换行、超长、Unicode 同形字、`--config-locations` 嵌套、`--ppa` 任意脚本、`--geo-bypass`、`--cookies-from-browser`、`--no-check-certificates`）。
4. **计量网络检测**：Windows 计费网络 API 可能需要 Electron 层（M4 可接）。
5. **通知去抖**：进度通知不能刷屏。

---

## 9. M5 任务说明书（最后一步，交付成 exe）

### 9.1 范围（§8 M5）

1. **UI 打磨**：深浅色主题（Light/Dark/System + 强调色）、快捷键（§6.8 列表）、空/错状态、i18n（zh-CN + en）。
2. **双通道自动更新**：应用自身 `electron-updater` + NSIS（`latest.yml`）；引擎下载官方 release 的 `yt-dlp.exe`，`SHA2-256SUMS` 校验后原子替换，stable/nightly + 间隔（默认每周），**更新期间暂停队列**。
3. **打包（§12 全节）**：
   - `YTVDLT-Setup-<ver>.exe`（NSIS，per-user，不需管理员）
   - `YTVDLT-Portable-<ver>.exe`（免安装便携版，配置写 exe 同目录，不可写时回退 `%APPDATA%\YTVDLT`）
   - `extraResources` 放运行时（**绝不入 asar**，asar 内文件无法直接 spawn）
   - `app.isPackaged` 切换开发/打包路径
4. **FFmpeg LGPL 合规清单（§12.5，12 条逐条）**：动态链接、DLL 可替换、提供对应源码链接、构建脚本说明、下载页声明、**“关于”框声明**、EULA 不禁止反向工程、DLL 不混淆改名、内嵌 LGPL 库列入 NOTICE、不含 libx264 等 GPL 库、随包 `FFMPEG-LICENSE.txt`。
   > ⚠️ **D-08**：实测随包 FFmpeg 是 **LGPL-3.0**（LICENSE.txt 首行 Version 3, 29 June 2007），**不是**任务书假设的 LGPL-2.1+。所有文案必须改成与实际一致，否则合规不严谨。
5. **文档全套**：`README.md` / `BUILD.md` / `ARCHITECTURE.md` / `ACCEPTANCE.md` / `SHORTCUTS.md` / `LICENSE-COMPLIANCE.md` + `THIRD_PARTY_NOTICES.md`。
6. **L3 在线烟测**：一个公开且明确允许保存的视频（如 Blender 官方 demo），跑一次真实下载 + C1–C12 完整性校验。**网络不可达记 `SKIPPED`，不判 FAIL**。


### 9.2 验收标准（§8 M5，七条 + C13–C16）

1. **干净 Windows 虚拟机**（无 Python/Node/FFmpeg/Chrome）双击安装版 → 安装 → 启动 → 自检 4 项全绿 → 完成一次真实下载 → C1–C12 全过（**C13**）；
2. 便携版免安装可运行（**C14**）；
3. **C13–C16 全通过**（运行时完整性、不污染系统、卸载清理）；
4. 主题三态与全部快捷键生效；
5. NOTICE 覆盖 §6.7 全部组件且 §12.5 清单逐条满足；
6. `npm run test:all` L0–L2 全绿，L3 PASS 或 SKIPPED；
7. 产物 SHA256 记录。

### 9.3 断言映射（M5 归属 9 条）

`A-4.1-02`（系统分享/全局热键）、`A-4.4-16`（任务筛选与空状态）、`A-4.4-20`（深浅色）、`A-4.4-21`（i18n）、`A-4.4-28`（引擎更新）、`A-4.4-29`（应用自更新）、`A-4.5-08`（崩溃报告）、`A-4.6-06`（动态取色）、`A-4.6-07`（电池优化→开机自启）。

### 9.4 风险预警（M5 是风险最集中的一段）

| 风险 | 说明 |
|---|---|
| **SmartScreen** | 未签名 exe 首次运行弹“Windows 已保护你的电脑”。需点「更多信息→仍要运行」。文档配截图说明；正式公开分发建议买代码签名证书（U5）。**不要对用户说“任何电脑都行”**。 |
| **Defender 误报** | `yt-dlp.exe` 是 PyInstaller 打包，易误报。文档说明是误报、给添加排除项的路径。 |
| **UCRT / VC++** | Win10+ 原则上自带；BtbN shared 自带 DLL。**必须在干净虚拟机实测（U7）**，有缺口就在 NSIS 附运行库再分发组件。 |
| **体积** | 安装后约 **500–700MB**（Electron 150–200MB + yt-dlp 20–40MB + node 35–45MB + FFmpeg 150–200MB）。这是零依赖自包含的直接代价，甲方已知悉。 |
| **LGPL 合规** | 见 §9.1 第 4 条 + D-08。**“关于”框必须有声明**（§12.5 第 7 条），这是硬性验收项。 |
| **系统版本** | Win10(1809+)/Win11 x64；**不支持 Win7/8/8.1**；32 位不提供；ARM64 需另出包。 |

---

## 10. 团队协作建议（可选，但建议沿用）

M1/M2 用的是标准 SOP（产品 → 架构 → 工程 → QA），效果好。若继续用团队模式：

| 阶段 | 角色 | 职责 |
|---|---|---|
| 产品 | 许清楚 | 增量 PRD + 断言映射（M3 已有映射表，只需细化） |
| 架构 | 高见远 | 增量设计 + 分批施工单（基于**实际代码**，不要照抄旧文档） |
| 工程 | 寇豆码 | 分批实现，每批跑通验证再进下一批，每批一个 commit |
| QA | 严过关 | **证伪视角**：独立重跑、反例测试、进程快照、连跑 N 次、查恒真兜底 |

**主理人（交付总监）要点**：
- 所有跨成员信息经主理人中转，不许成员直连；
- **质量关卡**：工程完成必须 `IS_PASS`；QA 判 FAIL 就派回工程修，最多 2 轮；
- 每个里程碑**停下汇报**，甲方放行才进下一个；
- 团队卡顿/超时时主理人主动接管降级交付，不频繁打扰用户。

**里程碑汇报模板**（HANDOFF §8）：
```
## M? 汇报
- 完成了什么：
- 改了哪些文件（列出路径）：
- 如何运行（命令）：
- 如何验收（命令 + 实际输出摘要 + acceptance-report 链接）：
- 矩阵项 → 断言 ID 对照表（本里程碑覆盖的部分）：
- 剩余 / 阻塞 / 偏离本任务书的决定（写入 DECISIONS.md）：
- 停下声明：未获甲方放行，不进入 M?
```

---

## 11. 已知偏离与未决事项

### 11.1 DECISIONS 条目索引（D-01…D-29，详情见 `docs/DECISIONS.md`）

| 编号 | 内容 |
|---|---|
| D-01 | U3 顺序前置（B0 下载 / B1 前实测） |
| D-02 | 覆盖率口径：M1/M2 取 ≥70%，后续收敛 80% |
| D-03 | corepack 补齐 pnpm 9.15.9 |
| D-04 | 断言 ID 稳定性约定（不改号） |
| D-05 | 二进制不入库 |
| D-06 | BtbN `latest` tag 选择（manifest 记录实际 tag） |
| D-07 | manifest 路径不含 `win-x64` 层 |
| **D-08** | **FFmpeg 实际是 LGPL-3.0，非 2.1+；M5 文案必须改** |
| D-09 | libopenh264 编码器结论（fixture 用 H.264） |
| D-10 | Core 接口 I 前缀命名（避免 TS2308） |
| D-11 | 覆盖率阈值恒定作用于本次测量集合、无定向豁免 |
| D-12 | Windows `.cmd` 垫片下 toolVersions 用 argv[] 直调 |
| D-13 | U3 顺序下 B3 正式化 manifest |
| D-14 | 相对 106 清单的辅助文件增补 |
| D-15 | M1 QA 五项修复（门控/证据链） |
| D-16…D-26 | M2 各项决定（多流进度留 M3、并发留 M4、A-4.6-02 只到端口契约等） |
| D-27 | M2 QA 四项修复 |
| D-28 | P3 三条留痕（C11 恒 SKIP、ffmpeg 孤儿未压测、fake-engine 断言放松） |
| **D-29** | **`runVitestGuarded` 环境适配**（safe-delete 限制）。**必须持续受反例测试监督** |

### 11.2 未决事项（HANDOFF §5.4 U1–U8 + QA 新发现）

| 编号 | 内容 | 归属 |
|---|---|---|
| U1 | Seal main 具体 commit hash 未核实 | 记录快照版本 `2.0.0-alpha.5` 即可 |
| U2 | `yt-dlp-ejs` 独立仓库 404 | 依赖官方 exe 内置组件 |
| U3 | generic extractor 对本地直链 | ✅ **SUPPORTED**（已解决） |
| U4 | FFmpeg LGPL 是否含 libmp3lame | M2 实测有；`ffmpeg -encoders` 有 `libopenh264`，无 `libx264` |
| U5 | 甲方是否持有代码签名证书 | 不阻塞；M5 文档写明 SmartScreen 处理 |
| U6 | Seal 部分 UI 细节 | 按 §6.8 重新设计，不要求像素级复刻 |
| U7 | 干净 VM 是否需 UCRT/VC++ | **M5 C13 实测** |
| U8 | `--ffmpeg-location` 支持性 | ✅ **支持 = YES**（已解决） |
| N-1 | `YTVDLT_COVERAGE_INCLUDE` 环境变量级信任边界 | ✅ 已封（M2 B0） |
| N-2 | 单 commit 无法 diff 审计 | ✅ M2 起每批提交 |
| N-3 | `durationMs` 按步骤共享口径 | 已注明 |
| N-4 | `reports/`+`coverage/` 不入库 | M5 交付时单独打包归档 |
| P3 | C11 恒 SKIP / ffmpeg 孤儿未压测 / fake-engine 断言放松 | 见 D-28，M3 处理 |
| **R2-1** | **`runVitestGuarded` 陈旧结果文件可骗过守卫**（exit 1 + guard 标记 + 不写结果 → 被上一轮绿结果误判为环境中断）；且不复核覆盖率 | **M3 首批必修**（§2.2.1），修完用反例复验，否则 M3 全绿不可信 |
| R2-2 | 恒等三元表达式（P3，代码整洁） | 顺手清理 |
| **P3-5** | **断言粒度缺口**：某个测试文件的失败不落在任何一条断言的文件名模式里，单条断言层看不到它（只能靠全局 `M2-GATE-vitest` 兜住）。不是放水，但会漏报细节 | M3 把每个测试文件都映射到至少一条断言，或补一条“全量测试文件计数”断言 |

---

## 12. 文件地图（快速索引）

| 想找什么 | 去哪 |
|---|---|
| 唯一权威需求 | `C:/Users/leolee/WorkBuddy/2026-11-05-07-24-49/YTVDLT_HANDOFF.md` |
| 断言 ID ↔ 矩阵项 | `docs/PRD-M1.md` §3 |
| M1 施工细节 | `docs/ARCHITECTURE-M1.md` |
| M2 施工细节（下载 argv、C1–C12、状态机） | `docs/ARCHITECTURE-M2.md` §4 |
| M1/M2 汇报数据 | `docs/M1-REPORT.md` / `docs/M2-REPORT.md` |
| 独立复验证据 | `docs/M1-QA-VERIFICATION.md` / `docs/M2-QA-VERIFICATION.md` |
| 全部偏离决定 | `docs/DECISIONS.md` |
| 验收结果（机器可读） | `reports/acceptance-report-m1.json` / `-m2.json` |
| 错误码 | `packages/shared/src/errors.ts` |
| 引擎接口 | `packages/shared/src/engine.ts` |
| 端口定义 | `packages/shared/src/ports.ts` |
| probe/download argv | `packages/engine-ytdlp/src/argv-builder*.ts` |
| 进度解析 | `packages/engine-ytdlp/src/progress-parser.ts` |
| 完整性校验 | `packages/core/src/artifact-verifier/` |
| 任务状态机 | `packages/core/src/task-queue/` |
| 历史存储 | `packages/core/src/history-store/` |
| 运行时自检 | `packages/core/src/runtime-resolver/` |
| 验收脚本 | `scripts/acceptance.mjs` |
| 测试入口 | `npm test` / `tests/` |
| 随包运行时 | `resources/runtime/win-x64/` |

---

## 13. 开工 M3 的第一件事

1. 跑 §4 的复跑命令，确认基线仍绿（`npm test` + 两个 acceptance + check-runtime + check-layering）。
2. 读 `docs/M2-QA-VERIFICATION.md` 的二轮章节，确认 M2 复验结论是 PASS（若 PASS-WITH-ISSUES，先处理遗留项）。
3. 读 `docs/ARCHITECTURE-M2.md` §4（下载 argv 顺序表）——M3 要在此基础上扩展。
4. 读 HANDOFF §4.2/4.3/4.4 的完整表格——这是 M3 的需求原文。
5. 按 §7.4 的批次开始 B0（增量设计），**不要直接写代码**。
6. 任何偏离写 `docs/DECISIONS.md`，编号续 D-30 起。
7. **要联网时先告诉用户**（L3 在线烟测在 M5，但下载运行时/依赖变更也可能要联网）。

---

*本文档由 M1/M2 的交付过程整理而成。接手者若发现与实际代码不符，以**实际代码 + `git log`** 为准，并更新本文档对应小节。*
