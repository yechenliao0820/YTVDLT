# M4-0 报告 · QA 收口（D1/D2/D3/D4）

> 版本 v1.0 ／ 2026-11-06 ／ 对应 `docs/M3-QA-VERIFICATION.md` §9.3 的 5 项 P3 缺口
> 范围：**只动测试基建与测试代码，不碰产品运行时**（`packages/**/src` 仅新增一个 `export`）。

## 1. 完成了什么（逐条对照）

| 缺口 | 原问题 | 本轮处置 | 状态 |
|---|---|---|---|
| **D3（最高优先）** | `reports/m3-legacy-closure.json` 全仓库**无生成脚本**，任何手写 JSON 都能过 `A-4.5-07` / `A-M3-12` / `M3-GATE-docs`；且自述 145 例与实测 129 例不符 | 新增 `scripts/lib/legacy-closure.mjs`：**从同一次 `reports/vitest-results.json` 推导**，固化 5 个文件、逐文件用例数/耗时、`sourceRunId`（vitest `startTime`）、`generatedBy`；`acceptance.mjs` 每次采集后**重写**该文件，并用 `validateLegacyClosure()` 重算比对（`sourceRunId` / `total` / `failed` / 文件数 / `durationMs>0` 任一不符即 FAIL） | ✅ 关闭 |
| **D1** | `A-4.3-04` 只测 `autoCaptions:false` 分支，缺 `autoCaptions=true && skipTranslated=false` | `tests/unit/argv-builder-m3.test.ts` 新增用例：断言含 `--write-auto-subs`、**不含** `--extractor-args` / `youtube:skip=translated_subs` | ✅ 关闭 |
| **D2** | 测试内 `ABR_FIELD` 与 `download-plan.ts` 的 `AUDIO_BITRATE_FIELDS` 是重复定义，同改会漂移 | 源侧 `export const AUDIO_BITRATE_FIELDS`；测试改为 `import { AUDIO_BITRATE_FIELDS }`，删除镜像字面量 | ✅ 关闭 |
| **D4** | 48 条 `durationMs` 全部同值（`unique=1`），gate 只查 `>1ms` | 改为**逐条归因**：按 `def.tests[]` 匹配 vitest `testResults` 的 `endTime-startTime` 求和；无 `tests[]` 的纯 e2e 项回落步骤级并标 `durationSource:'step-shared'`；gate 追加 `perFile>=40 && unique>=10` | ✅ 关闭 |
| D5 | `data-enqueue-batch="never"` 属部分自证 | 保持（风险低），由 M4-4 的批量入队用例加强 | 顺延 M4-4 |
| D6 | 本交接包未入库 | 已在 `82e29a1` 入库 | 已关闭 |

## 2. 验收证据（真实命令输出）

```text
$ node scripts/acceptance.mjs --milestone M3
[acceptance] M3: 48/48 assertions PASS, 3/3 regression rechecks PASS
[acceptance] M3: 12/12 gates PASS, 4/4 acceptance PASS
[acceptance] coverage min = 86.77%
[acceptance] allGreen=true
```

- `M3-GATE-duration`：`min=5ms over 51 items; perFile=46 stepShared=5 unique=29 (measured)`（改造前 `unique=1`）。
- `M3-GATE-docs`：`decisions=true report=true legacy=true`。
- 重生成证据：`node scripts/lib/legacy-closure.mjs` → `5 files / 129 tests / 0 failed / 745ms`，与 QA 实测 **129 例完全一致**（原自述 145 例为虚高）。

### 2.1 反例自检（证明 D3 不再是橡皮图章）

```text
$ mv reports/m3-legacy-closure.json reports/_legacy-backup.json
$ node scripts/acceptance.mjs --milestone M3 --no-collect
[acceptance] M3: 46/48 assertions PASS
[acceptance] M3: 11/12 gates PASS, 3/4 acceptance PASS
[acceptance] allGreen=false
# 恢复后
[acceptance] M3: 48/48 assertions PASS ... allGreen=true
```

→ 证据文件缺失时 `A-4.5-07`、`A-M3-12`、`M3-GATE-docs` 三条**同时转 FAIL**，不是恒真。

## 3. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/lib/legacy-closure.mjs` | 新增 | legacy 证据唯一生成器 + 校验器（`buildLegacyClosure` / `validateLegacyClosure` / `writeLegacyClosure`） |
| `scripts/acceptance.mjs` | 修改 | 采集后重写 legacy 证据；`legacyOk` 改用重算校验；`durationFor` 改为逐文件归因 + `durationSource`；`M3-GATE-duration` 加严 |
| `tests/unit/argv-builder-m3.test.ts` | 修改 | 补 `(autoCaptions=true, skipTranslated=false)` 分支；`ABR_FIELD` 改为引用导出常量（92 例，原 91） |
| `packages/core/src/decision/download-plan.ts` | 修改 | `AUDIO_BITRATE_FIELDS` 加 `export`（唯一产品代码改动，纯导出，无行为变化） |
| `docs/M4-0-REPORT.md` | 新增 | 本报告 |
| `docs/DECISIONS.md` | 修改 | 追加 D-46 |

## 4. 偏离与风险

- **D-46 登记**：legacy 证据口径由「独立 5 文件单独跑」改为「与全量 vitest 同批采集」——理由：同一次运行才能保证计数零漂移；`durationMs` 取 5 个文件的实际耗时之和。
- 产品运行时零行为改动（唯一的 `export` 不改变任何调用路径）；`request.ts` / `pnpm-lock.yaml` / `package.json` 对 HEAD **0 行 diff**。
- 残留风险：legacy 集合固定为 5 个文件（`task-queue` / `progress-parser` / `argv-builder-m3` / `electron-shell-port` / `shell-port`），新增遗留项需同步 `LEGACY_TEST_FILES`，否则不会被 gate 统计。

## 5. 回归状态

| 里程碑 | 结果 |
|---|---|
| M1 | 未改动相关代码；`acceptance --milestone M1` 仍可独立运行 |
| M2 | 未改动；`A-M2-01` 的串行语义在 M4-2 会显式以 `concurrency:1` 固定 |
| M3 | **48/48 + 12/12 + 4/4，allGreen=true**（改造后重跑） |

## 6. 下一步

M4-1 · 7 态状态机（`state-machine.ts` + 单测，2–3 文件）。
