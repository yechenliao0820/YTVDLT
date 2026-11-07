# YTVDLT · M2 独立 QA 复验报告（证伪视角）

> 复验人：严过关（Yan）· QA 工程师 ｜ 日期：2026-11-05
> 复验对象：工程师 M2 交付（自报 `IS_PASS: YES`、37/37 断言 + 4/4 gate、六条验收全 PASS、M1 基线 17/17 未破、6 个增量提交，末提交 `a5d86c4`）
> 权威输入：`docs/ARCHITECTURE-M2.md`（1019 行）、`docs/M2-REPORT.md`、`docs/DECISIONS.md` D-16…D-26、`reports/acceptance-report.json`
> 方法：只读 + 跑命令 + 独立探针；**不信自报，只信我自己的执行证据**
> 证据目录：`reports/qa-evidence-m2/`（18 份原始日志/JSON）

---

## 0. 复验结论

| 项 | 结论 |
|---|---|
| **M2-VERDICT** | **FAIL** |
| 唯一失败原因 | **验收门不可复现**：`node scripts/acceptance.mjs --milestone M2` 我实跑 **4 次，3 次红（34/37，exit 1）**，只有 1 次 37/37 → 「37/37 全绿」不是稳定属性，而是**运气好的一次采样** |
| 失败断言 | 固定 3 条，全部绑定 `download-local`：`A-4.2-06` / `A-4.4-07` / `A-M2-07` |
| 失败根因 | `tests/integration/offline/download-local.test.ts:51` 的 `expect(progresses.some((e) => e.etaSec !== null)).toBe(true)` **在小文件快速下载时天然不成立**（见 §1.3 探针实测：一次下载只产生 2 条进度行，`0.3% → eta=0`、`100% → eta=null`） |
| **产品功能** | **实质通过**：六条验收涉及的 5 个 L2 用例我单独跑 **6/6 全绿**，真实 `yt-dlp.exe` + 真实下载 + 真实 C1–C12 + C12 时序实测成立 |
| 37 条断言 | 我的实测：**34 PASS / 3 FAIL**（工程师报 37/37） |
| C1–C12 | 我独立复现 **10 PASS + 2 SKIPPED（C8 无后处理 / C11 无历史入口）**，0 FAIL |
| 覆盖率（我独立复算） | **lines 93.07% / branches 85.42% / functions 94.27% / statements 93.07%**（最低 85.42%），与自报**逐位一致** |
| M1 基线 | **未破**：`acceptance --milestone M1` → 17/17 + 5/5、exit 0 |
| 阻塞级问题 | **2 个（P1-1 验收门不可复现；P1-2 跑 M1 验收会静默削弱 M2 证据）** |
| 非阻塞问题 | 5 个（P2×2 / P3×3） |
| 是否建议放行 M3 | **暂不放行**：P1-1（验收门 flake）+ P1-2（M1 验收削弱 M2 证据）两个 P1 修完即可，改动均在脚本/测试侧，我可在 15 分钟内复验 |

**一句话**：M2 的**产品实现是真的**（真实子进程下载、真实进度、真实取消、真实 C1–C12、真实历史去重，我逐条独立复现）；但**验收门是坏的**——官方验收命令四次里三次红，`37/37` 不可复现。以现有测试状态，M2 不能作为 M3 基线。

---

## 1. 「假绿」排查（7 条，逐条给结论与代码行）

### 1.1 `acceptance.mjs --milestone M2` 是真解析还是硬编码？→ **真解析，无恒真兜底**

```js
// scripts/acceptance.mjs:229-250 —— 37 条状态全部由真实产物推导
const items = M2_ASSERTIONS.map((def) => {
  let status = 'FAIL'; ...
  if (def.kind === 'test') { const c = testCount(def.test); status = testOk(c) ? 'PASS' : 'FAIL'; }
  else if (def.kind === 'l2') { status = l2Ok(def.case) ? 'PASS' : 'FAIL'; actual = `case ${def.case} exit=${l2[def.case]?.exitCode ?? 'missing'}`; }
  else if (def.kind === 'artifact') { status = c12Ok ? 'PASS' : 'FAIL'; }
```
```js
// scripts/acceptance.mjs:216-220 —— 分层判定沿用 M1 修复后的严格三态，无 || exists() 兜底
const violations = layering === null ? null : Array.isArray(...) ? ... : null;
const layeringZero = violations === 0;
```
```js
// scripts/acceptance.mjs:192-197 —— L2 五条用例真的逐个 spawn，退出码写盘
for (const name of M2_L2_CASES) {
  const r = spawn([join(ROOT,'scripts','run-tests.mjs'), 'integration', '--case', name]);
  l2[name] = { exitCode: r.status ?? 1 };
```
- 全库搜 `|| true` / `?? true` / `exists(` / 空 `catch` 兜底：**M2 判定链无恒真兜底**（唯一 `catch` 是 `readJson` 解析失败返回 `null`，会让 `l2Ok`/`c12Ok` 判 FAIL，方向正确）。
- **但**：`kind:'test'` 的 22 条仍是 **"该测试文件跑了 >0 例且 0 失败"的存在性判定**（同 M1 P3-2），聚合层不理解断言语义。语义正确性我已人工逐条对照（§3），**实质成立**。
- **实测反证**：正因为是真解析，我的运行才会红 —— `§0` 的 34/37 就是它如实反映了 `download-local` 的失败。**这条排查我给"真解析"的正面结论，同时也正是它抓出了工程师的假绿。**

### 1.2 L2 用例是否真 spawn `yt-dlp.exe`？有无 mock 掉引擎/端口/用 FakeEngine 冒充？→ **全部真实**

- `tests/integration/helpers/l2-harness.ts:93-113`：`createNodePorts({...runtimeDir: RUNTIME})` —— 用的是**生产适配器**（真 `spawnStreaming` / 真 `taskkill` / 真 fs），不是假端口；`new YtDlpEngine({ ports, enginePath: YTDLP, jsRuntimePath: NODE_EXE })` 指向 `resources/runtime/win-x64/yt-dlp.exe`。
- 四个用例逐个读过：`download-local` / `cancel-local` / `retry-local` / `artifact-local` 都走 `ctx.queue.enqueue(...)` 或 `ctx.engine.download(...)`，**无一处 `FakeEngine`、无一处 mock ProcessPort**。
- 行为证据：单跑耗时 `download-local 4410ms` / `cancel-local 6169ms` / `retry-local 20764ms` / `artifact-local 2502ms`，与 20KB/s 限速 + 真实 ffprobe/ffmpeg 的预期量级吻合；`artifact-local` 现场生成 `reports/artifact-verification.json`（`durationMs` 341ms，含真实 ffprobe 输出）。

### 1.3 取消是否真发生在下载中？限速是否真限速？→ **是**（附我自己的进度探针）

- `cancel-local.test.ts:26-34`：先等 `sawProgressBelow100`（收到 `percent<100` 的进度）才 `await handle.cancel()`，并等 `canceled` 事件；**不是**盲等固定时长。
- `mock-server.ts:73-91` 的限速是**真的按块 sleep**：`chunkSize = rate/10`，`setTimeout(pump, 100)` 循环 → 有效速率 = rate B/s；`RATE=20480` → 308666 B ÷ 20480 ≈ **15.1 s** 的理论时长，与实际 `cancel 2.4s / retry 20.8s` 量级一致。**不是**在测试里 `sleep` 假等。
- **我自己加的探针**（临时测试，跑完即删，`git status` 已确认干净）打印了一次真实下载的全部进度事件：

```
[QA-PROGRESS] count = 2
[QA-PROGRESS] #0 percent=0.3 speed=935722.7224400871 eta=0
[QA-PROGRESS] #1 percent=100 speed=15197612.763262 eta=null
```
  证据：`reports/qa-evidence-m2/11-progress-probe.log`。**这既证明进度事件真的来自 yt-dlp stdout 解析，也直接暴露了 §0 的 flake 根因**：不限速时一次下载只有 2 条进度行，唯一带 ETA 的中间行 ETA 值是 `0`，终态行 `%(progress.eta)s` 是 `NA` → `null`。

### 1.4 无残留进程是否真验？→ **测试断言 + 我的独立进程快照双证：无残留**

- 测试内断言：`cancel-local.test.ts:39` `expect(await ctx.ports.process.isAlive(pid)).toBe(false)`。
- **我自己的快照**（PowerShell `Get-Process`，不是看测试自报）：
  - 跑前：`BEFORE: NO-PROCESS`
  - 跑完 `cancel-local`（2 例全绿、6169ms）后 800ms：`AFTER: NO-PROCESS (no residual yt-dlp/ffmpeg/ffprobe)`
- **诚实边界**：本 fixture 是单一 `mp4` format，下载过程中**不会启动 ffmpeg 子进程**，因此这次快照"无 ffmpeg 孤儿"是**平凡成立**，并未真正压测"ffmpeg 子进程被 taskkill /T 连带杀掉"这条路径。该路径只在分离流合并场景出现，M2 无此 fixture → 记为观察项 O-3（不判 FAIL，但"M2 已证明无 ffmpeg 孤儿"这句话**不成立**）。

### 1.5 `.skip` / `.todo` / `only`？`fileParallelism:false` 是否生效？→ **0 命中；配置在**

- `grep -rnE "\.skip\(|\.todo\(|xit\(|xdescribe\(|it\.only|describe\.only" tests/` → **0 命中**。
- `vitest.config.ts:50` `fileParallelism: false`（M2 §7.3 要求 L2 串行）；L2 五文件同跑耗时 ≈ 34s ≈ 各用例耗时之和，无并发叠加迹象。

### 1.6 覆盖率是否只认全量？定向豁免是否回潮？→ **只认全量；`targetedRun` 仍 0 命中**

- `grep -rn targetedRun scripts/ vitest.config.ts` → **0 命中**；`thresholds` 恒为 `70×4`（`vitest.config.ts:67-72`）。
- 我的全量实测（26 文件 / 207 例）：**93.07 / 85.42 / 94.27 / 93.07**，最低 85.42%，与自报**逐位一致**。
- `npm test`（21 文件 / 201 例，L0+L1）：92.79 / 84.70 / 93.75 / 92.79，exit 0。

### 1.7 N-1（覆盖率 scope 信任边界）修复是否成立？→ **成立**

- 实现改为「一次性 scope 文件 + 随机 nonce 双因子」，且 `run-tests.mjs` 会主动 `delete` 调用方传入的旧变量：

```js
// scripts/run-tests.mjs:141-144
delete childEnv['YTVDLT_COVERAGE_INCLUDE'];
delete childEnv['YTVDLT_COVERAGE_SCOPE'];
delete childEnv['YTVDLT_COVERAGE_NONCE'];
```
- **我的实测**：设置旧变量 `YTVDLT_COVERAGE_INCLUDE=packages/engine-ytdlp/src/engine-factory.ts` 后跑全量 →
  `EXIT=0`、**measured files = 31（全量，未被收窄）**、`engine-factory 在测量集合内 = true`、四维 93.07/85.42/94.27/93.07。
  证据：`reports/qa-evidence-m2/07-n1-probe.log`。**旧后门已封**。

---

## 2. 六条验收 —— 逐条证伪

| # | 验收标准 | 我的执行 | 实测结果 | 判定 |
|---|---|---|---|---|
| ① | 真实下载：产物 308666 B、sha256 = fixture；路径来自清单非目录扫描 | `--case download-local`（单跑 6 次全绿）＋读 `yt-dlp-engine.ts:166-276` | 单跑 **6/6 PASS**：sha256 = `1db5d565…6d04b`、size 308666、history 恰 1 条且 `videoPath === 产物`；代码层**先 `unlink` 旧清单**（`yt-dlp-engine.ts:176`）、完成后**只读 `--print-to-file` 清单**（`:245-248`），`paths.length===0` 时抛 `ARTIFACT_INCOMPLETE` 而**不做目录扫描** | **PASS（单跑）/ 门控不稳（套件内）** |
| ② | 进度含 %/速度/ETA 且递增 | 探针 dump 原始进度事件（§1.3）＋单跑 | percent 单调且末值 100 ✓、`speed>0` ✓；**`etaSec` 不保证有值**：不限速下载只 2 条进度行，`eta` 分别是 `0` 与 `null` → 断言 `some(etaSec!==null)` **本质 flaky**，这正是套件内 5/8 次失败的原因 | **FAIL（证据不可稳定成立）** |
| ③ | 取消无残留、`.part` 保留 | `--case cancel-local`（6169ms，2 例）＋我的进程快照 | 状态 `Canceled` ✓、`lastPercent>0` ✓、history 为空 ✓、`.part` 存在 ✓、`isAlive(pid)===false` ✓；**我的快照：跑前 NO-PROCESS → 跑后 NO-PROCESS** | **PASS**（ffmpeg 孤儿路径未覆盖，见 O-3） |
| ④ | 重试续传，最终 sha256 **严格等于**一次性下载 | `--case retry-local`（20764ms） | 取消（`.part` 保留）→ 续传完成 → `finalSha === manifest.sha256`（严格相等）✓、size 相等 ✓、`.part` 已清理 ✓ | **PASS** |
| ⑤ | C1–C12 | `--case artifact-local` + `verify-artifact.mjs` 两模式 + 读 criteria 实现 | 真实下载后真跑 12 条判据：**10 PASS + C8/C11 SKIPPED，0 FAIL**（明细见 §4）；`--postprocessed` 模式下 C2→SKIPPED、C8 生效（framemd5 真跑） | **PASS**（2 条 SKIPPED 的接受理由见 §4.3） |
| ⑥ | 历史唯一 | `--case download-local` + `history-store.test.ts` | `history.query({})` **恰 1 条**、`videoPath === artifact`、磁盘存在 ✓；去重由 `A-M2-20 · dedupe by videoPath`（含不同路径拼写的重复 add）+ `import 去重` 单测覆盖 | **PASS**（依赖 ① 的用例；一旦 ① 在套件内红，⑥ 的聚合断言也红） |

**小结**：六条验收的**功能**我都独立复现成立（①②③④⑤⑥ 在单跑时全绿）；但 ② 的**证据链不稳定**，导致绑定它的 3 条断言在官方验收命令下高频变红。

---

## 3. 37 条断言 —— 我的实测结果（34 PASS / 3 FAIL）

> 状态取自**我本轮实跑**的 `reports/qa-evidence-m2/16-acceptance-m2-report.json`（`node scripts/acceptance.mjs --milestone M2`，exit 1）。工程师自报 37/37；差异就在下面 3 条。

| # | 断言 ID | 层 | 我的判定 | 我的实测 actual | 语义核对（我读测试确认） |
|---|---|---|---|---|---|
| 1 | A-4.2-06 | L2 | **FAIL** | `case download-local exit=1` | 绑定 download-local；本身 C6 流完整性由 artifact-local 实测 PASS |
| 2 | A-4.4-05 | L2 | PASS | `case cancel-local exit=0` | `.part` 保留实测成立 |
| 3 | A-4.4-06 | L0 | PASS | 13 tests, 0 failed | history-store 去重 |
| 4 | A-4.4-07 | L2 | **FAIL** | `case download-local exit=1` | 绑定 download-local（唯一被 ② 拖红的用例） |
| 5 | A-4.4-08 | L0 | PASS | 13 tests, 0 failed | history query/filter |
| 6 | A-4.4-11 | L1 | PASS | 12 tests, 0 failed | progress-parser 递增 |
| 7 | A-4.4-12 | L1 | PASS | 12 tests, 0 failed | speed/eta 结构化 |
| 8 | A-4.4-13 | L0 | PASS | 15 tests, 0 failed | 取消语义 |
| 9 | A-4.4-14 | L2 | PASS | `case retry-local exit=0` | 续传实测成立 |
| 10 | A-4.4-22 | L0 | PASS | 13 tests, 0 failed | 隐私模式不写历史 |
| 11 | A-4.5-06 | L0 | PASS | 13 tests, 0 failed | ALREADY_DOWNLOADED |
| 12 | A-4.6-02 | L0 | PASS | 4 tests, 0 failed | IShellPort argv 契约 |
| 13 | A-M2-01 | L0 | PASS | 15 tests, 0 failed | 49 组合遍历实存（见 §6.3） |
| 14 | A-M2-02 | L2 | PASS | `case cancel-local exit=0` | spawnStreaming/isAlive |
| 15 | A-M2-03 | L2 | PASS | `case cancel-local exit=0` | taskkill /T 杀树 |
| 16 | A-M2-04 | L0 | PASS | 12 tests, 0 failed | 清单解析 |
| 17 | A-M2-05 | L0 | PASS | 12 tests, 0 failed | 进度解析容错 |
| 18 | A-M2-06 | L0 | PASS | 12 tests, 0 failed | percent 三档回退 |
| 19 | A-M2-07 | L2 | **FAIL** | `case download-local exit=1` | **speed/eta 有值** ——就是它挂了 |
| 20–28 | A-M2-08 … A-M2-16 | L1 | PASS | 34 tests, 0 failed（artifact-verifier 全 34 例） | C1/C2/C3/C4/C5/C6/C7/C8/C9 逐条有专测（含 C4「exit 0 + 非空 stderr 必 FAIL」反例、C5 null 降级、C2/C8 互斥） |
| 29 | A-M2-17 | L2 | PASS | `case retry-local exit=0` | C10 严格哈希相等 |
| 30 | A-M2-18 | L1 | PASS | 34 tests, 0 failed | C11 有单测（生产路径恒 SKIP，见 §4.3） |
| 31 | A-M2-19 | L2 | PASS | `case artifact-local exit=0` | C12 12 条无 FAIL |
| 32 | A-M2-20 | L0 | PASS | 13 tests, 0 failed | 同 videoPath 去重 |
| 33 | A-M2-21 | L0 | PASS | 13 tests, 0 failed | 隐私模式 |
| 34 | A-M2-22 | L0 | PASS | 4 tests, 0 failed | 快照恢复 |
| 35 | A-M2-23 | L2 | PASS | `case cancel-local exit=0` | 限速使取消可测（§1.3 已证真限速） |
| 36 | A-M2-24 | L2 | PASS | `ok=true criteria=12` | `reports/artifact-verification.json` 真实产物 |
| 37 | A-M2-25 | L0 | PASS | 12 tests, 0 failed | 下载 argv 冻结顺序 |

**计数：34 PASS / 3 FAIL / 0 SKIPPED**（工程师自报 37/37，不可复现）。

---

## 4. C1–C12 实测（我独立复现，0 FAIL）

### 4.1 我的实测矩阵（`reports/artifact-verification.json`，真实下载产物）

| 判据 | 我的判定 | 我的实测 detail |
|---|---|---|
| C1 产物存在非空 | **PASS** | 1 artifact(s) exist and are non-empty |
| C2 字节哈希 | **PASS** | byte-exact match with expected sha256 |
| C3 容器可解析 | **PASS** | ffprobe exit 0, stderr empty, JSON parsed |
| C4 全帧可解码 | **PASS** | full decode produced no stderr output |
| C5 时长一致 | **PASS** | duration within tolerance (0.00s ≤ 1.00s) —— **null 降级生效**：`expected:null` 时用了 `manifest.durationSec=10` |
| C6 流完整 | **PASS** | video artifact has both video and audio streams |
| C7 规格符合 | **PASS** | **measured specs match the selected format** —— 见 §4.2，**不是**"只记录" |
| C8 逐帧一致 | **SKIPPED** | no post-processing; C2 is authoritative（纯下载，符合设计） |
| C9 附带产物 | **PASS** | no attached artifacts declared（平凡成立，记录型） |
| C10 续传一致 | **PASS** | resumed download matches the one-shot hash |
| C11 历史一致 | **SKIPPED** | no history entry supplied to verification —— 见 §4.3 |
| C12 无假完成 | **PASS** | no failing criterion |

### 4.2 三条容易误判的判据，我逐条查了实现与测试

- **C4 只判 stderr、不看 exit code**：`criteria.ts:181-191` 仅以 `stderr.trim() === ''` 定成败；反例单测：`artifact-verifier.test.ts:155` 「FAILs on exit 0 + NON-EMPTY stderr（the classic 误判）」、`:162`「PASSes when stderr is empty even if exit code is non-zero」。**成立**。
- **C5 null 降级**：`criteria.ts:199` `ctx.expected?.duration ?? ctx.expectedManifest?.durationSec`；`actualDuration===null` 才 FAIL（产物本身无时长，属真实缺陷），`expectedDuration===null` 走 SKIP。单测 `:179` 「DEGRADES to expectedManifest.durationSec when MediaInfo.duration is null」、`:185`「SKIPs (never FAILs) when both unknown」。**成立**，且我 L2 实测 C5 = PASS（delta 0.00s）。
- **C2/C8 动态二选一**：我跑了两种模式（`reports/qa-evidence-m2/04-verify-pure.json` / `05-verify-postprocessed.json`）：
  - 纯下载：`C2=PASS C8=SKIPPED`
  - `--postprocessed`：`C2=SKIPPED（reason: post-processed output changes bytes; C8 is authoritative） C8=SKIPPED（reason: no golden framemd5 recorded yet）`，且 C10 同步 SKIP。**互斥逻辑成立**。
- **C7 不是"只记录"**：`tests/fixtures/manifest.json` 里 `expectedFormat={width:320,height:240,vcodec:"h264"}`，我的实测 detail 是 "measured specs match the selected format"，即**真做了 width/height/vcodec 比对**；单测另有 mismatch 分支（`artifact-verifier.test.ts:225`）。→ 我在给 team-lead 的预判清单里看到的"C7 可能只是部分覆盖"的疑虑**被证伪**，C7 是完整实现。

### 4.3 两条 SKIPPED 的接受/拒绝理由

| 判据 | SKIPPED 原因 | 我的裁定 | 理由 |
|---|---|---|---|
| **C8** | 本次是纯下载（无 remux/转码），字节会变才需要逐帧哈希 | **接受** | 设计如此（D-19），且 `--postprocessed` 模式下我实测 C8 会被激活并真跑 framemd5；`c8Golden` 尚未录制属 O-M2-02 已登记观察项 |
| **C11** | `historyEntry: null` | **接受，但标记为结构性缺口（P3）** | 生产路径 `task-queue.ts:156` 传 `historyEntry: null`（因为校验发生在写历史**之前**，C12 铁律），所以 **C11 在生产链路上永远 SKIP**。验收⑥"历史路径真实存在且唯一"的证据实际由 `download-local`（history 恰 1 条 + 路径 === 产物 + 磁盘存在）与 `history-store` 单测（去重/持久化/导入去重）承担 —— 这部分**证据充分**，故不判验收⑥失败；但"C11 被验证过"这句话**不成立**，建议 M3 改为"写历史后回查"或把 C11 改成基于预期路径的判据 |

**C1–C12 结论：10 PASS + 2 SKIPPED（理由均成立），0 FAIL。**与自报一致，且我逐条核了实现与反例单测。

---

## 5. 独立重跑与「不可复现」证据链

### 5.1 关键复现数据（`download-local` 是唯一不稳定点）

| 执行上下文 | 次数 | 失败次数 | 结论 |
|---|---|---|---|
| 单跑 `npm run test:integration:offline -- --case download-local` | 6 | **0** | 单跑稳定绿 |
| 全套件 / 验收上下文（`vitest run --coverage` 全量、`acceptance M2` 的 L2 阶段） | 8 | **5** | **~62% 概率红** |

失败点固定在同一行：`tests/integration/offline/download-local.test.ts:51`
`AssertionError: expected false to be true` → `expect(progresses.some((e) => e.etaSec !== null)).toBe(true)`。

### 5.2 官方验收命令实测（4 次）

| 次 | 时间 | 结果 | 退出码 | 证据 |
|---|---|---|---|---|
| 1 | 13:44 | **34/37**，`download-local exit=1` | **1** | `08-acceptance-m2.log` |
| 2 | 13:46 | 37/37（**唯一一次绿**） | 0 | 见 5.3 说明 |
| 3 | 13:47 | 全量 vitest 阶段就红（`vitest failed`，download-local 同一行） | **1** | `09-acceptance-m2-run2.log` + `reports/vitest-results.json` |
| 4 | 14:0x | **34/37**，三条 FAIL 全部 `case download-local exit=1` | **1** | `16-acceptance-m2-run4.log` |

失败的三条恒定是：`A-4.2-06`、`A-4.4-07`、`A-M2-07`（全部 `kind:'l2'` 绑定 `download-local`）。

### 5.3 关于"唯一一次 37/37"的诚实说明

13:46:48 那次生成了 `allGreen=true / 37/37` 的报告。我无法用日志还原它的完整 stdout（该次运行在沙箱升级重试的上下文里执行，日志被后一次执行覆盖），但它恰好证明：**同一命令有时绿有时红 → 非确定性**。工程师自报的 37/37 属于这一类采样，不是稳定属性。

### 5.4 其他重跑（均为我实跑）

| 命令 | 退出码 | 实测 |
|---|---|---|
| `npm test` | **0** | 21 文件 / **201 例**全绿；92.79 / 84.70 / 93.75 / 92.79 |
| `pnpm exec vitest run --coverage`（干净那次） | **0** | 26 文件 / **207 例**全绿；**93.07 / 85.42 / 94.27 / 93.07** |
| `npm run check-runtime` | **0** | 3 必需 OK + aria2c OPTIONAL |
| `node scripts/check-layering.mjs` | **0** | 0 violations |
| `node scripts/acceptance.mjs --milestone M1` | **0** | **17/17 + 5/5**，min 85.42% |
| `node scripts/acceptance.mjs --milestone M2` | **1** | **34/37 + 4/4 gates**，min 85.47% |
| N-1 探针（旧 env 变量） | **0** | 31 文件全量测量，旧后门无效 |
| C12 探针（我写的临时测试，已删） | **0** | `state=Error`、`error=ARTIFACT_INCOMPLETE`、`history=0` |

### 5.5 C12 时序（我自己构造 verify 失败）

我写了一个**临时** L2 测试（`qa-c12-tmp.test.ts`，跑完立即删除，`git status` 已确认工作区干净），用**错误的期望 sha256** 让真实下载的产物 C2 失败：

```
[QA-C12] final state = Error
[QA-C12] error code = ARTIFACT_INCOMPLETE
[QA-C12] history entries = 0
 ✓ 1 passed (4419ms)
```
证据：`reports/qa-evidence-m2/06-c12-probe.log`。→ **`history.add()` 与 `Completed` 严格在 `verify().ok===true` 之后**（代码 `task-queue.ts:148-182`），`verify` 失败时**不写历史、不置 Completed**。**成立。**

### 5.6 【新发现 P1-2】跑 M1 验收会**静默削弱 M2 证据**：`u3-verify.mjs` 会覆盖 `tests/fixtures/manifest.json` 并删掉 `expectedFormat` / `c8Golden`

这是我在还原工程师产物时偶然发现的，随后**定向复现确认**：

```
$ git status --porcelain
 M tests/fixtures/manifest.json          ← 我没改过它
$ git diff tests/fixtures/manifest.json
-  "expectedFormat": { "formatId": "0", "ext": "mp4", "vcodec": "h264", ... "width": 320, "height": 240 },
-  "c8Golden": null
+  "note": "... (see DECISIONS.md O-02)."     ← 只剩旧字段
$ grep -c expectedFormat tests/fixtures/manifest.json
0
```
**因果验证**（先 `git checkout` 还原 → 再单跑 → 文件再次被降级）：
```
$ git checkout -- tests/fixtures/manifest.json && node scripts/u3-verify.mjs --json; echo $?
0
$ git status --porcelain tests/
 M tests/fixtures/manifest.json
$ git diff --stat tests/fixtures/manifest.json
 1 file changed, 1 insertion(+), 10 deletions(-)      ← expectedFormat / c8Golden 被删
```
**根因**：`scripts/u3-verify.mjs:172-186` 用**硬编码对象**重写 `tests/fixtures/manifest.json`，该对象只有 M1 时代字段，**不含 M2 新增的 `expectedFormat` / `c8Golden`**。而 `acceptance.mjs --milestone M1` 的采集阶段会调用 `u3-verify.mjs`（M1 证据链必需）。

**后果（静默、且方向是"变绿"）**：
1. `expectedFormat` 被删后，`criteria.ts:255-258` 走 "no explicit format selection → record-only PASS" 分支 → **C7 从"真比对"降级为"只记录"，仍判 PASS**。这正是团队此前怀疑"C7 是不是只验证了能取到宽高"的**真实来源**。
2. `c8Golden` 被删后，C8 永远只能 SKIPPED。
3. 于是**"M1 验收跑一次，M2 的证据就弱一档"**，而且不报错、不告警。

**我这次为什么还能看到 C7 真比对**：`artifact-local` 在我跑 M1 回归之前执行，当时 manifest 还是完整的（C7 detail = "measured specs match the selected format"）。跑完 M1 回归后 manifest 就被降级了 —— 幸好我做了 `git status` 检查。

**修复建议**：`u3-verify.mjs` 重写 manifest 时**保留未知键**（读旧文件 → 浅合并 → 写回），或把 `expectedFormat`/`c8Golden` 模板化；并加一条守卫测试：「跑 u3-verify 后 manifest 仍含 expectedFormat」。

---

## 6. 边界与提交审计

### 6.1 6 个 M2 提交都在，且每批一个

```
a5d86c4 feat(m2): B5 M2 acceptance gates (37 assertions) + M2-REPORT + DECISIONS D-26
615da08 feat(m2): B4 YtDlpEngine.download() streaming + manifest artifacts + L2 …
fcbb0da feat(m2): B3 TaskQueue (7-state serial) + TaskStore + HistoryStore + shell argv contract
186ce92 feat(m2): B2 ArtifactVerifier C1-C12 + verify-artifact.mjs + media-tools
85b83e8 feat(m2): B1 buildDownload frozen argv + progress parser + artifact manifest
3bba355 feat(m2): B0 port extensions (spawnStreaming/isAlive/IShellPort), mock-server throttle, N-1 coverage scope, M1 regression
```
工作区 `git status` **clean**（我的两个临时探针已删除、报告在 `docs/`+`reports/` 下未提交）。

### 6.2 是否动了 M1 业务代码？→ **动了接口层，均为向后兼容的追加；M1 测试被"被迫"更新，未见放松**

| 文件 | 改动 | 我的判定 |
|---|---|---|
| `packages/shared/src/ports.ts` | +35（`spawnStreaming`/`isAlive`/`IShellPort` 等端口扩展） | 追加，M1 签名未变 → 兼容 |
| `packages/shared/src/{history,progress,task,verification}.ts` | 新增 DTO | 纯追加 |
| `packages/shared/src/{index,ipc}.ts` | +5 / +5 导出与 channel | 纯追加 |
| `packages/core/src/ports.ts` | +60（`ITaskQueue`/`IHistoryStore`/`IArtifactVerifier`/`ICancelHandle`） | 纯追加 |
| `apps/desktop/src/main/adapters/node-ports.ts` | +12（补新端口实现） | 追加 |
| `packages/engine-ytdlp/src/{engine-factory,fake-engine}.ts` | FakeEngine 增 `download()` 回放 | M1 的 `A-INF-10` 要求同接口，属必要演进 |
| `tests/contract/download-engine.contract.test.ts` | 把「`download()` 抛 UNKNOWN」改为「返回 CancelHandle」 | **合理**：M1 那是占位期望，M2 已实现，契约随之更新 |
| `tests/unit/fake-engine.test.ts` | 事件序列断言由 `toEqual([...])` 放宽为 `toContain('progress')` + 首尾断言 | **轻微放松**（因 FakeEngine 改为异步推事件），已记录为 O-2 |
| `vitest.config.ts` | coverage scope 机制（scope 文件 + nonce） | 提升安全性，阈值未变 |
| `packages/shared/src/ports.ts` 之外的 M1 core 逻辑（config/logger/error-mapper/runtime-resolver） | **未改动** | — |

**兼容性证据**：`acceptance --milestone M1` 仍 **17/17 + 5/5**、`check-layering` 0 违规、`check-runtime` exit 0。

### 6.3 状态机 49 组合是否真遍历

`task-queue.test.ts:144-153`：`allTransitions()` 取 49 对 → 断言 `legal.length===13`、`illegal.length===36`，且合法集逐条等于 `LEGAL_TRANSITIONS`；`:155-170` 对 49 对**逐条** `assertTransition`，非法必须抛 `IllegalTaskTransitionError` 并携带 `from/to`；`:172-175` 断言 `Completed` 无任何出边。**真遍历，非抽样。**

### 6.4 M2 边界完好

`packages/ui` 不存在；源码 `.tsx`/`.css` **0 个**；`shell: true` **0 命中**；`createWindow` 代码 **0 命中**；`--cookies-from-browser` / `--geo-bypass` / `no-check-certificates` 在 `packages/` 内**仅出现在 `logger/redactor.ts` 的拦截名单**（0 实现）。

---

## 7. 问题分级

### P1（阻塞，**测试侧**，非产品缺陷）

| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| **P1-1** | `tests/integration/offline/download-local.test.ts:51` 的 `expect(progresses.some((e) => e.etaSec !== null)).toBe(true)` 在小文件快速下载下**天然不可靠**，导致 `acceptance.mjs --milestone M2` 4 次里 3 次红、37/37 不可复现 | `08/09/16-acceptance-m2*.log`、`12-full-coverage-run{1,2}.log`、`11-progress-probe.log`（`eta=0` / `eta=null` 两条事件） | 验收门失去意义；"37/37 全绿"不能作为 M3 基线 |
| **P1-2** | `scripts/u3-verify.mjs:172-186` 用硬编码对象重写 `tests/fixtures/manifest.json`，**删掉 M2 新增的 `expectedFormat`/`c8Golden`**；而 `acceptance.mjs --milestone M1` 会调用它 → **跑 M1 验收就静默削弱 M2 证据**（C7 从真比对降级为 record-only 仍 PASS、C8 永远 SKIPPED） | `git status`→`M tests/fixtures/manifest.json`；定向复现：还原后单跑 `node scripts/u3-verify.mjs` 再次产生 `1 file changed, 1 insertion(+), 10 deletions(-)`；见 §5.6 | 静默、且方向是"变绿"，是最危险的一类假绿 |

**修复建议（1 处改动即可，不需动产品代码）**：给 `download-local` 的 `startMockServer` 传 `{ rateBytesPerSec: 40_960 }`（同 `cancel-local` 的做法），使 yt-dlp 在 ~8s 内产生 ≥8 条进度行，ETA 稳定有值；或把断言降级为「至少 1 条 progress 且 percent 单调至 100；`speed>0` 至少一次；`etaSec` **允许为 null**（契约本就允许 null）」。我倾向前者（更贴近真实网络形态）。

### P2（不阻塞功能，但需修）

| ID | 问题 | 证据 |
|---|---|---|
| **P2-1** | **`durationMs` 全面回退为 1ms**：M2 的 37 条断言 + 4 个 gate **全部** `durationMs=1`（M1 修好的 P3-1 在 M2 又退回去了）。原因：`acceptance.mjs:195` 把 `STEP_MS['l2:'+name]` 写死为 `1`，且 `runM2` 的 collect 分支没有给 `STEP_MS.vitest` 计时 | `16-acceptance-m2-report.json`：37/37 items + 4/4 gates 全为 1ms |
| **P2-2** | **M1 与 M2 的 acceptance 写同一个 `reports/acceptance-report.json`**：我跑完 M2（34/37）再跑 M1 回归，M2 的报告就被 M1 的报告覆盖了；两份基线无法共存 | 我实测：跑 M1 后 `reports/acceptance-report.json` 变为 `milestone:"M1"`；M2 证据只能从我的 `reports/qa-evidence-m2/16-acceptance-m2-report.json` 找回 |

### P3（建议改进）

| ID | 问题 | 证据 |
|---|---|---|
| **P3-1** | `download-local.test.ts:36` 存在**恒等三元** `expect(artifact).toContain('download-local-1'.length > 0 ? 'fixture' : 'fixture')`（两个分支同值），应为 `toContain('fixture')`；且它并不能证明"路径来自清单而非目录扫描"（该性质只能靠读实现 + C1 的 `.part` 排除间接证明） | 源码行 |
| **P3-2** | **C11 在生产链路永远 SKIPPED**（`task-queue.ts:156` 传 `historyEntry: null`），"C11 已验证"不成立；验收⑥证据实际由 download-local + history-store 单测承担 | `04/05/16` 报告 + 代码 |
| **P3-3** | `fake-engine.test.ts` 的事件序列断言由精确 `toEqual` 放宽为 `toContain`（O-2），属轻微放松，建议改为"最终序列的稳定快照" | `git show 615da08` |
| **P3-4** | L2 快照"无 ffmpeg 孤儿"是**平凡成立**（单 format 下载不启动 ffmpeg），未压测"ffmpeg 子进程被 /T 连带杀"路径 | 我的进程快照 + 下载 argv |

---

## 8. 是否放行 M3

**暂不放行（先修 P1-1 + P1-2，再复验一次）。**

- **不能放行的两个理由都很硬**：验收命令 `node scripts/acceptance.mjs --milestone M2` 在我手上 **4 次执行 3 次红**，"37/37 全绿"不可复现。若以此状态进入 M3，M3 每次都要面对一个 62% 概率变红的 L2 用例，且团队会逐渐习惯"红了重跑"——那等于把验收门废掉。
- **产品实现本身没有问题**：6 条验收的功能我逐条独立复现（真实下载 308666 B / sha 一致、进度递增、取消无残留且 `.part` 保留、续传严格同哈希、C1–C12 十通过两跳过、历史唯一），C12 时序我用注入失败实测过，M1 基线 17/17 未破，边界与合规约束全部完好。
- **修复代价极小**：`download-local` 加一行限速参数（或把断言改成契约允许 null 的写法）；顺手把 P2-1（durationMs 1ms）与 P2-2（M1/M2 报告分文件）修掉。
- 修完后我复验范围：`acceptance.mjs --milestone M2` 连跑 **3 次必须 3 次 37/37 + exit 0**，且 `durationMs` 无 1ms 占位；M1 仍 17/17。预计 15 分钟内可给结论。

---

## 9. 证据索引与复验边界

**我的产物**
- 本报告：`docs/M2-QA-VERIFICATION.md`
- 机器可读：`reports/qa-verification.json` → `m2` 段
- 原始证据（18 份）：`reports/qa-evidence-m2/`
  `01-npm-test.log`、`02-cancel-local.log`、`03-{download,retry,artifact}-local.log`、`04-verify-pure.json`、`05-verify-postprocessed.json`、
  `06-c12-probe.log`、`07-n1-probe.log`、`08-acceptance-m2.log`、`09-acceptance-m2-run2.log`、`10-l2-all.log`、`11-progress-probe.log`、
  `12-full-coverage-run{1,2}.log`、`13-check-runtime.log`、`14-layering.log`、`15-acceptance-m1.log`、`16-acceptance-m2-run4.log`、`16-acceptance-m2-report.json`、`16-assertion-table.txt`

**边界声明**
- 未改任何业务代码；两个临时探针测试（`qa-c12-tmp.test.ts`、`qa-progress-tmp.test.ts`）跑完**立即删除**，`git status` 已确认干净。
- `acceptance.mjs` / `check-runtime.mjs` 按设计会重写 `reports/*` 与 `coverage/`；我已把工程师原始 `reports/`+`coverage/` 备份到 `/tmp/qa-m2/backup/`，**复验结束后逐字节还原**。
- 未联网；L2 全部 `127.0.0.1`；未并行跑 L2（`fileParallelism:false`）。
- **未做**：M3+ 范围、UI、真实站点 L3、干净虚拟机打包（M5/C13–C16）、ffmpeg 合流场景的孤儿进程压测（见 P3-4）。

---

*报告结束 · 严过关（QA）· M2-VERDICT: FAIL（仅因验收门不可复现；产品功能实质通过）· 修 P1-1 后可 15 分钟内复验*

---
---

# 第二段复验 · §10 M2 二轮复验（RECHECK R2）

> 复验人：严过关（QA）｜ 日期：2026-11-05 ｜ 对象：4 项修复（`b924f06` P1-2 / `420c6f7` P1-1 / `9e25594` P2-1+P2-2 / `457c12c` D-29 guard）
> 重点：新增的 `runVitestGuarded()` 是不是"放水开关"（证伪优先）
> 证据目录：`reports/qa-evidence-m2r2/`（20 份原始日志/JSON）

## 10.1 R2 结论

| 项 | 结论 |
|---|---|
| **M2-RECHECK-VERDICT** | **PASS-WITH-ISSUES** |
| `runVitestGuarded` 判定 | **保留但必须收紧**（不是无差别放水：真实测试失败**没被吞**；但存在**已证实的"陈旧证据"漏洞**，见 §10.2） |
| 反例 A 实测 | `npm test` **exit 1**（未被吞）、`acceptance --milestone M2` **exit 1**（`[acceptance] M2: vitest failed`）、`vitest-results.json` 被改写为 `success:false / failed:1` |
| 4 项修复 | **4/4 PASS**（P1-1 / P1-2 / P2-1 / P2-2，逐条独立复现） |
| acceptance M2 三连跑 | **3/3 全绿**（37/37 + 5/5 gate + exit 0），见 §10.5 |
| 206 vs 207 差异 | **已查明**：口径不同 + 新增 5 个守卫测试（见 §10.6） |
| M1 基线 | **17/17 + 5/5**，exit 0；`manifest.json` 未被改动 |
| 是否放行 M3 | **放行（带 1 条硬性待办）**：`runVitestGuarded` 的新鲜度校验须在 M3 第一批补上（10 分钟量级，可不阻塞 M3 主线开工） |

## 10.2 【第 1 优先】`runVitestGuarded` 是不是"放水开关"？

### 10.2.1 判定条件逐行（`scripts/lib/vitest-run.mjs`）

```js
// L25  const GUARD_MARKER = 'SAFE_DELETE_BULK_CONFIRM_REQUIRED';   ← 专用字符串，非通用错误码

// L45-55  条件③④（注意：只看"文件内容"，没有任何新鲜度/时间戳/run-id 校验）
function artifactsProveSuccess(cwd) {
  const resultsPath = join(cwd, 'reports', 'vitest-results.json');
  const summaryPath = join(cwd, 'coverage', 'coverage-summary.json');
  if (!existsSync(resultsPath) || !existsSync(summaryPath)) return false;      // ④ 存在性
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  return results?.success === true && results?.numFailedTests === 0
       && results?.numTotalTests > 0;                                          // ③ 内容
}

// L71-85  主判定
const first = run();
if ((first.status ?? 1) === 0) { ...return { status: 0, ... }; }               // ① 退出非零才进入
const guardTripped = combined.includes(GUARD_MARKER);                          // ② 标记命中
if (!guardTripped || !artifactsProveSuccess(cwd)) {
  return { status: first.status ?? 1, guardMitigated: false, ... };            // 否则原样上报
}
batchedRemoveDir(join(cwd, 'coverage', '.tmp'));                               // 仅清理 coverage/.tmp
return { status: 0, guardMitigated: true, originalStatus: first.status ?? 1 }; // 只有这里才转 0
```

### 10.2.2 结果文件残留风险 —— **存在，且已被我证实可被利用**

- **每次运行前不删/不隔离旧的 `vitest-results.json` 与 `coverage-summary.json`**（`acceptance.mjs`、`run-tests.mjs`、`vitest-run.mjs` 全都没有预清理；`npm test` 根本不写这两个文件，旧文件会一直躺着）。
- **反例 B（我实做，比读代码更硬）**：不改任何仓库文件，直接调用 helper，让子进程 exit 1 + 打印 guard 标记，但**什么都不写**：

```
$ node -e "import('./scripts/lib/vitest-run.mjs').then(({runVitestGuarded})=>{
    const r = runVitestGuarded(['-e','console.error(\"SAFE_DELETE_BULK_CONFIRM_REQUIRED: refusing bulk delete\"); process.exit(1)'], process.cwd());
    console.log('RESULT =', JSON.stringify(r)); })"
[vitest-run] NOTE: sandbox bulk-delete guard aborted coverage temp cleanup only.
[vitest-run] Evidence is complete: reports/vitest-results.json success=true & 0 failed ...
RESULT = {"status":0,"guardMitigated":true,"originalStatus":1}     ← 被上一轮的绿结果骗过，退出码 1 → 0
```
  证据：`reports/qa-evidence-m2r2/`（本条在中断前的探针输出，已并入 §10.2.2 记录）。
  → **结论：陈旧的 `success:true` 结果 + 陈旧 coverage-summary，可以骗过条件③④。** 真实场景对应"vitest 崩溃/被杀/OOM、没来得及重写 `vitest-results.json`"时，失败会被误判为环境性中断。

### 10.2.3 反例 A（最关键）—— 真实测试失败**没被吞**

做法：把 `tests/unit/download-flags.test.ts:20` 的 `expect(detectPostprocessed(base())).toBe(false)` 改成 `toBe(999)`，用**单条原子命令**完成"改→验→跑→还原"：

| 步骤 | 实测 |
|---|---|
| 确认断言已坏 | `sed -n '19,21p'` 显示 `expect(...).toBe(999)`；`git status` = ` M tests/unit/download-flags.test.ts` |
| `npm test`（走 guarded，含 `--coverage`） | **EXIT=1**（未被吞）；`1 failed \| 205 passed (206)`；无 `[vitest-run]` 缓解输出 |
| `node scripts/acceptance.mjs --milestone M2` | **EXIT=1**，`[acceptance] M2: vitest failed`，未写全绿报告 |
| 本次运行的 `vitest-results.json` | `success false total 212 failed 1` —— **被本次运行改写**，条件③ 因此不成立 |
| 还原 | `git checkout -- tests/unit/download-flags.test.ts` → 工作树 clean |

→ **guard 没有吞掉真实失败**：因为 vitest 无论成败都会重写 `vitest-results.json`，条件③ 拿到的是本次的 `success:false`。
（附注：中途发生过一次"测试文件被外部还原"导致一次无效 A2 运行（exit 0 假绿），我用单条原子命令重做后得到上述有效结论；无效运行日志 `A2-acceptance-m2-broken.log` 保留备查。）

### 10.2.4 其余三项检查

| 检查 | 结论 |
|---|---|
| guard 标记是否过宽 | **不过宽**：`SAFE_DELETE_BULK_CONFIRM_REQUIRED` 是专用字符串，不是 `EPERM`/`EBUSY` 这类通用码；误判面很小 |
| 清理是否只针对 `coverage/.tmp` | **是**：`batchedRemoveDir(join(cwd,'coverage','.tmp'))`，20 个/批、best-effort、递归只在该目录内；不碰 `reports/`、`coverage/*.json`、用户文件 |
| 无 shim 环境是否透明 | **是**：exit 0 → 直接原样返回 0；非零且无标记 → 原样返回原退出码（L80-85）；本机 3 次 acceptance 连跑 `environmentMitigations: []`，证明该机上未触发 |
| 披露是否如实 | **是**：`docs/M2-REPORT.md` §"environmentMitigations" 与 `DECISIONS.md` D-29 都明确写了"只有证据齐备才接受、否则原样上报失败""这就是掩盖失败"，并把 `["M2:coverage-tmp"]` 写进报告；**没有把"环境适配"写成"通过"** |

### 10.2.5 明确建议：**保留 + 收紧（3 处小改）**

保留的理由：它解决的是真实环境问题（沙箱批量删除拦截导致"绿却非零"），披露充分、且对真实失败有效。
必须收紧（否则就是个只差一步的放水开关）：
1. **新鲜度校验（最关键）**：spawn 前记录 `runStartedAt` / 生成一次性 run-id 写入临时文件，`artifactsProveSuccess` 里要求 `vitest-results.json` 的 `mtime > runStartedAt`（或含本次 run-id）；**或**直接在 spawn 前 `unlink` 旧的 `vitest-results.json` + `coverage-summary.json`（更简单）。
2. **补覆盖率门控复核**：条件③ 只查"测试全绿"，不查四维 ≥70；应同时读 `coverage-summary.json` 复算 `min(lines,branches,functions,statements) >= 70`，否则阈值失败也可能被吞。
3. **告警升级**：`guardMitigated` 时在报告里记 `originalStatus` 与触发的输出行（现在只打印到 stderr）。

## 10.3 4 项修复逐项复核

| 项 | 声称 | 我的独立验证 | 判定 |
|---|---|---|---|
| **P1-2** manifest 合并保留 | `deepMergePreserve` 保留未知键 + 5 例守卫测试 | ① 读 `scripts/lib/fixture-manifest.mjs`：`deepMergePreserve` 确实"base 独有键保留、overrides 覆盖标量、双对象递归"；② `tests/unit/u3-verify-manifest-preserve.test.ts` **5 例真跑**（含"仓库 fixture 仍带两把 M2 键"的守卫）；③ **独立实测**：跑 `node scripts/u3-verify.mjs` → `git diff --stat tests/fixtures/manifest.json` **为空**、`expectedFormat/c8Golden` 仍在（计数 2）；再跑 `acceptance --milestone M1`（17/17, exit 0）→ **仍为空**、两键仍在；④ `artifact-local` 的 **C7 detail = "measured specs match the selected format"，actual = `{"width":320,"height":240,"codecName":"h264","avgFrameRate":"25/1"}`**（真比对）；⑤ **C8 skipReason = "no post-processing; C2 (byte hash) is authoritative (D-19)"**（"纯下载"，**不是** golden 缺失） | **PASS** |
| **P1-1** download-local 节流 + ETA 收窄 | `rateBytesPerSec: 40960` + ETA 只对中间行 | ① `download-local.test.ts:27` `const RATE = 40_960` 并传给 `startMockServer`；② `:61-64` `intermediate = progresses.filter(e => (e.percent ?? 0) < 100)`，断言 `intermediate.length > 2`、`intermediate.some(etaSec !== null)`，终态行不再参与 ETA 判定；③ **独立 5 连跑：5/5 全绿**（exit 0×5） | **PASS** |
| **P2-1** durationMs 实测 + duration gate | 实测 + ≤1ms 会 FAIL | ① 代码 `acceptance.mjs:314-323`：`tooFast = items.filter(i => i.durationMs <= 1)`，collect 模式下非空 → `M2-GATE-duration` = FAIL 并列出断言 id；② 我的 3 次连跑：`durationMs` **min 4131/4457/4150ms、p50≈55s、max≈55s，≤1ms 数量 = 0**；③ `M2-GATE-duration: PASS | min=4150ms over 37 assertions (measured)`；量级与自报 4395/61121、1774/22193、1731/22339 一致（min 1.7–4.6s、max 22–61s 同量级） | **PASS** |
| **P2-2** 分里程碑报告 | `-m1/-m2/index` 三份并存 | `reports/acceptance-report-m1.json`（16:18，M1 17/17）+ `acceptance-report-m2.json`（16:31，M2 37/37）+ `acceptance-index.json`（`latest=M2`，`milestones={M2,M1}` 各自 allGreen/时间戳齐全）—— **跑完 M2 再跑 M1 两份都在、索引正确** | **PASS** |

## 10.4 六条验收重判（R2）

| # | 验收 | 实测 | 判定 |
|---|---|---|---|
| ① | 真实下载 | `download-local` 5/5 绿；sha256=1db5d565…6d04b、size=308666、history 恰 1 条 | **PASS** |
| ② | 进度 %/速度/ETA 递增 | 节流后中间行 >2 条，`speedBps>0` 与 `etaSec!==null` 均在中间行成立；上轮的 flake 已消除（5/5） | **PASS** |
| ③ | 取消无残留 + `.part` 保留 | `cancel-local` 2 例 6322ms 绿；**进程快照：跑前 NO-PROCESS → 跑后 NO-PROCESS** | **PASS** |
| ④ | 重试续传严格同哈希 | `retry-local` 绿（R2 报告 `A-4.4-14`/`A-M2-17` PASS，dur≈21.9s） | **PASS** |
| ⑤ | C1–C12 | 10 PASS + C8/C11 SKIPPED（理由见 §10.7），0 FAIL | **PASS** |
| ⑥ | 历史唯一 | `A-M2-20` 去重 13 例绿 + `download-local` history 恰 1 条 | **PASS** |

## 10.5 acceptance M2 三连跑表

| RUN | 退出码 | 断言 | gate | allGreen | coverage min | durationMs min/p50/max | ≤1ms | envMitigations |
|---|---|---|---|---|---|---|---|---|
| 1 | **0** | **37/37** | **5/5** | true | 85.48% | 4131 / 55197 / 55197 ms | 0 | `[]` |
| 2 | **0** | **37/37** | **5/5** | true | 85.42% | 4457 / 55018 / 55018 ms | 0 | `[]` |
| 3 | **0** | **37/37** | **5/5** | true | 85.42% | 4150 / 54856 / 54856 ms | 0 | `[]` |

5 个 gate：`coverage PASS(min 85.42%)` / `layering PASS(violations=0)` / `runtime PASS(allRequiredOk=true)` / `vitest PASS(212 tests, 0 failed)` / `duration PASS(min=4150ms, measured)`。
上轮 3 条 FAIL 的断言本轮全部转绿：`A-4.2-06`、`A-4.4-07`、`A-M2-07`（均 `case download-local exit=0`）。

## 10.6 206 vs 207 差异（查明）

**不是删测试，是口径 + 新增守卫测试。**
- 上轮我报的 **207** = **全量套件**（L0+L1 201 + L2 6）；上轮 `npm test`（L0+L1）实为 **201 例 / 21 文件**。
- 本轮 `npm test` = **206 例 / 22 文件** = 201 + **5 个新增**（`tests/unit/u3-verify-manifest-preserve.test.ts` 5 例，P1-2 守卫测试）。
- 本轮全量 = **212 例 / 27 文件** = 206 + 6（L2）= 212（与 acceptance 的 `M2-GATE-vitest: 212 tests, 0 failed` 一致）。
→ 差异全部来自 P1-2 的新增守卫测试，**没有删除或合并任何既有断言**，合理。

## 10.7 C1–C12（R2 实测，与上轮一致）

`artifact-local` 真实下载后真跑：C1 PASS / C2 PASS(byte-exact) / C3 PASS / C4 PASS(仅 stderr) / C5 PASS(delta 0.00s, 降级到 manifest 10s) / C6 PASS / **C7 PASS（actual 320x240/h264/25fps，真比对）** / **C8 SKIPPED（skip=纯下载，C2 权威）** / C9 PASS / C10 PASS / **C11 SKIPPED（无历史入口，P3-2 维持）** / C12 PASS。**10 PASS + 2 SKIPPED，0 FAIL。**

## 10.8 R2 其余门控与边界

- `npm test` 206/206 exit 0（92.79/84.70/93.75/92.79）；`pnpm exec vitest run --coverage` 27 文件 212 例 exit 0（**93.07/85.42/94.27/93.07**）
- `check-layering` **0 违规**；`check-runtime` **exit 0**（3 必需 OK + aria2c OPTIONAL）；`acceptance --milestone M1` **17/17 + 5/5 exit 0**
- 边界：`packages/ui` 不存在、`.tsx/.css` **0**、`shell: true` **0 命中**、`createWindow` **0**、合规禁用参数仅在 redactor 拦截名单
- **`git diff --stat 615da08 HEAD -- packages apps` = 空** → 4 个修复提交**零业务代码改动**（只动 `scripts/`、`tests/`、`vitest.config.ts`、`docs/`）
- 我的 QA 报告未被篡改（`git diff HEAD -- docs/M2-QA-VERIFICATION.md` 为空，内容即我上轮所写）

## 10.9 R2 问题与放行结论

| ID | 级别 | 问题 | 建议 |
|---|---|---|---|
| **R2-1** | **P2（唯一遗留）** | `runVitestGuarded` 的 `artifactsProveSuccess`（`vitest-run.mjs:45-55`）**无新鲜度校验**：陈旧绿结果可骗过条件③④（我已用直接调用证实 `status:0`）；且只复核"测试全绿"，**不复核覆盖率四维** | **保留 + 收紧**：spawn 前删除/隔离旧 `vitest-results.json`+`coverage-summary.json`（或 mtime/run-id 校验）；补覆盖率复算；`guardMitigated` 时写入 `originalStatus`。列为 M3 第一批 10 分钟待办 |
| R2-2 | P3 | 上轮 P3-1 的恒等三元 `toContain('…' ? 'fixture' : 'fixture')` 仍在 `download-local.test.ts:48` | 顺手清理 |

**M2-RECHECK-VERDICT: PASS-WITH-ISSUES —— 正式放行 M3**（条件：R2-1 的新鲜度校验列入 M3 首批待办并在 M3 复验前完成；它不阻塞 M3 开工）。

---


## 10.10 【补】反例 A 的澄清与最终收尾（应 team-lead 要求，明确回答 A2 疑点）

### 10.10.1 A2 那次运行时断言是坏的还是已还原？→ **属于情况 2：断言已还原**（A2 不是 P0 放水）

决定性证据（用 A2 自己的输出反证）：
- `A2-acceptance-m2-broken.log:293` = `[acceptance] M2: 37/37 assertions PASS, 5/5 gates PASS` —— 其中含 `M2-GATE-vitest`。该 gate 的判据是 `allVitestGreen = vitest.numFailedTests===0 && numTotalTests>0 && success===true`（`acceptance.mjs:264`），要求当时读到的 `vitest-results.json` 是 **0 failed**。
- 若断言当时是坏的，A2 必然在采集阶段就打印 `[acceptance] M2: vitest failed` 并退出 1 —— 这正是我用同一命令在 A3 复现到的行为（`A3-acceptance-m2-broken-real.log`）。
- 时间线：`A1-npm-test-broken.log`（14:26:57）证明 14:26 时断言**确实坏**（`1 failed | 205 passed (206)`）；但到 A2（16:14:28）之前，该文件被**外部还原**（我在跑 A2 前的 `git status --porcelain` 输出为空，事后 `grep` 第 20 行回到 `toBe(false)`）。A2 因此是"断言已还原"的合法全绿，不是 gate 吞失败。
- `reports/vitest-results.json` 的时间线：A2 重写为 success=true → 16:16 A2b 改为 success=false/failed=1 → 之后 B2（acceptance M1）与 E1–E3（3 连跑）又重写回 **success=true / failed=0 / total=212**（16:31:00）。lead 看到的 success=false 是 16:16–16:18 之间的中间快照，不是终态。

**结论：不存在 "vitest.numFailedTests=1 仍判 M2-GATE-vitest: PASS" 的 P0 放水。** `acceptance.mjs:264` 的 `allVitestGreen` 与 `:308` 的 `M2-GATE-vitest` 在失败时确实会 FAIL（见 10.10.2 的 A3b）。

### 10.10.2 真正的反例收尾（单条原子命令，A3 / A3b / A4）

| 步骤 | 动作 | 实测输出 | 退出码 |
|---|---|---|---|
| **A3** | 改坏断言（确认 `expect(...).toBe(999)`）→ `acceptance --milestone M2`（collect） | `[acceptance] M2: vitest failed`（采集阶段即中止，未写全绿报告） | **1** |
| **A3b** | 仍坏 → `acceptance --milestone M2 --no-collect`（用刚写下的失败结果聚合） | `M2-GATE-vitest: FAIL | 212 tests, 1 failed`、`allGreen=false`、`37/37 assertions PASS, 4/5 gates PASS` | **1** |
| **A4** | `git checkout` 还原（第 20 行回到 `toBe(false)`）→ `acceptance --milestone M2` | `[acceptance] M2: 37/37 assertions PASS, 5/5 gates PASS`、`allGreen=true`、durationMs min=4407ms (measured) | **0** |

日志：`A3-acceptance-m2-broken-real.log` / `A3b-acceptance-m2-gate-fail.log`（+ 报告快照 `A3b-acceptance-report-m2.json`）/ `A4-acceptance-m2-restored.log`。

**明确结论句：「故意改坏断言时，验收会变红」——有证据支撑。**
证据链：`A3-acceptance-m2-broken-real.log`（exit 1，`vitest failed`）+ `A3b-acceptance-m2-gate-fail.log` / `A3b-acceptance-report-m2.json`（`M2-GATE-vitest: FAIL | 212 tests, 1 failed`，`allGreen=false`）+ `A4-acceptance-m2-restored.log`（exit 0，37/37 全绿）。

### 10.10.3 A3b 暴露的一个真实粒度缺口（新增 P3-5，不改结论）

A3b 报告里 **37 条断言仍全 PASS、只有 gate 红**：`download-flags.test.ts` 不落在 M2 37 条断言的任何 `test:` 文件名模式里（`M2_ASSERTIONS` 的模式集覆盖 task-queue / history-store / artifact-verifier / progress-parser / argv-builder* / shell-port / task-store / artifact-manifest 等，不含 download-flags），单断言层看不到它。
→ 但**整体验收仍变红**（`M2-GATE-vitest` FAIL + `allGreen=false` + exit 1），所以不是放水；只是"单断言粒度 < 全局 gate 粒度"。记为 **P3-5**：M3 建议把每个测试文件都映射到至少一条断言，或补一条"全量测试文件计数"断言。

### 10.10.4 最终状态（干净）

- `git status --porcelain` = ` M docs/M2-QA-VERIFICATION.md`（我的报告）+ `?? docs/PROJECT-HANDOFF.md`（他人文件）
- `tests/unit/download-flags.test.ts:20` = `expect(detectPostprocessed(base())).toBe(false);`（已还原）
- `reports/vitest-results.json` 终态 = **success true / failed 0 / total 212**（A4 之后写入）


---

*§10 二轮复验结束 · 严过关（QA）· M2-RECHECK-VERDICT = PASS-WITH-ISSUES · guard 判定：保留+收紧 · 4/4 修复成立 · 3/3 连跑全绿 · 证据：`reports/qa-evidence-m2r2/`*

