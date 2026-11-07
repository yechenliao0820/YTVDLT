# M3 QA 独立证伪复验报告

> **复验人**：严过关（QA） · **复验对象**：`master` HEAD `12ac40c`（M3-B5），6 个 M3 commit `07a77b4` / `8ce0111` / `a58ea40` / `6fad957` / `0b109a2` / `12ac40c`
> **复验日期**：2026-11-06 · **环境**：Windows x64 / Node v22.22.2 / pnpm 9.15.9 · 未联网、未 `pnpm add`、未改任何产品代码
> **复验立场**：不采信工程师自报数字，每一项都以本机实测输出为唯一依据；**反例优先于正例**。
> **原则**：凡未真正验证的项一律写 `NOT VERIFIED`，不写 PASS。

---

## 1. 结论摘要（TL;DR）

**最终意见：`PASS WITH MINOR ISSUES`** — M3 四条验收标准实质成立，「48/48 + 12 gates + 4 acceptance + allGreen」为真实可复现结论；**未发现源码 Bug**；发现 **5 项 P3 级证据/测试强度问题**（不影响 M3 判绿，但削弱部分断言的可证伪强度）。

| 项 | 结论 |
|---|---|
| 路由判定 | **`NoOne`（无源码 Bug）** + **`QA`（测试侧 5 项缺口，建议 M4 首批补，本轮刻意不改动以保持已交付 464/470 计数）** |
| 16 项复验通过数 | **16 / 16 PASS**（其中 3 项带「限定条件」标注：第 3 项 durationMs 粒度、第 4 项临时目录隔离、第 11 项 2 处弱断言） |
| 证伪测试 4 项 | **4 / 4 全部按预期 FAIL，且全部还原**（PNG `exit 1`、DOM `exit 1`、陈旧证据 `exit 1`、覆盖率 69% `REJECTED`） |
| 源码 Bug | **0** |
| 已知偏离 | 5 项偏离（D-28 / D-39 / D-31 / D-36 / D-32）**全部正当、全部留痕、全部未虚报**，详见 §6 |
| 最值得担心的 1 个风险 | **`reports/m3-legacy-closure.json` 无生成脚本、不可复现**，其「5 文件 145 例」与当前实测 129 例不符；`acceptance.mjs` 的 `legacyOk` 仅校验 `failed===0 && durationMs>0`，即任何手写 JSON 都能通过该门控 —— 见 §5 D3 |

---

## 2. 16 项复验逐项结果

| # | 复验项 | 命令 | 实际输出（实测摘要） | 结论 | 证据 |
|---|---|---|---|---|---|
| 1 | 单测全量 | `npm test` | `Test Files 33 passed (33)` / `Tests 464 passed (464)` / `numFailedTests:0` / 覆盖率 `93.89 \| 86.24 \| 94.47 \| 93.89`（stmts/branch/funcs/lines，**最低 86.24%** ≥70） / `exit 0` | **PASS** | `reports/_qa-test-run1.log`（首次）、`reports/_qa-test-final.log`（还原后复跑，数值一致） |
| 2 | E2E 连跑 3 次 | `npm run test:e2e` ×3 | 三次均 `14/14 cases PASS, 5/5 negative checks PASS, allPass=true`、`exit 0`；`differPixels=0`（14 例全 0 px）；exe `Google Chrome for Testing 151.0.7922.34` | **PASS** | `reports/_qa-e2e-1.log` / `-2.log` / `-3.log` |
| 2b | exe 绝对路径与版本独立核实 | `ls -la` + `--version` | 文件存在、**211,223,552 字节**、`--version` 输出 `Google Chrome for Testing 151.0.7922.34`，与脚本内 `EXPECTED_VERSION` 完全一致 | **PASS** | 本报告 §2 命令行输出；脚本 `scripts/run-e2e.mjs:47-48` |
| 3 | M3 验收连跑 3 次 | `node scripts/acceptance.mjs --milestone M3` ×3 | 三次均 `48/48 assertions PASS, 3/3 regression rechecks PASS`、`12/12 gates PASS, 4/4 acceptance PASS`、`allGreen=true`、`exit 0`；`durationMs min` = **76619 / 75668 / 76095 ms**（均非零）；覆盖率最低 `86.78 / 86.77 / 86.77%` | **PASS（含限定）** | `reports/_qa-acc-m3-1.log` / `-2.log` / `-3.log`；`reports/acceptance-report-m3.json` |
| 3b | durationMs 粒度核查 | 解析 `acceptance-report-m3.json` | 48 条断言 `durationMs` **全部等于同一值 77060**（`unique=1`），最小/最大相同 → **非逐条实测，而是「步骤级实测值共享」**；`M3-GATE-duration` 只校验 `>1ms`，无法识别同值 | **PASS（限定：非逐条）** | 见 §5 D4 |
| 3c | M1 / M2 不回归 + 三报告并存 | `--milestone M1`、`--milestone M2` | M1 `17/17 assertions PASS, 5/5 acceptance PASS, allGreen=true, exit 0`；M2 `37/37 assertions PASS, 5/5 gates PASS, allGreen=true, exit 0`；`reports/acceptance-report-m1.json` / `-m2.json` / `-m3.json` **三份并存**，`acceptance-index.json` 中 M1/M2/M3 均 `allGreen:true` | **PASS** | `reports/_qa-acc-m1.log`、`reports/_qa-acc-m2.log`、`reports/acceptance-index.json` |
| 4 | B0 门控反例 5 例 | `node scripts/lib/guard-negative-check.mjs` | `5/5 PASS` + `additional check: PASS`（无 guard 标记时即使证据完美也不缓解）、`exit 0`；逐例：a `status=1 mitigated=false reasons=RESULTS_NOT_FRESH,TEST_FAILURE_IN_OUTPUT`；b `RESULTS_NOT_FRESH,SUMMARY_NOT_FRESH`；c `COVERAGE_BELOW_MINIMUM`；d `RESULTS_NOT_SUCCESS,RESULTS_FAILED_TESTS,TEST_FAILURE_IN_OUTPUT`；e 正例 `status=0 mitigated=true` | **PASS** | `reports/r2-1-negative-verification.json` |
| 4b | 是否「自证」核查（读码） | 阅读 `guard-negative-check.mjs` + `vitest-run.mjs` | **真的 spawn**：`runVitestGuarded()` 内 `spawnSync(process.execPath, argv, {shell:false…})` 驱动真实子脚本 `simulated-vitest.mjs`，子进程 `writeFileSync` 写两份**真实证据文件**、`utimesSync` **真回拨 180s**、按配置 `process.exit(1)`；断言基于 guard 的**真实返回值**与真实写出的 `reports/vitest-guard.json`。**不是自证**：case b 的 `RESULTS_NOT_FRESH` 只可能由回拨 mtime 触发。**限定**：5 例跑在 `mkdtempSync()` 临时工作区，不触碰仓库 `reports/`（隔离是优点，但意味着它不验证仓库现场，仓库现场由本报告第 9/10 项另行证伪） | **PASS** | `scripts/lib/guard-negative-check.mjs:51-70,164-234`；`scripts/lib/vitest-run.mjs:214-224,253-291` |
| 5a | 分层守卫 | `node scripts/check-layering.mjs --json` | `violations: []`、`violationsCount: 0`、`exit 0`；`targets` 明确含 **`packages/ui/src`**，UI 禁用 `electron`/`node:fs`/`child_process`；实际扫描 **71 个文件**（shared 15 + core 36 + engine 14 + ui 6），**非空扫** | **PASS** | `reports/_qa-layering.json` |
| 5b | 类型检查 | `pnpm turbo run typecheck --force` | `Tasks: 5 successful, 5 total` / `Cached: 0 cached, 5 total` / `exit 0`（5 包全量强制重跑，非缓存命中） | **PASS** | 本报告命令输出 |
| 5c | 运行时 | `node scripts/check-runtime.mjs --json` | `requiredOk: 3/3`、`failed: 0`、`optionalMissing: 1`（aria2c，符合 D 记录「OPTIONAL 缺失不判 FAIL」）、`exit 0` | **PASS** | `reports/_qa-runtime.json` |
| 6 | 冻结文件零改动 | `git diff HEAD -- packages/shared/src/request.ts pnpm-lock.yaml package.json` | **输出 0 行**（三者全部零改动，比任务书「package.json 只允许 test:e2e 一行」更严）；`package.json` 中 `"test:e2e"` 出现次数 = 1 | **PASS** | 本报告命令输出 |
| 6b | 冻结块逐字节一致 | 自写比对脚本（`git show HEAD:` vs 工作区，CRLF 归一后比） | `EXPECTED_MINIMAL identical: true`（513 字节整块）、`DOWNLOAD_ARGV_FROZEN_ORDER identical: true`（557 字节整块） | **PASS** | 本报告命令输出；`scripts/acceptance.mjs:507-524` 有等价实现 |
| 7 | **PNG 基线反例** | 用 `subtitle-ready.png` 覆盖 `format-ready.png` → `npm run test:e2e` | **`exit 1`**，`FAIL format-ready … pixel=false (114699 px)`，`13/14 cases PASS`，`allPass=false`；还原后 **`exit 1 → exit 0`**，SHA-256 前后一致 `5bf225cf…fbb2` | **PASS（真失败）** | `reports/_qa-e2e-neg-png.log`、`reports/_qa-e2e-restore-png.log`、`reports/_qa-baseline-sha-before.txt` |
| 8 | **DOM 基线反例** | 向 `format-ready.dom.html` 追加 `<!-- QA-CORRUPTED -->` → `npm run test:e2e` | **`exit 1`**，`FAIL format-ready … snapshot=false pixel=true (0 px)`（即判据①挂、判据②无关，定位精确）；还原后 **`exit 1 → exit 0`**，SHA-256 前后一致 `273983c4…7691`，`git status -- tests/e2e/baselines` 为空 | **PASS（真失败）** | `reports/_qa-e2e-neg-dom.log`、`reports/_qa-e2e-restore-dom.log`、`reports/_qa-dom-sha-before.txt` |
| 9 | **陈旧证据反例** | 手造 `reports/vitest-results.json`（`success:true,numFailedTests:0`）并回拨 mtime −180s + 改坏 `format-selector.test.ts` 一条断言 → `npm test` | **`exit 1`**；`vitest-guard.json` 记 `decision:"REJECTED"`、`guardMitigated:false`、`evidenceRemovedBeforeSpawn.results:true`、`reasons:[RESULTS_NOT_SUCCESS, RESULTS_FAILED_TESTS, SUMMARY_MISSING, GUARD_MARKER_ABSENT, TEST_FAILURE_IN_OUTPUT]` → **陈旧成功证据在 spawn 前被单文件 unlink 清掉，完全未被采信** | **PASS（未被缓解）** | `reports/_qa-test-neg9.log`、`reports/vitest-guard.json`（该次快照见本报告） |
| 9b | 现场还原 | `git checkout -- tests/unit/format-selector.test.ts` | 归一化（LF）SHA-256 **与 HEAD 完全一致**：`2c0e206c…9159`；原始字节 SHA 由 `2c0e206c…` 变为 `fb3cdb0f…` 仅因 `core.autocrlf` 在 checkout 时写回 CRLF（`git diff` 为空，`git status` 不显示该文件） | **PASS（附 EOL 说明）** | 本报告命令输出 |
| 10 | **覆盖率反例** | 在**仓库根**直接调真实 `runVitestGuarded()`（自写 driver + 真子进程），branches=69% + 新鲜全绿证据 + guard 标记，`exit 1` | `status:1, guardMitigated:false, decision:REJECTED, reasons:[COVERAGE_BELOW_MINIMUM], coverageMinimum:69`；**正例对照**同一驱动 branches=71% → `status:0, MITIGATED, reasons:[]` → 证明拒绝不是「恒拒」，阈值判定真实踩线 | **PASS** | `reports/_qa-neg/driver.mjs`、`reports/_qa-neg/child.mjs`（用完即弃，随后由 `npm test` 还原证据） |
| 10b | 现场还原 | `npm test` 重跑 | `33 passed (33)` / `464 passed` / 覆盖率回到 `93.89 \| 86.24 \| 94.47 \| 93.89` / `exit 0`；随后 `--milestone M3` 重跑回 `allGreen=true` | **PASS** | `reports/_qa-test-final.log`、`reports/_qa-acc-m3-final.log` |
| 11 | **恒真兜底扫描** | `grep` 于 `tests/**`、`packages/**`、`scripts/**` | `expect(true)` **0 处**；`|| true` **0 处**；`?? true` **2 处**（`tests/unit/helpers/in-memory-ports.ts:203` 测试替身默认值、`packages/core/src/task-queue/task-queue.ts:299` 产品默认值，均**不掩盖失败**）；`skipIf` / `it.skip` / `describe.skip` / `test.skip` / `.todo(` **全部 0 处**；`toBe(true)` **140 处**逐点抽查均为真实表达式（`dto.confirmed`、`Array.isArray(...)`、`report.ok`、`existsSync(YTDLP)` 等）；`toBeTruthy()` 2 处（`artifact-local.test.ts:64` 断言 skip 必须给出理由——反向保护；`u3-verify-manifest-preserve.test.ts:109` 断言常量字段非空——**弱断言，但无害**） | **PASS（2 处弱断言已标注）** | 本报告命令输出 |
| 12 | 断言真实性抽查 6 条 | 逐条定位实际判定逻辑 | 见 §4，**6 条均为真实判定，无手写 PASS 常量、无恒真**；其中 A-M3-04 / A-M3-06 按任务书要求单独深挖 | **PASS（含 1 项缺口 D1、1 项 evidence 松绑 D2）** | §4 |
| 13 | 凭据泄漏检查 | `grep -rn` 于 `packages/ui`、`reports/*.json`、`docs/M3-REPORT.md` | `packages/ui/src` 内 **无任何 `url` 值**（`probe-fixture.js` 只有剥离逻辑与注释）、**无 `http(s)://` 字面量**；`tests/e2e/fixtures/*` 仅出现 `"_type": "url"`（`PlaylistEntry` 合法枚举，非凭据字段）；`reports/e2e-summary.json` 中 `"url"` 键 **0 次**；`reports/acceptance-report-m3.json` **无任何 URL**；`reports/u3.json` / `u3-probe-raw.json` 仅含 M1 U3 本地直链 `http://127.0.0.1:1821`（本机 fixture，非凭据）；`docs/M3-REPORT.md` 仅 1 处 `http://…` 出现在 D-34 的 `--proxy` 说明文字中 | **PASS** | 本报告命令输出 |
| 14 | 工作区卫生 | `git status --short`；`git log --name-only -6 \| grep PROJECT-HANDOFF` | `M docs/PROJECT-HANDOFF.md`（用户 239 行未提交编辑，原样保留）+ `?? docs/PRD-M3.md` + `?? docs/ARCHITECTURE-M3.md`；**6 个 commit 内 `grep PROJECT-HANDOFF` 为空**，也不含 `PRD-M3` / `ARCHITECTURE-M3` / `M3-HANDOFF`，**无 `reports/*.json` 入库** | **PASS（附 1 项观察）** | 见 §5 D6：会话期间多出未跟踪 `docs/M3-HANDOFF.md`（11-06 10:58，30,428 字节，非本次 QA 产出，可能为工程师/主理人并行写入；不在 6 commit 内，不影响洁净性） |
| 15 | DECISIONS 一致性 | `grep -nE "^## D-(2[89]\|3[0-9]\|4[0-9]) ·"` | D-30…D-45 **恰好 16 条**、编号**连续升序无缺**；`草稿` **0 命中**；**D-31 = B4 离线技术路线偏离**、**D-32 = B0 R2-1 门控修复**（未颠倒）；D-31 正文含**缓存 exe 绝对路径** `…\chromium_headless_shell-1234\chrome-headless-shell-win64\chrome-headless-shell.exe` 与**版本** `Google Chrome for Testing 151.0.7922.34` | **PASS** | `docs/DECISIONS.md:353-497`；`scripts/acceptance.mjs:649-655` 有等价程序校验 |
| 16 | M3-REPORT 自洽 | 文档 ID 集合 vs `acceptance-report-m3.json` | 文档唯一 ID = **51** = 48 断言 + 3 条**明确单列**的回归复验（§5.3 标题写明「不计入 36」）；「在验收报告中但文档缺失」= **0**；末尾含 **「未获甲方放行，不进入 M4」**；文档正文数值（`464/464`、`86.24%`、`470/470`、`86.77%`、`114699 差异像素`）与本机实测**逐项吻合** | **PASS** | `reports/_qa-rep-ids.txt`、`docs/M3-REPORT.md:18-130` |

**汇总：16 / 16 PASS，0 FAIL，0 NOT VERIFIED。**（3 项带限定标注，均已在 §5 转成具体缺陷或观察项）

---

## 3. 证伪测试记录（第 7–10 项）

### 3.1 PNG 基线反例（第 7 项）

| 阶段 | 动作 | 实际 exit | 关键输出 | SHA-256 |
|---|---|---|---|---|
| 前 | `format-ready.png` = `5bf225cf…fbb2`；`subtitle-ready.png` = `d1bc73bb…d065` | — | — | 备份 `reports/_qa-neg/format-ready.png.bak` |
| 破 | `cp subtitle-ready.png format-ready.png`（整张换图） | — | 基线变为 `d1bc73bb…` | — |
| 测 | `npm run test:e2e` | **1** | `FAIL format-ready … pixel=false (114699 px)`；`13/14 cases PASS, 5/5 negative checks PASS, allPass=false` | — |
| 还原 | `cp` 回备份 | — | — | **`5bf225cf…fbb2` 与破坏前逐字节一致** |
| 复测 | `npm run test:e2e` | **0** | `14/14 cases PASS, 5/5, allPass=true` | — |

> 交叉校验：本机实测 114699 差异像素，与 `docs/M3-REPORT.md` 第 4 节自述的「114699 差异像素 / 11.2011%」**完全一致** —— 工程师披露的数字可复现，未虚报。

### 3.2 DOM 基线反例（第 8 项）

| 阶段 | 动作 | 实际 exit | 关键输出 | SHA-256 |
|---|---|---|---|---|
| 前 | `format-ready.dom.html` = `273983c4…7691` | — | 备份 `reports/_qa-neg/format-ready.dom.html.bak` | — |
| 破 | 文件末尾追加 `<!-- QA-CORRUPTED -->` | — | — | — |
| 测 | `npm run test:e2e` | **1** | `FAIL format-ready … snapshot=false pixel=true (0 px)`；`13/14`；`allPass=false` | — |
| 还原 | `cp` 回备份 | — | `git status --short -- tests/e2e/baselines` → **空** | **`273983c4…7691` 与破坏前一致** |
| 复测 | `npm run test:e2e` | **0** | `14/14 cases PASS, 5/5 negative checks PASS, allPass=true` | — |

### 3.3 陈旧证据反例（第 9 项）

```
# 1) 手造陈旧成功证据（mtime 回拨 180s，实测 03:06:26 vs now 03:09:26）
reports/vitest-results.json = {"success":true,"numTotalTests":464,"numPassedTests":464,"numFailedTests":0}
# 2) 同时改坏真实断言
tests/unit/format-selector.test.ts: expect(...).toBe('137+251+250')  ->  .toBe('QA-DELIBERATELY-WRONG')
# 3) npm test
exit = 1
Test Files  1 failed | 32 passed (33)
```

`reports/vitest-guard.json`（该次真实记录）：

```json
{ "originalStatus": 1, "status": 1, "guardMitigated": false, "decision": "REJECTED",
  "evidenceRemovedBeforeSpawn": { "results": true, "summary": true,
    "coverageTmp": { "method": "renamed" } },
  "reasons": ["RESULTS_NOT_SUCCESS","RESULTS_FAILED_TESTS","SUMMARY_MISSING",
              "GUARD_MARKER_ABSENT","TEST_FAILURE_IN_OUTPUT"] }
```

结论：**手造的 stale 成功证据在 spawn 之前就被单文件 `unlink` 清掉，guard 完全没有采信它**；真实失败原样 `exit 1`，**未被缓解**。
还原：`git checkout -- tests/unit/format-selector.test.ts` → **归一化 SHA-256 与 HEAD 完全一致（`2c0e206c…9159`）**；原始字节 SHA 变化仅来自 `core.autocrlf` 在 checkout 时写回 CRLF（`git diff` 为空）。

### 3.4 覆盖率反例（第 10 项）

在**仓库根**调用真实 `runVitestGuarded()`（真子进程写真实 `reports/vitest-results.json` + `coverage/coverage-summary.json`，真打印 guard 标记，真 `exit 1`）：

| 场景 | status | guardMitigated | decision | reasons | coverageMinimum |
|---|---|---|---|---|---|
| branches = **69%** + 新鲜全绿证据 + 标记 | **1** | false | **REJECTED** | `["COVERAGE_BELOW_MINIMUM"]` | 69 |
| branches = **71%** + 同上（正例对照） | 0 | **true** | MITIGATED | `[]` | 71 |

结论：**阈值判定真实踩线**（69 拒 / 71 过），不是「恒拒」也不是「恒过」。还原：`npm test` 重跑 → 覆盖率回到 `93.89 | 86.24 | 94.47 | 93.89`、`464/464`、`exit 0`，随后 `--milestone M3` 回 `allGreen=true`。

### 3.5 反例测试后的现场还原证据（汇总裁决）

| 对象 | 还原方式 | 校验 |
|---|---|---|
| `tests/e2e/baselines/format-ready.png` | 备份 cp 回 | SHA-256 `5bf225cf…fbb2` **与破坏前一致**，`npm run test:e2e` `exit 0` |
| `tests/e2e/baselines/format-ready.dom.html` | 备份 cp 回 | SHA-256 `273983c4…7691` **一致**，`git status -- tests/e2e/baselines` 空，`exit 0` |
| `tests/unit/format-selector.test.ts` | `git checkout --` | LF 归一 SHA-256 `2c0e206c…9159` **= HEAD**，`git diff` 空 |
| `reports/vitest-results.json` / `coverage/coverage-summary.json` | `npm test` 真实重跑 | `464 passed` / 四维 `93.89\|86.24\|94.47\|93.89` |
| `reports/acceptance-report*.json` | `--milestone M1/M2/M3` 真实重跑 | M1 `17/17`、M2 `37/37`、M3 `48/48`，三份 `allGreen=true` 并存，`latest=M3` |
| 临时代码 `reports/_qa-neg/*.mjs` | 仅置于 `reports/`（`.gitignore` 已忽略），未入库 | `git status` 不含 |

---

## 4. 恒真兜底扫描 与 断言真实性抽查

### 4.1 恒真兜底扫描结果

| 模式 | 命中数 | 判断 |
|---|---|---|
| `expect(true)` | **0** | 无恒真 |
| `|| true` | **0** | 无吞错 |
| `?? true` | 2 | `in-memory-ports.ts:203`（测试替身默认 `killResult`）、`task-queue.ts:299`（产品默认 `retryable`）—— 均为**默认值语义**，不掩盖失败 |
| `skipIf` / `it.skip` / `describe.skip` / `test.skip` / `.todo(` | **0** | 没有以跳过换绿 |
| `toBe(true)` | 140 | 逐点抽查 25 处，全部包裹真实表达式（`dto.confirmed` / `Array.isArray(info.formats)` / `report.ok` / `existsSync(YTDLP)` / `intermediate.some(e=>e.speedBps>0)`） |
| `toBeTruthy()` | 2 | ① `artifact-local.test.ts:64`「skip 必须给出理由」= 反向保护，**好**；② `u3-verify-manifest-preserve.test.ts:109` 断言常量非空 = **弱断言**（P4，无害） |

### 4.2 断言真实性抽查（6 条，逐条给实际判定逻辑）

| 抽样 | 断言 ID | 实际判定逻辑（代码位置） | 结论 |
|---|---|---|---|
| §4.2 | **A-4.2-07**（音频质量 6 档 abr~192/128/64/32 + best/lowest） | `tests/unit/argv-builder-m3.test.ts:157-247`：64 组组合循环（8 质量 ×2 编码 ×6 音频 ×5 字幕 ×4 路径），对每组断言 `argv[-S+1]` **整串等于** `[res:N][vcodec:*][abr~N]` 的合成；另有 R1 正例（`--audio-format mp3` → `join(' ')` **不含** `abr~`）与 R1 负例（`-S` 含 `abr~128` 且不含 `--audio-format`）。**真实判定，非常量** | **PASS**，但见 D2 |
| §4.3 | **A-4.3-04**（自动翻译开启 → 命令不含 `skip=translated_subs`） | `packages/core/src/decision/download-plan.ts:214` `skipTranslatedSubs = autoCaptions && subtitle.skipTranslated===true`；`argv-builder-download.ts:111-113` 仅当 `autoCaptions && skipTranslatedSubs` 才 push `--extractor-args youtube:skip=translated_subs`。测试侧：`subtitle-planner.test.ts:86-97` 断言 `skipTranslated:false` **透传**；`argv-builder-m3.test.ts:408-414` 只覆盖 `autoCaptions:false` 的关闭路径；`download-plan.test.ts:377-379` 覆盖 2 个组合。**实现正确，但「autoCaptions=true && skipTranslated=false → 无该参数」这一 argv 级反向分支无测试** | **PASS（实现正确）**，测试缺口 = **D1** |
| §4.4 | **A-4.4-03**（`buildOutputDir()` 四组合 00/10/01/11） | `tests/unit/path-resolver.test.ts` buildOutputDir 四组合断言 + `argv-builder-m3.test.ts:186-190` 的 `EXPECTED_DIRS` 在 64 组循环中逐组断言 `-P` 实值 4 种轮转；两条独立路径互相印证 | **PASS** |
| A-M3-04 | **A-M3-04**（播放列表确认不入队） | 三重真实断言：① `dialog-dto.contract.test.ts:138-155` 断言回写 DTO 键集合**精确等于** `[confirmed,kind,selectedPlaylistIds,state]`、`selectedPlaylistIds=['a1','a2','a3']`、`requestPatch` 为 `undefined`，并对序列化串逐词禁 `requestPatch/enqueueBatch/TaskRecord/mergeToMkv/taskId/url/customCommand`；② `playlist-fixture.contract.test.ts:99-108` 断言网关**拒绝**带 `requestPatch` 的 playlist 确认（`rejects.toThrow(/must not carry a requestPatch/)`），且合法确认返回**精确对象** `{accepted:true,persisted:true,enqueued:false}`；③ `scripts/e2e-cases.mjs:202-204` DOM 断言 `no-request-patch`（缺席）+ `writeback-selected-ids`，且 DOM 基线整文件比对。**真断言「无 requestPatch / 无 TaskRecord / enqueued:false」**；`data-enqueue-batch="never"` 为对话框自写属性（自证成分）→ 见 D5 | **PASS（含 D5 限定）** |
| A-M3-06 | **A-M3-06**（截图回归真比像素） | `scripts/run-e2e.mjs:296-310`：`comparePngBuffers(baselinePng, tempPng, {tolerance:2, maxRatio:0})`，`scripts/lib/png-diff.mjs` 用 `node:zlib` 解 IDAT + filter 0–4 逆变换后逐像素 RGBA 比对，尺寸必须 1280×800，`maxRatio=0`（比 PRD 的 0.1% 更严）→ **1 像素差即 FAIL**。**本报告第 7/8 项已用外部破坏独立证伪**：换图 → `exit 1 / 114699 px`，加注释 → `exit 1 / snapshot=false` | **PASS（已独立证伪）** |
| A-M3-08 | **A-M3-08**（保留名大小写不敏感 / 259·260·261） | `tests/unit/path-resolver.test.ts:65-72` 对 `['CON','con','Con.txt','PRN','aux','NUL.log','com1','COM9','LPT1','lpt9.srt']` 逐个断言输出**不匹配** `/^(CON\|PRN\|AUX\|NUL\|COM[1-9]\|LPT[1-9])(\.\|$)/i`，并有「不误伤 CONSOLE 等普通名」的反向用例；`:149-165` 断言 259 原样、260/261 加 `\\?\` 前缀并截断 | **PASS** |

> **抽查结论**：6 条全部为**真实判定**，未发现「手写 PASS 常量」或「恒真断言」。`acceptance.mjs` 的 `evaluate()` 也无 truthy 兜底：`tests`/`e2e`/`needs` 任一不满足即 `FAIL` 并把原因写进 `actual`（`scripts/acceptance.mjs:686-717`）。

---

## 5. 缺陷清单

> 严重度口径：P0 阻断 / P1 严重 / P2 中等 / P3 轻微 / P4 观察。**本轮 P0–P2 = 0 项。**

| # | 文件:行号 | 严重度 | 复现命令 | 期望 vs 实际 | 路由 |
|---|---|---|---|---|---|
| **D1** | `tests/unit/argv-builder-m3.test.ts:408-414`（缺用例）；涉及 `packages/engine-ytdlp/src/argv-builder-download.ts:111-113` | **P3** | `grep -n "skipTranslated" tests/unit/argv-builder-m3.test.ts` → 仅 `autoCaptions:false` 分支 | 期望：存在「`autoCaptions:true && skipTranslated:false` → argv **不含** `--extractor-args`」用例；实际：该组合无 argv 级用例（实现逻辑正确，属测试缺口）。A-4.3-04 的「命令不含」只被间接覆盖 | **QA**（建议 M4 首批补 1 例；本轮不改以免污染已交付 464/470 计数） |
| **D2** | `scripts/acceptance.mjs:384`（A-4.2-07 的 `tests:[...,'format-selector']`）+ `tests/unit/argv-builder-m3.test.ts:176-178` | **P3** | `grep -n "audioQuality" tests/unit/format-selector.test.ts` → 仅出现在 fixture 默认值，无断言 | 期望：evidence 中列出的测试文件真的含该断言；实际：`format-selector.test.ts` 无 `audioQuality` 断言，判定实际全靠 `argv-builder-m3` 的 `ABR_FIELD` **镜像表**（与 `download-plan.ts:41-45` 重复定义）→ 实现与测试同改时存在**同步漂移**风险（不会假绿，但会漏检） | **QA**（可改为从实现导出常量或加交叉校验） |
| **D3** | `reports/m3-legacy-closure.json`（无生成脚本）+ `scripts/acceptance.mjs:639`（`legacyOk` 仅校验 `failed===0 && durationMs>0`） | **P3（最值得担心）** | `grep -rn "m3-legacy-closure" scripts` → 只有**读取**方，**无生成方**；按当前树统计该报告声称的 5 文件实测为 **129 例**（`argv-builder-m3 91 + task-queue 17 + progress-parser 12 + electron-shell-port 5 + shell-port 4`），报告写 **145 例** | 期望：证据工件可由仓库内脚本复现；实际：**手写/一次性脚本产物，不可复现**，且计数与当前树不符。`legacyOk` 的校验强度极低（任何手写 `{"summary":{"failed":0},"durationMs":1}` 都能过）→ 影响 `A-4.5-07`、`A-M3-12` 的 `needs:['legacy']` 与 `M3-GATE-docs`。**缓解**：C11 / D-18 / electron-shell 三项实质内容确由 470/470 真实运行承担（`task-queue.test.ts:321` C11、`argv-builder-m3.test.ts:449-474` D-18 均可定位），故不影响 M3 判绿结论 | **QA / Engineer**（建议 M4：把生成逻辑并入 `acceptance.mjs` 或独立 `scripts/m3-legacy-closure.mjs`，并让 gate 校验计数一致） |
| **D4** | `scripts/acceptance.mjs:675-684`（`durationFor` 取步骤最大值）+ `:752-762`（duration gate 只查 `>1`） | **P3** | `node -e "const r=require('./reports/acceptance-report-m3.json');new Set(r.assertions.map(a=>a.durationMs)).size"` → **1** | 期望：「48 条 durationMs 全为实测非零」意味着逐条测量；实际：48 条**同值**（77060），是「步骤级实测值共享」。字面不算虚报（确实非零且来自真实测量），但**不具区分度**，无法用于定位慢断言 | **QA**（M4 可将 `evaluate()` 包在计时器内逐条计） |
| **D5** | `packages/ui/src/dialogs/playlist-selector.js:94` + `tests/contract/dialog-dto.contract.test.ts:157-162` | **P4** | `grep -n "enqueue-batch" packages/ui/src/dialogs/playlist-selector.js` | 期望：「未调用 enqueueBatch」由 spy / 真实队列观测证明；实际：`data-enqueue-batch="never"` 是**对话框自己写死**的属性，测试断言「基线里存在该字符串」= 部分自证。**实质判定由 ①网关 `enqueued:false` 精确对象断言 ②DTO 键集合+禁词表 承担**，故风险低 | **QA**（可选：改为断言 UI 未 import 任何队列模块 + 网关返回对象精确相等，已部分具备） |
| **D6** | `docs/M3-HANDOFF.md`（未跟踪，30,428 字节，11-06 10:58） | **P4** | `git status --short` | 任务书预期工作区只有 `M PROJECT-HANDOFF.md` + `?? PRD-M3.md` + `?? ARCHITECTURE-M3.md`；实际多出 `?? docs/M3-HANDOFF.md`，该文件在本次复验**开始之后**出现（非 QA 产出，疑为并行写入），**不在 6 个 commit 内** | **NoOne**（提交前由主理人决定是否入库） |

---

## 6. 已知偏离复核（逐条：是否正当 / 是否留痕 / 是否虚报）

| 偏离 | 正当性 | 留痕 | 是否虚报 | 复核结论 |
|---|---|---|---|---|
| **D-28** 真实 L2 双流 ffmpeg 孤儿压测 SKIPPED | **正当**：U3 fixture 为 generic 单 format，不会拉起 ffmpeg 子进程，本轮物理不可复现 | `DECISIONS.md:470`、`reports/m3-legacy-closure.json` 标 `SKIPPED`、`acceptance.mjs:487` 偏离清单、`M3-REPORT.md:158` 三处一致 | **未虚报**：明确写「不判 FAIL、**不声称已压测孤儿**」，且未把 SKIPPED 计入 48 条 | **通过**（但证据工件不可复现 → D3） |
| **D-39** Electron shell 真实 BrowserWindow SKIPPED | **正当**：本机实测 `ls node_modules/electron/dist` → **No such file or directory**（无二进制），只能落 `IShellPort` 注入契约 | `DECISIONS.md` D-39、`M3-REPORT.md` §5.3 复验项写明「真实窗口启动 SKIPPED」、`acceptance.mjs` 偏离清单 | **未虚报**：`electron-shell-port.test.ts` 只声称「注入 fake shell 验证转发与错误传播」，未声称真窗口 | **通过** |
| **D-31** B4 载体偏离（React/MUI/`@playwright/test`/Electron renderer → 静态 HTML/CSS + 缓存 headless shell + `node:zlib` diff） | **正当**：本机实测 `node_modules/@playwright`、`node_modules/react`、`node_modules/@mui` **均不存在**；`pnpm-lock.yaml` 零改动；断言 ID、判据、三态门禁、五域回写全部不变，仅换载体 | 留痕最完整：`DECISIONS.md:362-371`（含实测 exe 路径/版本 + 后续补齐条件）、`ARCHITECTURE-M3 §1.5.3`、`M3-ACCEPT-4` 的 `actual/evidence` **明写「carrier=zero-dependency static HTML/CSS」**、`tests/e2e/README.md` | **未虚报**：从未声称已用 React/MUI/Playwright；`M3-REPORT` 验收④标题写「（离线载体判据）」 | **通过（但需甲方书面接受：验收④与原 PRD 字面不一致）** |
| **D-36** `--ppa` 恒不触发、封面裁剪降级为不裁剪 | **正当**：值含空格 + 随包 yt-dlp 支持性未实测，硬编码有注入风险 | `DECISIONS.md` D-36 + `A-4.2-10` 标题直接写「（`--ppa` 降级 D-36）」+ 64 组组合中**每组**断言 `expect(argv).not.toContain('--ppa')` | **未虚报**：断言口径就是「永不出现」，与偏离一致 | **通过（功能减项，须随 M4 补齐）** |
| **D-32** 门控 `coverage/.tmp` 改用 **rename** 而非删除 | **正当**：`rename` 不是 delete，不触碰 safe-delete 累计阈值；且**证据门控一道没放松**（我第 3.3/3.4 项已独立证伪：陈旧证据/低覆盖一律拒绝） | `DECISIONS.md:373-382`；`scripts/lib/vitest-run.mjs:273-289` 把 `method` **写进审计记录**（我实测记录中 `coverageTmp.method="renamed"`），失败才回退 `batched-unlink` | **未虚报**：`environmentMitigations` 为结构化对象数组，本次最终 M3 运行**真实记录了一次 `MITIGATED`**（`originalStatus:1, coverageMinimum:86.77, reasons:[]`），即环境确实触发过且如实披露 | **通过**（副作用：`coverage/.tmp-prev-<runId>` 目录累积 20+ 个，属卫生问题，`coverage/` 已被 `.gitignore` 忽略，不影响交付） |

---

## 7. 最终意见

**`PASS WITH MINOR ISSUES`**

| M3 四条验收标准 | 我的独立判定 | 依据 |
|---|---|---|
| ① ArgvBuilder 组合单测 ≥60 例 + 冻结顺序不回归 | **成立** | `argv-builder-m3.test.ts` **91 例**（含 64 组 8×2×6×5×4 全枚举）0 FAIL；`EXPECTED_MINIMAL`（513B）与 `DOWNLOAD_ARGV_FROZEN_ORDER`（557B）对 HEAD **逐字节一致**；`request.ts` / `pnpm-lock.yaml` / `package.json` `git diff` 全空 |
| ② 48 条断言全 PASS、0 FAIL、0 无证据 | **成立** | 连跑 4 次（3 次任务书要求 + 1 次还原态）均 `48/48 + 3/3 + 12/12 gates + 4/4 acceptance + allGreen=true + exit 0`；`evidence` 空值 0 项；每个测试文件映射 ≥1 断言 |
| ③ Windows 非法字符 / 保留名 / 260+ 长路径 | **成立** | `path-resolver.test.ts` 30 例真实断言（9 类非法字符、控制字符、`CON.txt` 大小写不敏感、259/260/261、UNC、`\\?\` 前缀、`%(title).200B`、4 组合预览） |
| ④ 三弹窗截图回归 | **成立（离线载体口径，D-31 需甲方书面接受）** | `npm run test:e2e` 连跑 3 次全绿（14/14 + 5/5），exe 版本实测匹配 151.0.7922.34；**我已用外部破坏独立证伪：换图 exit 1 / 114699 px，改 DOM exit 1 / snapshot=false，还原后 exit 0** |

**放行建议**：M3 可提交甲方验收；但请注意 **D3（`m3-legacy-closure.json` 不可复现且计数不符）** 与 **D-31 需书面接受**两项须在验收会上显式提出，M4 首批一并收口。**未获甲方放行前不得进入 M4**（与 `M3-REPORT` 的 `stopDeclaration` 一致）。

---

## 附录 A：本次复验产生的证据文件（均在 `.gitignore` 覆盖的 `reports/` 下，不入库）

| 文件 | 内容 |
|---|---|
| `reports/_qa-test-run1.log` / `_qa-test-final.log` | `npm test` 首次 / 还原后全量日志 |
| `reports/_qa-e2e-1.log` ~ `-3.log` | E2E 连跑 3 次日志 |
| `reports/_qa-e2e-neg-png.log` / `_qa-e2e-restore-png.log` | PNG 反例 / 还原 |
| `reports/_qa-e2e-neg-dom.log` / `_qa-e2e-restore-dom.log` | DOM 反例 / 还原 |
| `reports/_qa-test-neg9.log` | 陈旧证据 + 坏断言反例 |
| `reports/_qa-acc-m3-1.log` ~ `-3.log` / `-final.log` | M3 验收 4 次 |
| `reports/_qa-acc-m1.log` / `_qa-acc-m2.log` | M1 / M2 回归 |
| `reports/_qa-layering.json` / `_qa-runtime.json` | 分层 / 运行时实测 JSON |
| `reports/_qa-baseline-sha-before.txt` / `_qa-dom-sha-before.txt` / `_qa-fs-sha-before.txt` | 反例前的基线 / 测试文件 SHA-256 |
| `reports/_qa-rep-ids.txt` | `M3-REPORT.md` 抽取的 ID 集合 |
| `reports/_qa-neg/driver.mjs` / `child.mjs` / `*.bak` | 覆盖率反例驱动与备份（用完即弃） |

## 附录 B：复验方法学声明（可审计）

1. **不使用工程师的现成报告作为判据**：所有 PASS 均基于本次运行的 stdout / exit code / 新写出的 JSON；工程师自述数字只作为「是否虚报」的比对基准。
2. **反例优先**：对 4 类关键证据（PNG、DOM、vitest 结果新鲜度、覆盖率阈值）各构造至少 1 次真实破坏，并要求**真失败**；破坏后必须还原并附 SHA-256 / `git status` 证据。
3. **读码验证门控不是自证**：`guard-negative-check` 与 `run-e2e` 是否真 spawn、是否真控制 mtime、是否真比像素，均逐行读实现后在仓库现场另做独立复现（第 3.3 / 3.4 / 3.1 / 3.2 项）。
4. **不改产品代码**：`packages/**`、`apps/**` 全程只读；仅对测试文件做过一次临时破坏并已 `git checkout` 还原（归一化 SHA 与 HEAD 一致）。
5. **未验证即声明**：本报告无 `NOT VERIFIED` 项——若某一项未能真正验证，会在对应行的结论列写 `NOT VERIFIED` 并给出原因，而不是填 PASS。
