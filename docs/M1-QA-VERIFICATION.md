# YTVDLT · M1 独立 QA 复验报告（证伪视角）

> 复验人：严过关（Yan）· QA 工程师 ｜ 日期：2026-11-05
> 复验对象：寇豆码（Kou）M1 交付，自报 `IS_PASS: YES` / 17/17 断言全绿 / 覆盖率 81.5%
> 环境：Windows x64 ／ 开发 Node v22.22.2 ／ pnpm 9.15.9 ／ 运行时 `resources/runtime/win-x64` 已就位
> 原则：**不盖章**。每条结论都附我自己的执行证据；工程师的报告只作对照物，不作判据。
> 证据目录：`reports/qa-evidence/`（18 个原始日志/JSON，均为我本轮实跑产物）

---

## 0. 复验结论

| 项 | 结论 |
|---|---|
| **总判定** | **PASS-WITH-ISSUES**（可放行 M2，但须先修 4 处 P2 级"证据/门控"缺陷；均为脚本与文档层，**不触及业务代码**） |
| 17 条「M1 必须绿」断言 | **17 PASS / 0 FAIL / 0 SKIPPED**（逐条独立复算，见 §3） |
| §8 M1 五条验收 | **5/5 PASS**（见 §2） |
| 假绿排查（5 条） | 4 条通过；**1 条发现真缺陷**（`acceptance.mjs` 分层守卫恒真兜底） |
| 静态抽查（9 条） | 9 条通过；一致性上发现 **2 处文档夸大**（`vitest.config.ts` 注释 / `DECISIONS.md` D-11） |
| 负向测试 | **实测通过**：隐藏 `node.exe` → `JS_RUNTIME_MISSING` + 退出码 **2**，不崩溃；恢复后退出码 **0**，二进制 SHA-256 未变 |
| 阻塞级问题 | **0 个**（未发现业务代码缺陷） |
| 非阻塞问题 | 7 个（P2×4、P3×3，见 §7） |
| 是否建议放行 M2 | **建议放行（条件性）**：先修 P2-1～P2-4，再以修正后的 `acceptance.mjs` 重跑一次留证 |

**一句话**：M1 的功能与契约是**真绿**——我独立重跑了全部 9 条命令、独立复算了 12 项运行时哈希（两种独立实现：Node `crypto` 全量 + PowerShell `Get-FileHash` 抽检）、独立重算覆盖率四维、并对 `node.exe` 做了真实的负向破坏测试，结果与工程师自报一致。但**证据链有两处"报告比事实好看"**：验收④的命令不可复现（自报 100%/15 例，实跑 52.17%/7 例），以及分层断言存在恒真兜底。这两处不影响功能真实性，但必须纠正，否则 M2 起所有验收结论的可信度会被削弱。

---

## 1. 假绿排查（最高优先级，逐条给结论）

### 1.1 `scripts/acceptance.mjs`：真解析，还是硬编码 PASS？→ **真解析 + 1 处恒真兜底**

**是真解析**。17 条状态全部来自对 `reports/vitest-results.json`、`coverage/coverage-summary.json`、`reports/check-runtime.json`、`reports/u3.json`、`reports/layering.json` 的**实际读取**，且默认每次运行都**重新采集**证据（任一步失败即整体退出 1）：

```js
// scripts/acceptance.mjs:84-92
const vitestResult = run([
  vitestCli, 'run',
  '--reporter=json', `--outputFile=${join(REPORTS,'vitest-results.json')}`,
  '--coverage',
]);
if ((vitestResult.status ?? 1) !== 0) {
  console.error('[acceptance] evidence collection: vitest suite failed');
  return false;
}
```
```js
// scripts/acceptance.mjs:93-104 —— 三个脚本也是真跑，失败即整体失败
for (const [script, args] of extras) {
  const result = run([join(ROOT, script), ...args]);
  if ((result.status ?? 1) !== 0) { console.error(`[acceptance] evidence collection: ${script} failed`); return false; }
}
```
```js
// scripts/acceptance.mjs:158-161 —— 判据来自 vitest 真实结果，不是常量
const testOk = (c) => c.total > 0 && c.failed === 0;
const allVitestGreen = vitest
  ? vitest.numFailedTests === 0 && vitest.numTotalTests > 0 && vitest.success === true
  : false;
```

**但第 172 行有恒真兜底（真缺陷，我判为 P2-2）**：

```js
// scripts/acceptance.mjs:172
const layeringZero = layering?.violations === 0 || (await exists(join(ROOT,'scripts','check-layering.mjs')));
```

只要 `check-layering.mjs` 这个**文件存在**，`layeringZero` 就恒为 `true`；即使 `reports/layering.json` 报出 50 处违规，`A-INF-01` 仍会 PASS。我核对过当前 `reports/layering.json` 确为 `violations: 0`，**所以本次结论不受影响**，但门控本身必须去掉 `|| exists(...)`。

**另一处占位（P3-1）**：`item()` 把 `durationMs` 硬编码为 `0`（第 216 行），而 HANDOFF §7.3 要求每项含**实测** `durationMs`。

**判定口径弱点（知情即可）**：多数断言是"该测试文件跑了 >0 例且 0 失败"的**存在性判定**，不是对 PRD §3.9 判定条件的逐条复算。聚合层不理解断言语义，语义正确性只能人工对照测试文件——我已逐条对照（§3），实质成立。

### 1.2 根 `package.json` 脚本是否放水？→ **M1 通过（`npm test` = unit + contract，无放水参数）**

```json
"test": "node scripts/run-tests.mjs all",
"test:unit": "node scripts/run-tests.mjs unit",
"test:contract": "node scripts/run-tests.mjs contract",
"test:integration:offline": "node scripts/run-tests.mjs integration"
```
```js
// scripts/run-tests.mjs:32-37
const targets = {
  all: ['tests/unit', 'tests/contract'],
  unit: ['tests/unit'],
  contract: ['tests/contract'],
  integration: ['tests/integration/offline'],
}[mode];
```
```ts
// vitest.config.ts:30
passWithNoTests: false,
```

- `npm test` 真跑 `tests/unit` + `tests/contract` 两个目录（我实跑：11 文件 / **87 例** / 退出 0），**不是**空转、**不是**只跑一个。
- 无 `--passWithNoTests`、无 `--bail=0` 之类放水参数；`test:contract` 实跑 **11 例**、`test:integration:offline` 实跑 **1 例**，均非空转。
- **但**：`npm test` **不传 `--coverage`**，所以 `npm test` 本身**不执行** 70% 覆盖率门控（详见 P3-2）。

### 1.3 测试里有无 `.skip`/`.todo`/`only`/恒真 mock？→ **无禁用标记；假端口未让 probe 永真**

- 全库搜 `tests/`：`.skip`、`.todo`、`xit`、`xdescribe`、`.only`、`.fails` → **0 命中**（唯一匹配是 `logger.test.ts:3` 注释中的 "exit contract"，属误报；我在 Vitest 输出里也未看到 skipped 计数）。
- `tests/unit/helpers/in-memory-ports.ts` 的假 `ProcessPort` 对**未登记**的 spawn 返回默认"成功"：

```ts
// tests/unit/helpers/in-memory-ports.ts:149-155
async spawn(file, argv, opts) {
  state.spawnCalls.push({ file, argv, opts });
  for (const [matcher, result] of state.spawnResults) if (file.includes(matcher)) return result;
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
}
```
  这个默认成功**不会**让 probe 变永真：空 stdout 会让 `JSON.parse` 抛错 → 引擎抛 `UNKNOWN`（`yt-dlp-engine.ts:108-114`）。契约测试是**显式登记** `info-video.json` 作为 stdout（`download-engine.contract.test.ts:22-24`），属合法 L1 录制回放。
- **关键反证**：L2 的 `probe-local` 用**真实 spawn**（`tests/integration/helpers/real-process-port.ts`，`spawn(file,[...argv],{shell:false,windowsHide:true})`），不是假端口。我实跑复现：**1 例通过、2067 ms**，真的拉起了 `yt-dlp.exe`。

### 1.4 `vitest.config.ts` 的 thresholds 是否真为 70、有无绕过？→ **真为 70，且实测生效；但存在"定向运行豁免"**

```ts
// vitest.config.ts:42-50
...(targetedRun ? {} : {
  thresholds: { lines: 70, branches: 70, functions: 70, statements: 70 },
}),
```
```ts
// vitest.config.ts:11-15 —— 定向运行的豁免条件
const cliArgs = process.argv.slice(2);
const targetedRun =
  cliArgs.some((arg) => /\.test\.ts$/.test(arg)) ||
  cliArgs.includes('--testNamePattern') || cliArgs.includes('-t');
```

- 无 `skipFull`、无 `passWithNoTests`、无 `only CI` 条件。
- **我做了主动证伪**：用**目录**过滤（`tests/contract`，不命中 `targetedRun`）跑 `--coverage`，阈值立即生效：

```
$ pnpm exec vitest run tests/contract --coverage        # EXIT=1
ERROR: Coverage for lines (53.69%) does not meet global threshold (70%)
ERROR: Coverage for functions (60%) does not meet global threshold (70%)
ERROR: Coverage for statements (53.69%) does not meet global threshold (70%)
ERROR: Coverage for branches (62.5%) does not meet global threshold (70%)
```
  证据：`reports/qa-evidence/09-threshold-proof.log`。**阈值是真的，不是装饰。**
- **但**：豁免条件过宽——任何带 `.test.ts` 参数或 `-t` 的运行都免检（P3-3）。这既让验收④的"定向覆盖率"变成无门控数字，也正是 1.5/§7 P2-1 缺陷的温床。

### 1.5 `reports/acceptance-report.json` 的 `evidence` 是真实输出还是占位？→ **真实路径引用，非模板占位；但粒度粗**

`evidence` 字段全部是**真实存在的文件/用例路径**（非 `<TODO>`、非 `"PASS"` 字面量），例如：

```
A-INF-04 ; L0 ; PASS ; expected: check-runtime 3 必需 OK + aria2c OPTIONAL
         ; actual: allRequiredOk=true ; evidence: reports/check-runtime.json
A-INF-06 ; L0 ; PASS ; actual: min=81.53% dims={"lines":93.71,...}
         ; evidence: coverage/coverage-summary.json, reports/vitest-results.json
A-INF-07 ; L2 ; PASS ; actual: integration=1 tests, U3=SUPPORTED
         ; evidence: tests/integration/offline/probe-local.test.ts, reports/u3.json
```

我逐条打开这些被引用的文件，内容与 `actual` 一致。**唯一例外**：`durationMs` 全为 `0`（占位，P3-1）。此外 `actual` 多为计数（如 `9 tests`），不含断言级细节——粒度粗，但**不构成造假**。

---

## 2. §8 M1 五条验收 —— 逐条判定

| # | 验收标准 | 我执行的命令 | 实测结果 | 判定 |
|---|---|---|---|---|
| ① | `npm run check-runtime` 4 项通过 | `npm run check-runtime`（退出 **0**）；`node scripts/check-runtime.mjs --json`（退出 **0**）；负向：隐藏 `node.exe` | `ytdlp OK 2026.10.26` / `ffmpeg OK n9.0.2-47-gb204e94e90-20261104` / `node OK v24.22.2` / `aria2c OPTIONAL`；`allRequiredOk=true summary={"requiredOk":3,"requiredTotal":3,"optionalMissing":1,"failed":0}`；路径均为 `resources\runtime\win-x64` 下**绝对路径**；版本号非空 | **PASS** |
| ② | fixture 驱动 `JsonMapper` 单测全绿 | `npm run test:contract`（退出 **0**）；`npm test` 中的 `json-mapper.test.ts` | 2 文件 / **11 例**全绿；`json-mapper.test.ts` 8 例；fixture 含 `info-video.json` + `info-flat-playlist.json` + `info-minimal.json`（≥1 视频 + ≥1 平铺播放列表）；测试内**无** `fetch`/`http.request`/`net.connect`，**无** spawn | **PASS** |
| ③ | `probe()` 对本地 fixture 返回完整 `MediaInfo` | `npm run test:integration:offline -- --case probe-local`（退出 **0**） | 1 例通过 / 2067 ms；断言真实 spawn 绝对路径 + `shell:false` + `windowsHide:true` + `--js-runtimes node:<abs>`；`reports/u3.json` 独立复跑同样 `conclusion=SUPPORTED`、`probe.exitCode=0`、`download.exitCode=0` | **PASS**（附观察 O-6） |
| ④ | `ArgvBuilder` 骨架单测覆盖 probe 分支 | `npm run test:unit -- --run ArgvBuilder --coverage`（退出 **0**）；全量 `pnpm exec vitest run --coverage` | argv 逐元素断言**真实硬编码期望值**（`EXPECTED_BASE`，非引用实现常量）→ 全量覆盖率 `argv-builder.ts` 四维 **100%**；**但**工程师报告引用的该命令实跑只得 **7 passed / 8 skipped**、`argv-builder.ts` **stmts 69.23 / branch 52.17 / funcs 66.66 / lines 69.23** | **PASS（实质）+ P2-1（证据不实）** |
| ⑤ | Core 覆盖率四维最低 ≥70% | `npm test`（退出 **0**）；`pnpm exec vitest run --coverage`（退出 **0**） | 我独立读取 `coverage/coverage-summary.json`：lines **93.71%**、branches **81.53%**、functions **92.70%**、statements **93.71%**，最低 **81.53% ≥70%**；12 文件 / **88 例**全绿 | **PASS** |

---
## 3. 17 条「M1 必须绿」断言 —— 逐条判定表

> 判定条件取自 `docs/PRD-M1.md` §3.1/§3.4/§3.5/§3.8/§3.9；用例名为我实际打开的测试文件中的 `describe/it` 原文；"实测"为我本轮跑出的结果，不是引用工程师报告。

| # | 断言 ID | 判定条件（PRD 摘要） | 对应测试文件 / 用例名 | 我的实测结果 | 判定 |
|---|---|---|---|---|---|
| 1 | **A-4.1-03** | `saved_links` 写入 2 条→落盘→重载仍在；文件损坏→回退默认 + WARNING | `tests/unit/config-store.test.ts` → `A-4.1-03 ConfigStore · saved_links 重启保持 + 损坏回退 WARNING`（3 例）：`persists 2 saved links across a fresh instance` / `loads the recorded valid fixture (2 saved links) without mutation` / `corrupt JSON -> defaults + WARNING + backup file` | 9 例全绿；损坏回退断言 `WARNING` 事件 = 1 次且 `payload.fallback='defaults'`，并生成 `config.corrupt-*` 备份 | **PASS** |
| 2 | **A-4.1-04** | 录制 `--dump-single-json` → `MediaInfo`，`title/uploader/duration/thumbnail/formats[]/subtitles/chapters` 齐全且类型正确 | `tests/contract/json-mapper.contract.test.ts` → `every MediaInfo field exists with the contracted type`；`tests/unit/json-mapper.test.ts` → `maps every MediaInfo field with correct types from info-video.json` | 逐字段类型断言（含每 format 的 `format_id/ext/vcodec/acodec/width/filesize`、`subtitles`、`automatic_captions`、`chapters`、`_type`）全绿；`info-video.json` + `info-flat-playlist.json` 均存在 | **PASS** |
| 3 | **A-4.4-19** | 7 域 / `schemaVersion` / 迁移链 / 原子写（tmp→rename） | `config-store.test.ts` → `A-4.4-19 ConfigStore · 分域 / schemaVersion / 原子写`（5 例）：7 域齐全、`schemaVersion=1`、`writeTextAtomic` 后 `.tmp` 不存在、v0→v1 迁移、降级回退 | 断言原子写后 `state.files.has(path+'.tmp')===false`，迁移后持久化 `schemaVersion=1` | **PASS** |
| 4 | **A-4.4-30** | JSONL 结构化行；argv / Cookie / 凭据 / token 全掩码 | `tests/unit/logger.test.ts` → `emits one parseable JSON object per line`、`masks EVERY sensitive key/value in a nested payload`（19 类样例，要求 ≥12）、`logArgv · keeps option names but masks the following value` | 19 类敏感键逐类断言"值不出现"；`SENSITIVE_KEYS.length ≥ 12` 断言成立；`redactArgv(['--cookies=abc.txt'])` → `--cookies=<redacted>` | **PASS** |
| 5 | **A-4.5-03** | `example.invalid` 的 stderr → `UNSUPPORTED_SITE` + `retryable` + 保留原文 + 脱敏 report，不抛异常 | `tests/unit/error-mapper.test.ts` → `example.invalid stderr -> UNSUPPORTED_SITE, retryable=false, no throw` | fixture `stderr-unsupported.txt` 实读；断言 `code==='UNSUPPORTED_SITE'`、`retryable===false`、`detail` 含 `example.invalid`；映射过程未抛异常 | **PASS** |
| 6 | **A-4.5-05** | 超时 / DNS / 403 / 429 四类 stderr → 各自专用码且**互斥** | `error-mapper.test.ts` → `maps each of the 4 stderr samples to its own distinct code` + `uses an ORDERED rule table with FIRST-match semantics` + `retryable flags match §4.7` | 4 类映射为 `HTTP_429/HTTP_403/DNS_FAILURE/NETWORK_TIMEOUT`，`new Set(codes).size===4`（互斥成立）；组合行（`429 ... timed out`）首次命中优先级生效 | **PASS** |
| 7 | **A-4.5-09** | `AppError.report` 含 OS/应用版本/引擎版本/URL/完整 stderr，且 Cookie 与凭据已掩码 | `error-mapper.test.ts` → `report contains timestamp/os/appVersion/engineVersion/code/url/stderr/argv` + `report masks cookies, credentials and URL userinfo`；`logger.test.ts` → `writeCrashReport returns a path and never logs raw credentials` | report 是**可 `JSON.parse` 的字符串**，8 个字段逐一断言；5 个明文密钥（含 URL userinfo `PA55WORD`、`C:/secret/cookies.txt`）在 `report` 与 `detail` 中均不出现 | **PASS** |
| 8 | **A-INF-01** | workspace 全解析；`shared` 导出 §6.4 全部类型；`core`/`engine-ytdlp` import 图不含 `electron` | `tests/unit/shared-contract.test.ts`（10 例）+ `tests/unit/layering.test.ts`（2 例）+ `scripts/check-layering.mjs` + `pnpm turbo run typecheck --force` | 我实跑：`typecheck` **4/4 成功、Cached 0（强制不走缓存）**；`check-layering` **0 violations**；`grep` 确认 `packages/**` 内 `from 'electron'` 与 `from 'node:*'` **0 命中**；`packages/ui` 不存在（有单测断言） | **PASS** |
| 9 | **A-INF-02** | 运行时 4 项 + `FFMPEG-LICENSE.txt`；manifest 全项 SHA-256 与磁盘一致；`extraResources`(from→runtime)；`app.isPackaged` 双路径；runtime 不在 asar | 我**独立复算**（不信 manifest 自报）+ `apps/desktop/electron-builder.yml` + `apps/desktop/src/main/runtime-paths.ts` | 12/12 项 SHA-256 **独立复算一致**（Node `crypto` 全量 + PowerShell `Get-FileHash` 抽检 4 项一致）；`path` **均不含 `win-x64` 层**；`extraResources: from resources/runtime/win-x64 → to runtime, filter **/*`；`files` 仅 `apps/desktop/dist/**` + `package.json`（**不含 runtime**）；`resolveRuntimeDir()` 用 `isPackaged()` 切双路径 | **PASS** |
| 10 | **A-INF-03** | 本地 `fixture.mp4` 上 `yt-dlp.exe -J --dump-single-json` 退出 0 且返回完整 JSON；一次真实下载（含 ffmpeg 后处理）成功；**结论写入 DECISIONS.md** | `scripts/u3-verify.mjs` → `reports/u3.json`（我通过 `acceptance.mjs` 独立重跑生成）；`docs/DECISIONS.md` §U3 实测结论 | 我的独立运行：`conclusion=SUPPORTED`、`probe.exitCode=0`、`download.exitCode=0`、产物 308666 B、SHA-256 与 fixture 一致、C1/C3/C4/C5/C6 全 true、`ffmpegInvocationSeen=false`（本地单 format 不触发合并，已用显式 remux 兜底证明 FFmpeg 可用）；DECISIONS 有完整实测段 | **PASS** |
| 11 | **A-INF-04** | 4 项中 3 必需 OK、路径为绝对路径、版本非空；aria2c 缺失记 OPTIONAL 不判 FAIL；三项 `--version` 均退出 0；缺必需项 → 专用错误码且不崩溃 | `npm run check-runtime` + `node scripts/check-runtime.mjs --json` + 我的**负向实测** + `tests/unit/runtime-resolver.test.ts`（9 例，含 5 个负向） | 正向退出 **0**；负向（隐藏 `node.exe`）→ `node.status=MISSING`、`errorCode=JS_RUNTIME_MISSING`、`allRequiredOk=false`、退出 **2**、**未崩溃**；恢复后退出 **0**；单测另有 `ENGINE_MISSING` / `FFMPEG_MISSING` / `HASH_MISMATCH` / `NOT_EXECUTABLE` 覆盖 | **PASS** |
| 12 | **A-INF-05** | `build(ProbeRequest)` 纯函数、argv 按序含冻结前缀 + `--` + url；无 shell 拼接、`shell:false`；URL 白名单拒 `file://`/UNC/本地路径；**probe 分支覆盖率 100%** | `tests/unit/argv-builder.test.ts`（15 例）；覆盖率取全量运行 `argv-builder.ts` | argv **逐元素 `toEqual` 硬编码期望数组**（`EXPECTED_BASE` 为测试自带字面量，非引用实现常量）；`enginePath` 不入 argv、无空白拼接、`--` 只 1 个且 url 是最后一元素；白名单 6 类非法输入全拒；全量 `argv-builder.ts` 四维 **100/100/100/100** | **PASS**（证据缺陷见 P2-1） |
| 13 | **A-INF-06** | `packages/core`+`engine-ytdlp` 四维最低 ≥70%；L0+L1 全绿零网络；`npm test` 退出 0 | `npm test` + `pnpm exec vitest run --coverage` + 我的阈值证伪 | `npm test` 退出 **0**（11 文件/87 例）；覆盖四维 lines 93.71 / branches 81.53 / functions 92.70 / statements 93.71，最低 **81.53%**；阈值**实证生效**（`tests/contract` 单跑触发 4 条 threshold ERROR，退出 1）；测试内无 outbound 网络调用 | **PASS** |
| 14 | **A-INF-07** | `probe()` 对本地直链退出 0，返回完整 `MediaInfo`；spawn 绝对路径 + `argv[]` + `shell:false`；已注入 `--no-js-runtimes --js-runtimes node:<内置>` | `tests/integration/offline/probe-local.test.ts` → `probe-local: real probe() over 127.0.0.1 returns a complete MediaInfo` | 退出 **0**，1 例通过 / 2067 ms；断言 `call.file===YTDLP`（绝对）、`opts.shell===false`、`opts.windowsHide===true`、argv 含 `--js-runtimes`/`node:<abs>`/`--`、末元素为 URL；`real.calls` 恰 1 次（证明确实 spawn 而非 mock） | **PASS**（观察 O-6） |
| 15 | **A-INF-08** | `info-*.json`（≥1 视频 + ≥1 平铺播放列表）经 `JsonMapper` 全绿；字段类型正确；**不触网、不 spawn** | `json-mapper.contract.test.ts`（5 例，含 `has >=1 video + >=1 flat-playlist + >=1 minimal recorded fixture`、`does not access the network or spawn any process (pure function)`） | 3 个 fixture 齐备；平铺播放列表 3 条目逐条类型断言；纯函数确定性（两次调用 `toEqual` 且非同一引用）；我全库搜 `fetch(`/`http.request`/`net.connect`（tests/）**0 命中** | **PASS** |
| 16 | **A-INF-09** | M1 汇报按 §8 模板产出（含矩阵项→断言 ID 对照表）+ `acceptance-report.json` + `DECISIONS.md` 留痕 + **停下声明** | `docs/M1-REPORT.md`（153 行）+ `docs/DECISIONS.md`（D-01…D-14）+ `node scripts/acceptance.mjs --milestone M1` | 汇报 §1–§7 与模板逐项对应；§5 有 17 行对照表；§7 与 DECISIONS 尾部均有"未获甲方放行，不进入 M2"；我重跑 acceptance 得到 `allGreen=true / 17/17 / 5/5`（退出 0） | **PASS**（证据瑕疵见 P2-1） |
| 17 | **A-INF-10** | `DownloadEngine` 5 方法签名齐备；存在同接口 `FakeEngine` 桩 | `tests/contract/download-engine.contract.test.ts`（6 例，**同一组断言同时打两个实现**）+ `tests/unit/fake-engine.test.ts`（6 例） | `packages/shared/src/engine.ts` 我逐行核对 = **恰好 5 个方法**（`version/probe/probePlaylist/download/selfUpdate`）；`YtDlpEngine` 与 `FakeEngine` 各 5 个实现，同一 `assertInterface()` 通过；`real` 与 `fake` 的 `probe()` 结果 `toEqual` | **PASS** |

**统计：17 / 17 PASS，0 FAIL，0 SKIPPED。** 无一条"找不到对应测试"——每条都能定位到具体 `describe/it` 与我的实跑结果。

---

## 4. 独立重跑（真实退出码，全部为我本轮实跑）

| # | 命令 | 退出码 | 关键输出 | 日志 |
|---|---|---|---|---|
| 1 | `npm test` | **0** | 11 文件 / 87 例全绿；`Duration 1.36s` | `01-npm-test.log` |
| 2 | `pnpm turbo run typecheck` | **0** | 4 successful / 4 total（首次全缓存命中 → 我改用 `--force` 复跑） | `02-typecheck.log` |
| 2b | `pnpm turbo run typecheck --force` | **0** | **Cached: 0 cached, 4 total**，无 `error TS` | `02b-typecheck-force.log` |
| 3 | `node scripts/check-layering.mjs` | **0** | `0 violations (packages/shared/src, packages/core/src, packages/engine-ytdlp/src)` | `03-layering.log` |
| 4 | `npm run check-runtime` | **0** | 4 组：ytdlp/ffmpeg/node = OK，aria2c = OPTIONAL | `04-check-runtime.log` |
| 5 | `node scripts/check-runtime.mjs --json` | **0** | 完整 JSON，`allRequiredOk=true`，stderr 空 | `05-check-runtime-json.json/.err` |
| 6 | `pnpm exec vitest run --coverage` | **0** | **12 文件 / 88 例**（含 L2）；四维覆盖率表与阈值门控通过 | `08-vitest-coverage.log` |
| 7 | `npm run test:unit -- --run ArgvBuilder --coverage` | **0** | **7 passed / 8 skipped**；`argv-builder.ts` **69.23 / 52.17 / 66.66 / 69.23**（与工程师报告"15 例 / 100%"**不符**） | `10-argv-builder-coverage.log` |
| 8 | `npm run test:contract` | **0** | 2 文件 / 11 例全绿 | `06-test-contract.log` |
| 9 | `npm run test:integration:offline -- --case probe-local` | **0** | 1 例全绿 / 2067 ms（真实 spawn） | `07-integration-probe-local.log` |
| 10 | `node scripts/acceptance.mjs --milestone M1` | **0** | `17/17 assertions PASS, 5/5 acceptance PASS` / `coverage min = 81.53%` / `allGreen=true` | `11-acceptance.log` |
| + | 阈值**证伪**：`pnpm exec vitest run tests/contract --coverage` | **1** | 4 条 `ERROR: Coverage for … does not meet global threshold (70%)` → 证明阈值真实生效 | `09-threshold-proof.log` |

> 说明：`acceptance.mjs`、`check-runtime.mjs` 按设计会**重写** `reports/*.json`；我在开始前已把工程师原始 `reports/`+`coverage/` 全量备份到 `/tmp/qa-backup/`，复验结束后已逐字节还原（见 §9）。

---

## 5. 负向测试（必做，且已恢复）

**操作**：把 `resources/runtime/win-x64/node.exe` 临时改名为 `node.exe.qa-hidden`（用 `trap` 保证异常也回滚；另有一份 `/tmp/qa-backup/node.exe.bak` 兜底），跑 `node scripts/check-runtime.mjs --json`，随后立即改名还原。

**实测结果**：

```
NEGATIVE_EXIT=2                      ← 期望 2，实测 2
allRequiredOk: false
summary: { requiredOk: 2, requiredTotal: 3, optionalMissing: 1, failed: 1 }
ytdlp  OK      null
ffmpeg OK      null
node   MISSING JS_RUNTIME_MISSING    ← 期望专用错误码，实测命中
aria2c OPTIONAL null
```
- **不崩溃**：进程正常结束并输出结构化 JSON（`12-negative-check-runtime.json`，stderr 为空），未出现 Node 崩溃栈或 `fatal:`。
- **恢复验证**：还原后 `npm run check-runtime` → `allRequiredOk=true`、退出码 **0**；`certutil -hashfile node.exe SHA256` = `1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9`，与备份文件哈希**逐位一致**（二进制未被破坏）。
- 与工程师自报的负向证据 `reports/check-runtime-negative.json`（`node MISSING / JS_RUNTIME_MISSING`）一致——**但那份是我之前对照的旧产物，本结论来自我自己的实测**。

---

## 6. 静态抽查（9 条，逐条核对合同）

| # | 检查项 | 我的核对方式 | 结论 |
|---|---|---|---|
| 1 | `ErrorCode` 恰好 17 个且与 HANDOFF §6.7 逐字一致 | 逐行读 `packages/shared/src/errors.ts` 并对照 HANDOFF §6.7 原文 | **PASS**：联合类型恰 **17** 个成员，`ALL_ERROR_CODES` 元组同序 17 项，与 §6.7 清单**逐字逐序一致**（`INVALID_URL…UNKNOWN`）；`RUNTIME_MISSING_CODES` = 4 个运行时缺失码 |
| 2 | `DownloadEngine` 恰好 5 个方法 | 读 `packages/shared/src/engine.ts` | **PASS**：`version/probe/probePlaylist/download/selfUpdate` 恰 5 个，无多余方法 |
| 3 | `build(ProbeRequest)` argv 逐元素顺序 / 无字符串拼接 / `shell` 恒 false | 读 `argv-builder.ts`+`yt-dlp-engine.ts`，并用单测断言交叉验证 | **PASS**：`-J --dump-single-json --no-playlist --no-warnings --socket-timeout <5> -R <1> --no-js-runtimes --js-runtimes node:<abs> [--proxy v] [--cookies v] [--add-header v] -- <url>` 完全一致；全部 `argv.push()` 元素级赋值，**无任何字符串拼接命令**；spawn 处 `shell: false as const` 且 `assertSafeSpawnOptions()` 在 spawn 前强制 `shell!==false` 抛错 |
| 4 | 全库 `shell: true` / `createWindow` 必须 0 命中 | 全库 grep（排除 `node_modules`/`.turbo`/`coverage`） | **PASS**：`shell: true` **0 命中**（唯一命中是 `argv-builder.ts:10` 注释中的 "never `shell:true`"，属说明文字）；`createWindow` **代码 0 命中**，仅出现在 `apps/desktop/src/main/README.md` 与架构文档的"不 createWindow"说明里；`shell: false` 出现 **10 处** |
| 5 | `--cookies-from-browser` / `--geo-bypass` / `no-check-certificates` 代码 0 实现 | 全库 grep 并逐条看上下文 | **PASS**：**无任何实现**。命中仅 3 类合法位置：① `core/src/logger/redactor.ts` 的**禁用/脱敏名单**（正好是"拦截"而非"实现"）；② `logger.test.ts` / `json-mapper.contract.test.ts` 的**拦截断言**；③ 文档。`argv-builder.ts` 中不存在这些 token |
| 6 | `packages/ui` 不存在，全库无 `.tsx`/`.css` | `ls packages/ui` + `find -name '*.tsx' -o -name '*.css'`（排除 node_modules/coverage） | **PASS**：`ls: cannot access 'packages/ui': No such file or directory`；`.tsx`/`.css` **0 个**（`coverage/` 下的 `base.css` 是覆盖率报告自带的静态资源，非源码，已排除） |
| 7 | manifest 逐项 SHA-256 与磁盘实算一致；`path` 不含 `win-x64` 层；yt-dlp hash 与官方 `SHA2-256SUMS` 一致 | **双实现独立复算**：Node `crypto` 全量 12 项 + PowerShell `Get-FileHash -Algorithm SHA256` 抽检 4 项；再与本地 `SHA2-256SUMS` 比对 | **PASS**：12/12 项 hash+size+pathLayer **全部一致**（`14-manifest-hash-check.log`）；`path` 均为相对 POSIX 路径（`yt-dlp.exe`/`node.exe`/`ffmpeg/*.dll`），**不含 `win-x64`**；`yt-dlp.exe` 实算 `f5389d36…7a7d` 与 `SHA2-256SUMS` 中 `yt-dlp.exe` 条目**完全一致**；`ffmpeg/` 目录恰 10 个文件 = manifest 中 10 条，无遗漏/多余 |
| 8 | `electron-builder.yml` 含 `extraResources`（from runtime → to runtime，filter `**/*`），`files` 不含 runtime | 读 `apps/desktop/electron-builder.yml` | **PASS**：`extraResources: - from: resources/runtime/win-x64 / to: runtime / filter: ["**/*"]`；`files` 仅 `apps/desktop/dist/**/*` + `package.json`，**不含 runtime**（保证不进 asar） |
| 9 | `DECISIONS.md` D-01…D-14 与实际代码/配置一致（抽 5 条） | 逐条比对代码/配置/产物 | **PASS（抽 5 条全对，另发现 1 条表述夸大）**：<br>• **D-02** 覆盖率口径 ≥70% ↔ `vitest.config.ts` `thresholds: {70,70,70,70}` ✓<br>• **D-07** manifest 路径不含 `win-x64` ↔ 我 §6-7 实测 ✓<br>• **D-08** 许可证措辞 ↔ `FFMPEG-LICENSE.txt` 首行确为 **"GNU LESSER GENERAL PUBLIC LICENSE / Version 3, 29 June 2007"**，manifest `license: "LGPL-3.0"` 据实记录 ✓（相对 HANDOFF 的 "LGPL-2.1+" 属**正确留痕**）<br>• **D-10** I 前缀接口 ↔ `core/src/ports.ts` 实有 `IConfigStore/ILogger/IErrorMapper/IRuntimeResolver` ✓<br>• **D-12** `.cmd` 垫片 ↔ `fetch-runtime.mjs:231-233` 用 `process.execPath` + `corepack/dist/pnpm.js` / `npm/bin/npm-cli.js`，全程 argv[] ✓<br>• **D-11 表述夸大**：声称 "`npm test` … 仍强制四维 ≥70%"，但 `npm test` 不传 `--coverage`，**实际不执行阈值**（见 P3-2） |

---

## 7. 问题分级

### 阻塞级（Blocker）：**无**
未发现任何业务代码缺陷。17 条断言、5 条验收、负向路径、安全铁律（`shell:false`、argv[]、URL 白名单、合规禁用项）均经我独立复现成立。

### 非阻塞（P2 — 必须修，影响 M2 起的验收可信度）

| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| **P2-1** | **`M1-REPORT.md` §4 行④ 证据不可复现**：报告称 `npm run test:unit -- --run ArgvBuilder --coverage` 得 `argv-builder.ts` 四维 100% / "15 例全绿"；我实跑同一命令得 **7 passed / 8 skipped**、四维 **69.23 / 52.17 / 66.66 / 69.23** | `reports/qa-evidence/10-argv-builder-coverage.log` vs `docs/M1-REPORT.md:88` | 断言**实质仍 PASS**（全量运行下 `argv-builder.ts` 确为 100%），但报告把"全量数字"挂在了"定向命令"名下 —— 属**证据与命令不匹配**，是典型"报告比事实好看"。修法：把行④证据改为 `pnpm exec vitest run --coverage` 的 `argv-builder.ts` 行，或把 `--run` 过滤改为按**文件名**过滤 |
| **P2-2** | **`acceptance.mjs:172` 分层守卫恒真兜底**：`layeringZero = violations===0 \|\| exists('scripts/check-layering.mjs')` | `scripts/acceptance.mjs:172` | 只要脚本文件存在，即使 50 处违规 `A-INF-01` 仍 PASS。本次数据真实（`layering.json` violations=0），但门控形同虚设 |
| **P2-3** | **`--run` 过滤器按"用例名"匹配而非"文件名"**，导致 PRD §4 ④ 规定的验收命令漏跑 8 个白名单用例（`assertHttpUrl` 的 describe 名不含 "ArgvBuilder"）；叠加 `vitest.config.ts` 的 `targetedRun` 豁免，该命令**永远退出 0 且覆盖率无门控** | `reports/qa-evidence/10-argv-builder-coverage.log` + `vitest.config.ts:11-15,42-50` | 定向覆盖率命令实质是"无门控表演"；建议 `run-tests.mjs` 的 `--run` 改为自建"内含匹配 + 目录参数"或直接把定向命令写进验收文档时附带全量复核 |
| **P2-4** | **`vitest.config.ts` 注释与 `DECISIONS.md` D-11 夸大**：均声称 "`npm test` 仍强制四维 ≥70%"，实际 `npm test` 不传 `--coverage`（实测日志无覆盖率表） | `vitest.config.ts:9`、`docs/DECISIONS.md:155`、`reports/qa-evidence/01-npm-test.log` | 会误导后续里程碑"以为 `npm test` 已守门"。修法：改注释为"由 `vitest run --coverage` / acceptance 强制"，或在 `test` 脚本加 `--coverage` |

### 非阻塞（P3 — 建议改进）

| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| **P3-1** | `acceptance.mjs` 的 `durationMs` 硬编码 `0`（PRD §4 要求每项含实测 `durationMs`） | `scripts/acceptance.mjs:216`；`reports/acceptance-report.json` 全为 0 | 报告字段合规性瑕疵；不影响判定 |
| **P3-2** | 聚合层判定多为"该测试文件跑了 >0 例且 0 失败"的**存在性判定**，不校验 PRD 判定条件语义 | `acceptance.mjs:158,182-198` | 断言语义只能靠人工对照（我已逐条对照，成立）；建议 M2 起为关键断言补"条件级"复算 |
| **P3-3** | 观察 O-6：L2 真实 probe 对本地直链返回 `duration=null`、`thumbnail=null`（generic extractor 固有），验收③"duration/thumbnail 与②契约一致"仅在**可空类型**意义上成立；真实站点字段路径只由 L1 fixture 覆盖 | `reports/u3.json`（`fields.duration=false`,`thumbnail=false`）；`DECISIONS.md` §U3 已留痕 | 已正确留痕，非缺陷；记录以防 M2 误读为"已端到端验证 duration/thumbnail" |

**其他观察（不列为问题，仅留痕）**：
- 仓库**不是 git 仓库**（`fatal: not a git repository`），无法用 commit 证明"未改动工程师产物"。建议 M2 前 `git init` + 首次提交，后续里程碑才可做 diff 级审计。
- 官方 `SHA2-256SUMS` 与 yt-dlp 官方 release 的交叉校验需联网；本轮按 M1 离线要求**未联网**，我只能证明"manifest ↔ 磁盘 ↔ 本地 SUMS"三者一致。联网核验留到 M5。
- `apps/desktop/src/main/runtime-paths.ts` 开发分支用 `process.cwd()`（适配层允许），若从其他 cwd 启动 `check-runtime` 会解析失败；当前所有脚本均以项目根为 cwd，实测无影响。

---

## 8. 是否建议放行 M2

**建议放行（条件性）**，理由与条件：

1. **功能与契约层面无阻塞缺陷**：17 条断言、5 条验收、真实 `yt-dlp.exe` 链路、负向错误码、覆盖率门控（我已证伪其真实性）全部经我独立复现成立；安全铁律（`shell:false`、argv[]、`--` 分隔、URL 白名单、合规禁用项 0 实现）逐条核验通过；M1 范围守住了（无 UI、无 `.tsx`/`.css`、无 M2–M5 功能）。
2. **放行前必须完成的 4 项修正**（均为脚本/文档，**不需改业务代码**）：
   - 修 **P2-2**：删掉 `acceptance.mjs:172` 的 `|| exists(...)` 恒真兜底；
   - 修 **P2-1 / P2-3**：把 `M1-REPORT.md` 行④证据改为全量运行数据（或修 `--run` 过滤为按文件名匹配后重跑留证）；
   - 修 **P2-4**：更正 `vitest.config.ts` 注释与 `DECISIONS.md` D-11 关于 "`npm test` 强制阈值" 的表述（或给 `test` 脚本加 `--coverage`）；
   - 修 **P3-1**：`durationMs` 记为实测值。
3. **修正后建议**：用修正的 `acceptance.mjs` **重跑一次** `node scripts/acceptance.mjs --milestone M1` 并把新 `reports/acceptance-report.json` 作为 M1 基线附件；同时建议 `git init` 后提交，使 M2 起具备 diff 级可审计性。

> 我的立场：**这 4 项不修，M2 的"全绿"就不能作为验收依据**——因为它们证明的是"报告生成器会给绿灯"，而不是"事实是绿的"。修完再进 M2，我认可 M1 基线成立。

---

## 9. 证据索引与复验边界

**我的产物（新增，未改动工程师任何文件）**
- 本报告：`docs/M1-QA-VERIFICATION.md`
- 机器可读结论：`reports/qa-verification.json`
- 原始执行证据（18 个）：`reports/qa-evidence/`
  `01-npm-test.log`、`02-typecheck.log`、`02b-typecheck-force.log`、`03-layering.log`、`04-check-runtime.log`、
  `05-check-runtime-json.json/.err`、`06-test-contract.log`、`07-integration-probe-local.log`、`08-vitest-coverage.log`、
  `08b-coverage-summary-full.json`、`09-threshold-proof.log`、`10-argv-builder-coverage.log`、`11-acceptance.log`、
  `12-negative-check-runtime.json/.err`、`13-check-runtime-restored.log`、`14-manifest-hash-check.log`

**复验边界（如实声明）**
- **未改业务代码**：全程 0 处源码修改。唯一"破坏性"操作是临时重命名 `node.exe` 做负向测试，已还原并逐位校验哈希。
- **未联网**：M1 要求全离线，本轮未发起任何外网请求；因此 yt-dlp 官方 SUMS 的**远端**比对未做（只做本地三方一致）。
- **未改工程师产物**：`reports/`+`coverage/` 在跑 `acceptance.mjs` / `check-runtime.mjs` 时按脚本设计会被重写，我已在开始前全量备份到 `/tmp/qa-backup/`，复验结束后**逐字节还原**（`acceptance-report.json`、`check-runtime.json`、`u3.json`、`layering.json`、`vitest-results.json`、`coverage/**`），我的证据只写入 `reports/qa-evidence/` 与 `reports/qa-verification.json`。
- **未做**：变异测试（mutation testing）、非 Windows 平台验证、真实站点 L3 在线烟测（M1 不适用）、干净虚拟机打包验证（M5/C13–C16）。

---

*报告结束 · 严过关（QA）· 结论：PASS-WITH-ISSUES，条件性放行 M2 · 未修 P2-1～P2-4 前，不建议把 M1 全绿作为 M2 验收基线*

---
---

# 第二段复验 · §10 修复确认复验（RECHECK）

> 复验人：严过关（QA）｜ 日期：2026-11-05 ｜ 对象：工程师对 §7 的 P2-1/P2-2/P2-3/P2-4 + P3-1 五项修复
> 声称 commit：`50499e2b9b0d990f07d0e96ffd4637580a63c9e0` ｜ 我的证据目录：`reports/qa-evidence-recheck/`（13 个原始日志）
> 方法：**只读 + 跑命令 + 看内容/时间戳**，不改任何业务文件；仅临时篡改 `reports/layering.json` 做四态破坏测试并已还原。

## 10.1 RECHECK 结论

| 项 | 结论 |
|---|---|
| **RECHECK_VERDICT** | **BASELINE-ACCEPTED（M1 基线正式成立，放行 M2）** |
| P2-1 / P2-2 / P2-3 / P2-4 / P3-1 | **5/5 PASS**（逐项实测，无一项靠"工程师说"） |
| 四态破坏测试 | **6/6 符合预期**（正常 PASS → 注入 50 违规 FAIL → 缺失 FAIL → 结构非法 FAIL → 空数组合法 PASS → 重建 PASS） |
| 业务源码是否被顺手改动 | **未改动**（`packages/*/src` 最新 mtime ≤ 09:36，`apps/desktop/src` 09:16，`tests/` 09:35；修复窗口为 12:54–12:56） |
| 阻塞级问题 | **0** |
| 新增观察项 | 4 条（N-1～N-4，均为 P3 级，不阻塞放行） |
| 是否正式放行 M2 | **是**（见 §10.9） |

**一句话**：五项修复我逐条独立复现，**全部成立**；上一轮"报告比事实好看"的两处证据问题已被消除，且四态破坏测试证明分层门控现在是**真的会红**。M1 基线可以正式作为 M2 起点。

## 10.2 逐项修复判定

| 项 | 工程师声称 | 我的验证方法 | 实测 | 判定 |
|---|---|---|---|---|
| **P2-2** 恒真兜底 | 删除 `\|\| exists(...)`，改严格 `violations===0`；兼容数组/数字/`violationsCount`；缺失或结构非法判 FAIL | ① `grep -n "exists(join(ROOT, *'scripts'"` ② 读 198–212 行 ③ **亲自跑四态** | ① **0 命中**（旧兜底已彻底消失）② `layeringViolations` 三态解析后 `layeringZero = layeringViolations === 0`，`null`（缺失/非法）必然为 false ③ 见 §10.3 六态表全部符合预期 | **PASS** |
| **P2-3** 定向过滤 + 豁免 | `--run` 改按**测试文件名**匹配、匹配不到退出 3；删除全部 `targetedRun`；阈值恒 70；`coverage.include` 按 `YTVDLT_COVERAGE_INCLUDE` 收窄 | ① 读 `findTestFiles`/`findSourceFiles` ② `grep -rn targetedRun` ③ 实跑目标命令 | ① 按 `normalizeKey(basename)` 精确匹配、无匹配 `process.exit(3)` ② **0 命中** ③ 实跑 **15 passed / 0 skipped**，`argv-builder.ts` **100/100/100/100**，`coverage-summary.json` 中**恰 1 个文件**（收窄生效，91 stmts / 42 branches 全命中） | **PASS** |
| **P2-4** `npm test` 无门控 + 文档夸大 | `test` 改 `run-tests.mjs all --coverage`；注释与 D-11 重写 | ① 读 `package.json` ② 读 `vitest.config.ts` 注释与 D-11 ③ 实跑 `npm test` 两轮 | ① `"test": "node scripts/run-tests.mjs all --coverage"` ② 注释/D-11 已改为"无定向豁免、阈值作用于本次测量集合"，措辞与实现一致 ③ 有覆盖率表、**87/87**、exit 0、四维最低 **81.33–81.38%**（与 D-11 记载 81.33 吻合，见 §10.4 关于波动的说明） | **PASS** |
| **P2-1** 行④证据不实 | 行④换成定向命令真实输出，新增行④-补充记 `npm test` 全量，行⑤保留含 L2 全量 | 逐字比对 `docs/M1-REPORT.md` §4 与我 §10.4 实跑数字 | 行④ = "15 passed / 0 skipped + 100×4" ↔ 我实跑**逐位一致**；行④-补充 = "11 文件 87/87 + 93.71/81.33/92.70/93.71" ↔ 我两轮实跑 **81.38 / 81.33**（81.33 精确复现）；行⑤ = "12 文件 88 例 + 81.53" ↔ 我全量实跑 81.53/81.57。**三条证据各自绑定各自命令，不再错位** | **PASS** |
| **P3-1** `durationMs` 占位 | `performance.now()` 记录 | 读 175–181、214–222、258–268 行 + 检查报告 22 项 | `statusOf(..., dur)` 由 `STEP_MS.<step>` 提供，`item()` 取 `Math.max(1, round(dur))`；工程师报告与我重跑的报告**均 zero-duration = 0**；抽样 A-INF-01 = 5859 ms（工程师）/ 5589 ms（我），A-INF-03 = 7339 ms（u3 步），A-INF-09 = 1 ms（仅文件存在性检查，1 ms 是真实成本） | **PASS**（语义见 N-3） |

## 10.3 P2-2 四态破坏测试（我亲自跑，逐步记退出码）

> 说明：跑 `--no-collect` 是为了**不让 `acceptance.mjs` 自己重新生成 `layering.json`**，否则注入会被覆盖，测不出门控。每步后 `reports/layering.json` 均已还原/重建。

| 状态 | 我做的动作 | `reports/layering.json` 内容 | `A-INF-01` | 断言通过数 | 进程退出码 | 日志 |
|---|---|---|---|---|---|---|
| S1 正常 | 无（完整采集） | `{"violations":[],"violationsCount":0}`（真实产物） | **PASS** | **17/17** + 5/5 | **0** | `R3-acceptance-normal.log` |
| S2 注入违规 | `printf '{"violations":50}' >` | `{"violations":50}` | **FAIL**（actual: `violations=50`） | **16/17** | **1** | `R4-inject-violations.log` |
| S3 证据缺失 | `rm reports/layering.json` | 不存在 | **FAIL**（actual: `layering.json missing/unparseable/malformed`） | **16/17** | **1** | `R5-missing-layering.log` |
| S3b 结构非法（我加测） | `printf '{}' >` | `{}`（无 violations 键） | **FAIL**（同"结构非法"） | **16/17** | **1** | `R5b-malformed-layering.log` |
| S3c 合法空数组（我加测） | `printf '{"violations":[]}' >` | `{"violations":[]}` | **PASS**（actual: `violations=0`） | **17/17** | **0** | `R5c-empty-array.log` |
| S4 重建 | `node scripts/check-layering.mjs --json > reports/layering.json` + 完整 acceptance | 真实产物 | **PASS** | **17/17** + 5/5 | **0** | `R6-rebuild-layering.err` / `R6-acceptance-restored.log` |

**结论**：门控从"恒真"变成"真的会红"，且**只对真实违规/真实缺失变红**，不会误伤合法空数组（形状兼容正确）。

## 10.4 两条目标命令实测（P2-3 / P2-4 的关键证据）

**命令 A：`npm run test:unit -- --run ArgvBuilder --coverage`**

```
EXIT=0
 ✓ tests/unit/argv-builder.test.ts (15 tests) 8ms
 Test Files  1 passed (1)
      Tests  15 passed (15)          ← 0 skipped（上一轮是 7 passed / 8 skipped）
All files        |     100 |      100 |     100 |     100 |
 argv-builder.ts |     100 |      100 |     100 |     100 |
coverage-summary.json 内文件数 = 1（仅 argv-builder.ts；91 stmts/42 branches/3 funcs 全命中）
```
→ `--run` 改为文件名匹配后**整文件 15 例全跑**，覆盖率范围收窄到被测文件本身，**数字真实可复现**。

**命令 B：`npm test`（含 `--coverage`）—— 我连跑两轮**

| 轮次 | 退出码 | 用例 | lines | **branches** | functions | statements | 最低 |
|---|---|---|---|---|---|---|---|
| run1 | 0 | 11 文件 / 87 passed | 93.71 | **81.38** | 92.70 | 93.71 | 81.38 |
| run2 | 0 | 11 文件 / 87 passed | 93.71 | **81.33** | 92.70 | 93.71 | 81.33 |

→ 有覆盖率表、退出 0、四维均 ≥70。**branches 在 81.33–81.38 之间有 ±0.05pp 的运行波动**（v8 分支计数在并行执行下的固有抖动，全量运行同样见 81.53↔81.57）。`M1-REPORT` 行④-补充写的 81.33 正是我 run2 复现到的值，**不是编造**。

**命令 C：`npm run check-runtime`** → 退出 **0**，`allRequiredOk=true`，3 必需 OK + aria2c OPTIONAL（M1 边界未破）。

## 10.5 代码审查与"没顺手改业务源码"的判定

**commit 审查**：`50499e2` 存在、工作区 clean，但 `git rev-list --count HEAD = 1`、`git rev-list --parents -n 1 50499e2` 只有自身 → 这是**首次提交（全量 + 号新增），没有父提交**，所以 `git show` 只能看到"所有文件都是新增"，**无法用 git diff 隔离出修复改动**（见 N-2）。

**改用 mtime + 内容对照做等价判定**：

| 区域 | 最新 mtime | 判定 |
|---|---|---|
| 修复窗口（脚本/文档） | `scripts/run-tests.mjs` 12:54、`package.json` 12:54、`vitest.config.ts` 12:54、`scripts/acceptance.mjs` 12:55、`docs/M1-REPORT.md` 12:55、`docs/DECISIONS.md` 12:56 | 改动集中且**只落在声称的 6 个文件** |
| `packages/*/src/**`（业务源码） | 最新 **09:36**（argv-builder.ts） | **未被改动**（早于修复窗口 3 小时） |
| `apps/desktop/src/**` | 09:16 | **未被改动** |
| `tests/**` | 09:35 | **未被改动**（测试没被"改绿"） |
| 其他 scripts（check-layering / check-runtime / u3-verify / lib/*） | 09:00–09:26 | **未被改动** |

→ **修复是"改门控与文档"，不是"改被测对象"**。这一点是我本轮最看重的：如果工程师动了 `packages/**` 或 `tests/**` 来让绿灯出现，我会直接拒绝。

## 10.6 `durationMs` 抽样核对（P3-1）

工程师报告 22 项：**zero-duration = 0**；我重跑的报告同样 **zero-duration = 0**。抽样量级合理：

| 断言 | 依赖步骤 | 工程师报告 | 我实测 | 合理性 |
|---|---|---|---|---|
| A-INF-01 | vitest 全量 + layering | 5859 ms | 5589 ms | 同一量级，随机器负载浮动，合理 |
| A-INF-03 | u3-verify（真起 http + 真跑 yt-dlp + ffmpeg） | 7339 ms | 7339 ms | 与 U3 `durationMs≈7.9s` 吻合，合理 |
| A-INF-02 / A-INF-04 | check-runtime（扫 12 个文件哈希） | 2334 ms | 2334 ms | 对 93MB+ 文件做 SHA-256，量级正确 |
| A-INF-09 | 文档存在性 stat | 1 ms | 1 ms | **1 ms 是该证据的真实成本**（3 次 stat），不是糊弄 |

## 10.7 M1 边界复核（确认修复没破坏范围约束）

`packages/ui` → `No such file or directory`；源码 `.tsx`/`.css` → **0 个**；`grep -rn "shell: true|shell:true"` → **0 命中**（仅 `argv-builder.ts` 注释文字 "never shell:true"）；`npm run check-runtime` → 退出 **0**。**边界完好。**

## 10.8 本轮新发现（均为 P3，不阻塞放行）

| ID | 问题 | 证据 | 影响与建议 |
|---|---|---|---|
| **N-1** | `YTVDLT_COVERAGE_INCLUDE` 是**环境变量级**信任边界：任何人手动设置即可把测量集合收窄到 1 个高覆盖文件，从而"通过"阈值 | `R8-env-narrow-probe.log`：我手动 `YTVDLT_COVERAGE_INCLUDE=packages/engine-ytdlp/src/argv-builder.ts pnpm exec vitest run --coverage` → 退出 **0**、`All files 100%`，而真实低于阈值的 `engine-factory.ts`（61.9/50）**根本没被测量** | 比修复前的"自动豁免"弱得多（现在是 opt-in，且 `npm test`/`acceptance.mjs` 从不设置该变量），**不影响 M1 门控**；建议 M2 起在 `vitest.config.ts` 里对"非 `--run` 场景设置该变量"打 WARNING，或改由 `run-tests.mjs` 生成临时配置文件而非 env |
| **N-2** | commit `50499e2` 是首次提交、**无父提交**，`git show` 无法隔离修复 diff | `git rev-list --count HEAD = 1` | 不阻塞；建议 M2 起按里程碑增量提交，否则后续每次复验都只能靠 mtime 推断改动范围 |
| **N-3** | `durationMs` 是**按证据步骤**记录、由同步骤的多条断言共享（10 条断言同为 5589 ms），并非"每条断言自身耗时" | `R3` 报告 22 项耗时分布 | 比上一轮硬编码 0 好得多，语义诚实；建议 M2 起在报告里注明"durationMs = 该断言所依赖证据采集步骤的耗时"，避免被误读为逐断言计时 |
| **N-4** | `reports/*` 与 `coverage/` 被 `.gitignore` 忽略（`reports/**/*.json`、`coverage/`），M1 基线证据（含 `acceptance-report.json`、`qa-verification.json`）**均不进版本库** | `.gitignore:4,6-10`；`git check-ignore -v reports/qa-verification.json` → 命中 `.gitignore:8`；`git status` 整个复验只显示 `M docs/M1-QA-VERIFICATION.md` | 不阻塞（证据可由已提交的生成器重跑再生，本轮已复跑多次验证可复现）；但"基线附件"若只存在于本机磁盘，交付归档时需单独打包，建议 M5 交付清单里显式包含 `reports/` 与 `coverage/` 的归档副本 |

## 10.9 最终判定

**RECHECK_VERDICT: BASELINE-ACCEPTED —— M1 基线正式成立，放行 M2。**

理由：
1. 五项修复**逐条实测成立**，无一项仅凭工程师声明采信；上一轮我拒绝放行的两个核心理由（验收④证据错位、分层门控恒真）**均已消除并有破坏性测试佐证**。
2. 修复**严格限定在门控脚本与文档**（6 个文件，12:54–12:56），业务源码 `packages/**`、`apps/desktop/src/**`、`tests/**` 的 mtime 全部停留在 09:xx —— **没有靠改被测对象来制造绿灯**。
3. M1 边界完好（无 UI / 无 `.tsx`/`.css` / `shell:true` 0 命中 / check-runtime 退出 0）。
4. 新增 4 条 P3 观察项（N-1～N-4）不影响 M1 判定，建议在 M2 架构文档与 M2 验收脚本中吸收。

放行后建议（M2 起执行，非 M1 阻塞项）：
- 按里程碑**增量提交**（当前只有 1 个 commit，无法做 diff 级审计）；
- 把 `YTVDLT_COVERAGE_INCLUDE` 从"env 可写"改为"仅 `run-tests.mjs` 注入的受控参数"；
- 报告中注明 `durationMs` 的口径（按证据步骤，非逐断言）；
- M2 起把 §7 的 P3-2（存在性判定）升级为"条件级复算"，让 `acceptance.mjs` 真正理解断言语义。

---

*§10 复验结束 · 严过关（QA）· RECHECK_VERDICT = BASELINE-ACCEPTED · 证据：`reports/qa-evidence-recheck/`（13 份原始日志）*

