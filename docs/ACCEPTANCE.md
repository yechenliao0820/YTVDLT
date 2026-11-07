# 验收说明（ACCEPTANCE）

> 原则：**本文件不手抄任何数字**。所有结果以 `reports/` 下由脚本生成的 JSON 为准；本文只说明「跑什么、看哪个文件、判据是什么」。
> `reports/**` 与 `coverage/**` 均被 `.gitignore` 忽略 —— **本地生成、不入库**。看到本文时若 `reports/` 为空，说明还没在本机跑过。

---

## 1. 一键跑法（必须串行）

五套验收共用 `reports/vitest-results.json`、`coverage/`、端口与临时目录，**并行会互相覆盖**：

```bash
for m in M1 M2 M3 M4 M5; do
  node scripts/acceptance.mjs --milestone "$m"
done
```

单跑某一套：

```bash
node scripts/acceptance.mjs --milestone M5
```

> `--no-collect` 可跳过 vitest 采集、只复用已有报告（排障用，不能作为交付证据）。

## 2. 结果在哪

| 文件 | 内容 |
|---|---|
| `reports/acceptance-report-m5.json` | M5 逐条断言：`id / layer / status / expected / actual / durationMs / evidence` |
| `reports/acceptance-report-m4.json` 等 | 前四个里程碑的同结构报告 |
| `reports/vitest-results.json` | 全量 vitest 逐文件结果（`file-coverage` 门控的数据源） |
| `reports/vitest-guard.json` | 采集门控：`decision`（`CLEAN` / `MITIGATED`）、`runId`、`originalStatus`、`reasons` |
| `coverage/coverage-summary.json` | 四维覆盖率（行 / 分支 / 函数 / 语句） |
| `reports/layering.json` | 分层守卫违规数（必须 0） |
| `reports/check-runtime.json` | 运行时三件套自检 |
| `reports/e2e-summary.json` | 页面级 e2e（30 例 + 5 反例） |
| `reports/artifact-verification.json` | 产物校验（C1–C12） |
| `reports/m3-legacy-closure.json` | M3 遗留用例收口计数 |

## 3. M5 的门控看什么

| 门控 ID | 判据 | 数据源 |
|---|---|---|
| `M5-GATE-vitest` | 全量 vitest 0 失败 | `vitest-results.json` |
| `M5-GATE-coverage` | 四维最低 ≥ 70% | `coverage-summary.json` |
| `M5-GATE-layering` | 违规数 = 0（UI 层禁 `node:fs` / `child_process` / `electron`） | `layering.json` |
| `M5-GATE-runtime` | 3 项必需运行时全 OK（`aria2c` 可选） | `check-runtime.json` |
| `M5-GATE-frozen` | `request.ts` 逐字节未改；依赖只增不删（D-61） | `git show HEAD:…` + `scripts/frozen-gate.mjs` |
| `M5-GATE-file-coverage` | 每个测试文件都映射到 ≥1 断言（`unmapped` / `badRefs` 为空） | `vitest-results.json` + `M3_TEST_FILE_MAP` |
| `M5-GATE-docs` | D-54…D-63 连续 + 三份块报告齐全 | `docs/DECISIONS.md`、`docs/M5-*-REPORT.md` |
| `M5-GATE-blockers` | 阻塞登记（N1/N2/N3）仍在 `M5-SUMMARY.md` | `docs/M5-SUMMARY.md` |

## 4. M5 状态口径（8 PASS + 2 SKIPPED）

`M5_ASSERTIONS` 共 10 条，其中 8 条实测 PASS，2 条 **SKIPPED**：

| 断言 | 状态 | 为什么 |
|---|---|---|
| `A-4.4-28` yt-dlp 引擎更新 | **SKIPPED（L3）** | 需在线拉官方 release（国际网）。本地 L2 已跑通，但 L2 不改判 L3 |
| `A-4.4-29` 应用自更新 | **SKIPPED（L3）** | 需托管更新源 + 第二版产物 |

> 这两条的 `deferred` 文案写于 gate 关闭期，仍写着「未实现 / 未安装」。**该文案已过时**（实现已落地，见 `docs/M5-5-REPORT.md`）。按 §7.4 本轮**不修改**脚本，真实状态以报告为准 —— 见 D-62 ⑤。

## 5. 打包层（L4-packaging）

`C13`–`C16` 属于**干净虚拟机**验收，本机（装了 Node / Python / 开发工具链）**不能**代替：

| 用例 | 状态 |
|---|---|
| C13 干净机 · 安装版 | 待 gate |
| C14 干净机 · 便携版 | 待 gate |
| C15 运行时完整性（删任一 exe） | 待 gate |
| C16 不污染系统（PATH / 卸载残留） | 待 gate |

产物本身已实测可跑：`dist/win-unpacked/YTVDLT.exe` 启动正常、页面渲染正常（`reports/ui-shot.png`）。见 `docs/M5-4-REPORT.md`。

## 6. 复现前提

- `resources/runtime/win-x64/**` **未入库**（`.gitignore` 第 16–20 行），干净 clone 后需自行放入，否则 `check-runtime` 与打包会失败。
- e2e 依赖缓存的无头浏览器；首次运行会下载。
- 所有报告都是**本机生成**，换机器需重跑，不要把旧 JSON 当证据。
