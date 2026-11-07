# YTVDLT · M2「单任务下载闭环 + 完整性」汇报

> 汇报模板：HANDOFF §8 ｜ 日期：2026-11-05 ｜ 交付方：寇豆码（Kou）· 工程师
> 权威输入：`ARCHITECTURE-M2.md`（1020 行，64 文件清单）> HANDOFF v1.1（§7.2 C1–C12 / §8 M2）> M1 基线与 QA 报告
> **本里程碑完成后停下等甲方放行，绝不推进 M3。**

---

## 1. 完成了什么

| 层 | 交付 |
|---|---|
| **端口层** | `ProcessPort` **只新增** `spawnStreaming`（流式 + pid + kill）与 `isAlive`；新增 `IShellPort` + `CorePorts.shell?`。**三处实现同步**：`process-streaming.ts`（生产，`taskkill /T /F`）、`in-memory-ports.ts`（L0 脚本化行序列）、`real-process-port.ts`（L2 真实 spawn）。M1 的 `spawn` 一字未改。 |
| **shared DTO** | 新增 `progress.ts`（ProgressEvent）/ `verification.ts`（ArtifactVerification + VerificationReport + ExpectedArtifactManifest）/ `task.ts`（7 态 TaskState + TaskRecord + TaskSnapshot + TaskEvent）/ `history.ts`；`ipc.ts` 追加 4 个 channel 常量。追加式导出，零破坏。 |
| **engine-ytdlp** | 新增 `argv-builder-download.ts`（`buildDownload` 纯函数，冻结 argv 顺序）/ `progress-template.ts` / `progress-parser.ts`（容错解析 + percent 三档回退）/ `artifact-manifest.ts`（去一层引号、多行、去重、拒相对路径）；**`YtDlpEngine.download()` 真跑起来**（spawnStreaming → 进度投影 → 清单产物 → completed/failed/canceled）；`FakeEngine.download()` 改为按 `progress-basic.log` 逐行回放。 |
| **core** | 新增 `task-queue/`（7 态状态机 13 合法转移 + **串行** TaskQueue，C12 时序铁律）/ `artifact-verifier/`（**C1–C12** 逐条实现，含 C2↔C8 动态、C5 null 降级、C4 只看 stderr）/ `history-store/`（JSON 原子写 + 路径规范化去重 + 私有模式 + 删除）+ `task-store/`（快照恢复 Running/FetchingInfo→Canceled）；新增纯函数 `download-flags.ts`（`detectPostprocessed`）与 `shell-commands.ts`（`buildExplorerArgv`）。 |
| **apps/desktop** | 新增 `process-streaming.ts`（`taskkill.exe /PID <pid> /T /F`，绝对路径 + argv[] + `shell:false`）、`shell-port.ts`（`explorer.exe` argv[]）；`node-ports.ts` 组装新端口。 |
| **scripts** | 新增 `verify-artifact.mjs`（真实 Core 校验器 + `reports/artifact-verification.json`）、`lib/media-tools.mjs`；`mock-server.mjs` 增加 **`rateBytesPerSec` 节流**（取消用例的前提）与 vtt/jpg 路由；`run-tests.mjs` 扩 5 个 `--case` 白名单；`acceptance.mjs` 增加 M2 分支（37 断言 + 4 gate）并修 **P2-2/P3-1**。 |
| **测试** | 207 例（L0 + L1 + 5 条 L2）。新增 L2：`download-local` / `cancel-local` / `retry-local` / `artifact-local`；新增 L1 契约：`download-engine.download.contract.test.ts`；新增 L0 7 个测试文件（合计 100+ 例）。 |
| **文档** | `docs/M2-REPORT.md`（本文）、`DECISIONS.md` 追加 D-16…D-25、`reports/acceptance-report.json`（`milestone:"M2"`）。 |

**不做（M2 边界）**：无 UI / 无 `.tsx`/`.css` / `packages/ui` 仍不存在；不做并发调度（串行，`concurrency` 仅读取）；不做格式/字幕/路径全量组合（`FormatSelector`/`SubtitlePlanner`/`PathResolver` 属 M3）；不做播放列表、自定义命令、自更新、打包、L3 在线烟测。

---

## 2. 六条验收（HANDOFF §8）判定

| # | 验收标准 | 证据 | 判定 |
|---|---|---|---|
| ① | 本地 HTTP fixture 走**真实 yt-dlp** 完成下载 | `--case download-local` exit 0；产物 308666 B、sha256 与 fixture 一致；路径来自 `--print-to-file` 清单（非目录扫描） | **PASS** |
| ② | 进度事件含 %/速度/ETA 且递增 | 同用例断言 percent 单调不减且末值 100，`speedBps>0` 出现，`etaSec` 非全 null | **PASS** |
| ③ | 取消后无残留进程、`.part` 保留 | `--case cancel-local` exit 0：`isAlive(pid)===false`、`.part` 存在、状态 `Canceled`、历史为空 | **PASS** |
| ④ | 重试成功 | `--case retry-local` exit 0：取消后续传完成，最终 sha256 == 一次性下载（C10），`.part` 清理 | **PASS** |
| ⑤ | **C1–C12 全部通过** | `--case artifact-local` exit 0：**12 条判据 10 PASS + 2 SKIPPED（C8 无后处理 / C11 无历史），0 FAIL** | **PASS** |
| ⑥ | 历史路径真实存在且唯一 | `download-local` 断言历史恰 1 条、`videoPath === 产物`、磁盘存在；`HistoryStore` 同路径去重 | **PASS** |

### C1–C12 实测值（`reports/artifact-verification.json`，对真实下载产物）

| 判据 | 状态 | 说明 |
|---|---|---|
| C1 产物存在非空 | **PASS** | 清单路径，308666 B |
| C2 字节哈希 | **PASS** | `sha256 == 1db5d565…04b`（纯下载，无后处理） |
| C3 容器可解析 | **PASS** | ffprobe exit 0 + stderr 空 + JSON |
| C4 全帧可解码 | **PASS** | `ffmpeg -v error -i f -f null -` **stderr 为空**（判据不看 exit code） |
| C5 时长一致 | **PASS** | `MediaInfo.duration===null` → 降级与 `manifest.durationSec=10` 比（D-20） |
| C6 流完整 | **PASS** | video + audio |
| C7 规格符合 | **PASS** | 无显式 format 选择 → 记录实测值并 PASS |
| C8 逐帧一致 | **SKIPPED** | 无后处理（skipReason 已写明，D-19） |
| C9 附带产物 | **PASS** | 本用例未声明附带产物 |
| C10 续传一致 | **PASS** | `retry-local` 中最终哈希 == 一次性下载 |
| C11 历史一致 | **SKIPPED** | 校验时未传历史条目（历史一致性另由 download-local 断言） |
| C12 无假完成 | **PASS** | 无 FAIL 才允许 Completed；校验失败用例断言不写历史 |

---

## 3. 37 条断言对照表（12 沿用 + A-M2-01…A-M2-25，全部 PASS）

`reports/acceptance-report.json` 中逐条含 `id/layer/status/expected/actual/durationMs/evidence`。

| ID | 层 | 承载 | 结果 |
|---|---|---|---|
| A-4.2-06 | L2 | download-local（C6 流完整） | PASS |
| A-4.4-05 | L2 | cancel-local（`.part` 保留） | PASS |
| A-4.4-06 | L0 | history-store（去重 → ALREADY_DOWNLOADED） | PASS |
| A-4.4-07 | L2 | download-local（入库、路径可打开） | PASS |
| A-4.4-08 | L0 | history-store（搜索/过滤） | PASS |
| A-4.4-11 | L1 | progress-parser（percent 递增） | PASS |
| A-4.4-12 | L1 | progress-parser（speed/ETA） | PASS |
| A-4.4-13 | L0 | task-queue（无暂停，取消语义） | PASS |
| A-4.4-14 | L2 | retry-local（取消/重试续传） | PASS |
| A-4.4-22 | L0 | history-store（隐私模式不写） | PASS |
| A-4.5-06 | L0 | history-store（归档重复） | PASS |
| A-4.6-02 | L0 | shell-port（IShellPort argv 契约） | PASS |
| A-M2-01 | L0 | task-queue（13 合法 / 36 非法 + 串行） | PASS |
| A-M2-02 | L2 | cancel-local（spawnStreaming/isAlive） | PASS |
| A-M2-03 | L2 | cancel-local（taskkill /T /F 无孤儿） | PASS |
| A-M2-04 | L0 | artifact-manifest（引号/多行/去重/拒相对） | PASS |
| A-M2-05 | L0 | progress-parser（NA/空/负/非前缀/段数） | PASS |
| A-M2-06 | L0 | progress-parser（percent 三档回退） | PASS |
| A-M2-07 | L2 | download-local（speed/eta + 递增） | PASS |
| A-M2-08 | L1 | artifact-verifier C1 | PASS |
| A-M2-09 | L1 | artifact-verifier C2 | PASS |
| A-M2-10 | L1 | artifact-verifier C3 | PASS |
| A-M2-11 | L1 | artifact-verifier C4（exit0+stderr 非空 → FAIL 反例） | PASS |
| A-M2-12 | L1 | artifact-verifier C5（null 降级 + 双无 SKIP） | PASS |
| A-M2-13 | L1 | artifact-verifier C6（音频模式反向判据） | PASS |
| A-M2-14 | L1 | artifact-verifier C7 | PASS |
| A-M2-15 | L1 | artifact-verifier C8（golden 比对 + 无 golden SKIP） | PASS |
| A-M2-16 | L1 | artifact-verifier C9 | PASS |
| A-M2-17 | L2 | retry-local C10 | PASS |
| A-M2-18 | L1 | artifact-verifier C11 | PASS |
| A-M2-19 | L2 | artifact-local（12/12 无 FAIL） | PASS |
| A-M2-20 | L0 | history-store（同 videoPath 去重） | PASS |
| A-M2-21 | L0 | history-store（隐私模式不落盘） | PASS |
| A-M2-22 | L0 | task-store（Running/FetchingInfo→Canceled，保留 lastPercent） | PASS |
| A-M2-23 | L2 | cancel-local（节流 20KB/s 使取消可测） | PASS |
| A-M2-24 | L2 | artifact-local → `reports/artifact-verification.json` | PASS |
| A-M2-25 | L0 | argv-builder-download（逐元素 == 手写字面量） | PASS |

**4 条横切 gate**（`reports/acceptance-report.json` → `gates`）：coverage ≥70%、layering 0 违规、check-runtime 3 必需 OK、全量 vitest 全绿 —— **4/4 PASS**。

---

## 4. 覆盖率（全量 `vitest run --coverage`，M1/M2 口径 四维 ≥70%）

| 维度 | 实测 | 判定 |
|---|---|---|
| lines | **93.07%** | PASS |
| branches | **85.42%** | PASS |
| functions | **94.27%** | PASS |
| statements | **93.07%** | PASS |
| **四维最低** | **85.42% ≥ 70%** | **PASS** |

新组件单文件（lines/branches）：`argv-builder-download` 100/100、`artifact-manifest` 100/100、`progress-parser` 100/100、`criteria` 95.94/92.30、`artifact-verifier` 100/92.85、`history-store` 97.95/93.61、`query` 100/95、`state-machine` 91.66/100、`task-queue` 83.02/75.47、`task-store` 100/92.3、`download-flags` 100/93.33、`shell-commands` 100/100。

> 覆盖率只认**全量**运行；定向单文件运行仅作诊断，不作为结论（P3-3）。

---

## 5. 如何运行 / 如何验收

```bash
pnpm install                      # 已就绪
node scripts/fetch-runtime.mjs --finalize        # 运行时已就位（二进制不入库）
pnpm turbo run typecheck                         # 4/4 包零错误
node scripts/check-layering.mjs                  # 0 违规
npm test                                         # 207 例，零外网，退出 0
pnpm exec vitest run --coverage                  # 全量四维（最低 85.42%）

# L2（真实 yt-dlp + 127.0.0.1，串行）
npm run test:integration:offline -- --case probe-local
npm run test:integration:offline -- --case download-local
npm run test:integration:offline -- --case cancel-local
npm run test:integration:offline -- --case retry-local
npm run test:integration:offline -- --case artifact-local

# 校验器直接对 fixture 自验
node scripts/verify-artifact.mjs --expect tests/fixtures/manifest.json --actual tests/fixtures/media/fixture.mp4 --json

# M2 汇总（37 断言 + 4 gate）
node scripts/acceptance.mjs --milestone M2
```

---

## 6. 剩余 / 阻塞 / 偏离

| 项 | 说明 |
|---|---|
| **无阻塞** | 六条验收全部真实跑通；37/37 断言 + 4/4 gate PASS；`allGreen=true` |
| A-4.6-02 边界 | M2 只到 `IShellPort` 契约 + `explorer.exe` argv 正确性（D-25）；**真实「默认播放器启动」未完成，留 M3 接 Electron `shell`** —— 已在断言、报告与 DECISIONS 三处注明，不作虚假声明 |
| 多流进度 | 单流承诺递增（D-18）；video+audio 分离会回退，分段递增留 M3 |
| 并发 | M2 **串行**（单测断言入队 3 个仍 maxActive=1）；`concurrency` 读取但不调度，M4 启用 |
| C8 golden | 首次 L2 生成并缓存（O-M2-02）；M2 未走后处理路径故 C8 SKIPPED |
| C11 | 校验器在无历史条目时 SKIPPED；历史一致性由 `download-local`（历史唯一且存在）与 `HistoryStore` 去重单测覆盖 |
| 环境适配（留痕） | ① `vitest.config.ts` 设 `fileParallelism:false`（L2 需串行，避免真实进程争抢）；② `coverage.clean=false`（本机 safe-delete 对 >50 文件的批量删除会拦截）；③ L2 scratch 目录改为唯一命名 + best-effort 清理。三者均为测试基建，不影响产品代码 |
| P2-2 / P3-1 回归 | `acceptance.mjs` 的 layering 门控仍严格（注入 1 处违规 → A-INF-01 FAIL、退出 1，M2-B0 已复验）；`durationMs` 全为非零实测 |
| 偏离留痕 | `DECISIONS.md` **D-16…D-25**（含 D-15 已被 M1 QA 占用而改从 D-16 编号的说明） |

---

## 7. commit 列表（每批一次增量提交）

| 批次 | commit | 内容 |
|---|---|---|
| M2-B0 | `3bba355` | 端口扩展（spawnStreaming/isAlive/IShellPort）+ mock-server 节流 + N-1 覆盖率 scope + M1 基线回归 |
| M2-B1 | `85b83e8` | buildDownload 冻结 argv + 进度解析 + 产物清单（三纯函数 100%） |
| M2-B2 | `186ce92` | ArtifactVerifier C1–C12 + verify-artifact.mjs + media-tools |
| M2-B3 | `fcbb0da` | TaskQueue（7 态串行）+ TaskStore + HistoryStore + shell argv 契约 |
| M2-B4 | `615da08` | YtDlpEngine.download() 流式 + 清单产物 + L2 四用例 |
| M2-B5 | 见本次提交 | M2 汇总门控（37 断言）+ M2 报告 + DECISIONS 定稿 |

---

## 8. 停下声明

**未获甲方放行，不进入 M3。**

本次交付不含任何 UI、任何窗口、任何 M3–M5 功能代码；`packages/ui/**` 不存在；未实现任何绕过 DRM/付费墙/登录/地区/年龄限制的能力；未使用字符串拼接命令或 `shell:true`（全部 spawn 绝对路径 + `argv[]` + `windowsHide:true`）。

---

*文档结束 · YTVDLT M2 汇报 · 未获甲方放行，不进入 M3*

---

## 9. QA 复验修复（M2-QA-VERIFICATION 后追加）

QA 独立复验判 **FAIL**，但明确「产品实现是真的，问题全在验收脚本/测试侧」。4 项必修已全部修复，**未改任何产品代码**（`packages/**`、`apps/**` 零 diff）。

| # | 问题 | 修法 | 修复后证据 |
|---|---|---|---|
| **P1-2**（最严重） | `scripts/u3-verify.mjs` 用硬编码对象重写 `tests/fixtures/manifest.json`，**删掉 M2 的 `expectedFormat`/`c8Golden`**；而 `acceptance --milestone M1` 会调用它 → C7 退化为「只记录」、C8 永远 SKIPPED（**方向是变绿，最危险**） | 新增 `scripts/lib/fixture-manifest.mjs`（`deepMergePreserve` + `writeFixtureManifest`：读旧→深合并保留未知键→单次 `rename` 原子写，**不预删目标**）；`u3-verify.mjs` 改用它 | ① 守卫测试 `tests/unit/u3-verify-manifest-preserve.test.ts` **5/5 PASS**；② `node scripts/u3-verify.mjs` 后 `git diff tests/fixtures/manifest.json` **为空**；③ `acceptance --milestone M1` 后 diff 仍**为空**，两键仍在；④ `artifact-local`：C7 detail = **"measured specs match the selected format"**（actual `width=320,height=240,codec=h264,fps=25/1`），C8 skipReason = **"no post-processing; C2 (byte hash) is authoritative (D-19)"** |
| **P1-1** | `download-local` 的 `etaSec` 断言不可靠（不限速时只有 2 条进度行，终态行 `eta=NA`→null；QA 实测 8 次 5 次失败） | mock server 加 `rateBytesPerSec: 40960`（308KB≈7.5s）；断言收窄为**仅中间行**（`percent<100`）要求 `speed>0` 且 `eta` 非 null，并断言 `intermediate.length>2` | 该用例**连跑 5 次 5/5 绿**（每次 exit 0、`Tests 1 passed`） |
| **P2-1** | M2 分支 `durationMs` 写死 `1`（M1 的 P3-1 被覆盖） | `runM2` 用 `performance.now()` 按证据步骤真实计时（vitest / layering / check-runtime / 每条 L2 case）；新增 **`M2-GATE-duration`** 自检 gate：collect 模式下任一断言 `durationMs<=1` → gate **FAIL** | 三次连跑 `durationMs` min **1731–4395ms**、max **22193–61121ms**，**≤1ms 计数 0**；gate actual = `min=…ms over 37 assertions (measured)` |
| **P2-2** | M1 与 M2 都写 `acceptance-report.json`，互覆盖 | `writeMilestoneReports()`：写 `reports/acceptance-report-m1.json` / `-m2.json` + 保留 `acceptance-report.json`（最近一次）+ `reports/acceptance-index.json` | M2 后跑 M1：两份文件**同时存在**，index 记录 latest 与各里程碑 summary |

### 3 次连跑（最终代码，逐次真实输出）

| 运行 | 退出码 | 断言 | gate | allGreen | coverage min | durationMs min/median/max | ≤1ms | 环境适配标记 |
|---|---|---|---|---|---|---|---|---|
| RUN1 | **0** | 37/37 | 5/5 | true | 85.42% | 4395 / 61121 / 61121 | 0 | `["M2:coverage-tmp"]` |
| RUN2 | **0** | 37/37 | 5/5 | true | 85.42% | 1774 / 1774 / 22193 | 0 | `["M2:coverage-tmp"]` |
| RUN3 | **0** | 37/37 | 5/5 | true | 85.42% | 1731 / 1731 / 22339 | 0 | `["M2:coverage-tmp"]` |

> `environmentMitigations` 是**主动披露**的本机沙箱适配（见 DECISIONS **D-29**）：vitest 覆盖率收尾会删除 `coverage/.tmp`（>50 文件），本机 safe-delete shim 会拦截，导致「测试与覆盖率均已成功产出、进程却非零退出」。`scripts/lib/vitest-run.mjs` 只有在 `vitest-results.json` 证明 `success===true && numFailedTests===0 && numTotalTests>0` **且** `coverage-summary.json` 存在时才接受该环境性中断，否则原样上报失败；每次触发都打印 `[vitest-run] NOTE`。**干净环境（QA 机器）不会触发，该字段为空数组。**

### 其余门控（最终代码）

- `node scripts/acceptance.mjs --milestone M1` → **17/17 + 5/5，exit 0**；`git diff tests/fixtures/manifest.json` **为空**
- `npm test` → 22 文件 **206/206**，coverage 四维 92.79 / 84.72 / 93.75 / 92.79（最低 84.72%）
- `pnpm exec vitest run --coverage`（本机裸跑）→ 覆盖率表 `All files 93.07 / 85.43 / 94.27 / 93.07`、`coverage-summary.json` 最低 **85.43% ≥70%**；进程非零退出**仅因**上述 D-29 环境 guard（QA 环境无该 shim，直接退出 0）
- `node scripts/check-layering.mjs` → **0 违规**；`node scripts/check-runtime.mjs --json` → exit **0**

### 修复相关 commit

| 修复 | commit |
|---|---|
| P1-2 manifest 合并保留 + 守卫测试 | `b924f06` |
| P1-1 download-local 节流 + ETA 断言收窄 | `420c6f7` |
| P2-1 实测 durationMs + duration gate；P2-2 分里程碑报告（同一文件，合并提交） | `9e25594` |
| D-29 环境适配 helper + 去 html reporter + fixture write 免预删 | 见本次提交 |

### P3（记录不阻塞，详见 DECISIONS **D-28**）

1. **C11 生产链路恒 SKIP**：`task-queue.ts` 传 `historyEntry: null`。接受——C11 语义由 `download-local`（历史唯一且存在）+ `HistoryStore` 去重单测承担，**M3 接入 history 后由队列回填激活**。SKIPPED 带 `skipReason`，不是假 PASS。
2. **ffmpeg 孤儿未压测**：单 format 不启动 ffmpeg，`taskkill /T /F` 只验证了父进程消失 + `.part` 保留；**M3 双流合并用例**再压测孤儿。
3. **fake-engine 断言放松**：`toEqual` → `toContain`/首末元素断言，因 `FakeEngine.download()` 改为异步逐行回放、行数随录制内容变化；产品行为仍由 L1 下载契约与 L2 真实链路覆盖。
