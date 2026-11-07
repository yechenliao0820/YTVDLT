# YTVDLT · M5 项目交接书 v3.1（完整自包含版）

> 日期 **2026-11-06 23:33** ／ 本文是**当前状态唯一入口**，取代 v2.1 作为「现在到哪了」；`docs/M5-HANDOFF-V2.md` v2.1 **仍作为施工单权威**保留，两者冲突时以本文记录**仓库实测状态**、以 v2.1 记录**施工方法**。
> 设计目标：**下一棒只看这一份文件即可开工**，不需要翻聊天记录、不需要翻 `m5-staging/` 目录、不需要问任何人。
> 权威优先级（沿用 v2.1 开头）：原始任务书 `C:/Users/leolee/WorkBuddy/2026-11-05-07-24-49/YTVDLT_HANDOFF.md`（**933 行，唯一权威**）＞ `docs/PROJECT-HANDOFF.md`（甲方副本，**有甲方本地改动，不要提交/覆盖**）＞ `docs/PRD-M1.md` / `PRD-M3.md` ＞ `ARCHITECTURE-M1/M2/M3.md` ＞ `docs/DECISIONS.md`（D-01…**D-60**）＞ `docs/M5-HANDOFF-V2.md` v2.1 ＞ 本文。
> 环境：Windows 10 22631 ／ Node **22.22.2** ／ pnpm **9.15.9** ／ npm 10.9.7 ／ **Electron 二进制仍缺失** ／ 国内网已由甲方批准、国际网未放行 ／ 当前 `master` 分支。
> 项目根：`C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\ytvdlt`（下文所有相对路径均相对此目录）

---

## 目录

| § | 内容 | 什么时候看 |
|---|---|---|
| 0 | 结论先行 · 本轮定性 · 时间线 · 最短开工路径 | **必看** |
| 1 | 权威体系与全部相关文件清单 | 找文档时 |
| 2 | 仓库真实状态（实测输出 + **§2.4 半截 lock 专题**） | **开工第一条** |
| 3 | §7 基线核对完整结果（六项 + 三件套 + 五套串行） | 引用数字时 |
| 4 | 已交付的 M5 离线四块（别重做） | 怕误以为没做时 |
| 5 | 没做什么（逐项原因） | 排优先级时 |
| 6 | 本轮四份设计/核查产物的**内联摘要** | 不想翻 staging 时 |
| 7 | 排雷总表：已修 9 条 + v2.1 17 条 + 本轮新增 14 条 | **动手前必读** |
| 8 | 合规专题（LGPL-3.0 / 12 条逐条 / 组件表 / 六份文档要求） | 写 M5-6 时 |
| 9 | 网络放行与 gate 表（N1/N2/N3 + Q1–Q3） | 联网前必读 |
| 10 | 下一棒施工单（逐任务、细到函数与命令） | **施工主入口** |
| 11 | 三个 commit 的精确清单 + D-61/62/63 内容 | 提交时 |
| 12 | 报告 / 决策 / 状态词写法规范 | 写文档时 |
| 13 | 验收口径 · DoD 七条 · 串行铁律 · 门控判据 | 验证时 |
| 14 | 术语表（N1–N3 / L0–L3 / C1–C16 / U1–U7 / B1 / B5 / D-xx / SKIPPED） | 看不懂词时 |
| 15 | 文件地图（要改哪里） | 改代码时 |
| 16 | 团队与工具链状态（本轮教训） | 决定怎么派人时 |
| 17 | 命令速查表 | 日常 |
| 18 | 30 秒自查 / 常见误判 | 接手时 |
| 19 | 停止声明 | 对外汇报时 |

---

## 0. 结论先行 · 本轮定性

### 0.1 一句话

**M5 的离线四块（M5-0…M5-3）在 v2.1 之前就已完成且全绿；本轮把 §7 基线重新核对了一遍也全绿；但剩余三块（M5-4 打包 / M5-5 双通道更新 / M5-6 合规文档 + L3）一行代码都没落地、一个 commit 都没打、一份块报告都没写、一条决策都没续。项目内代码层面唯一新增文件是 `scripts/frozen-gate.mjs` 草稿（未接线、未测试、未提交）；另有本交接书、`pnpm-lock.yaml` 的**半截改动**与一个 0 字节临时文件残留（详见 §2.4）。**

对外只能说：**「离线部分完成且复核通过；打包、更新、合规与在线烟测未开工。」** 不得说「成品可安装」「可下载」「已交付」。

### 0.2 本轮做了什么 / 没做什么（总表）

| # | 项 | 状态 | 证据 / 说明 |
|---|---|---|---|
| 1 | M5-0…M5-3 离线四块 | ✅ **v2.1 之前已完成**，本轮未改动 | v2.1 §2；本轮基线全绿 |
| 2 | §7 基线核对（六项 + 三件套 + 串行 M1–M5） | ✅ **本轮完成**，12m15s | `reports/m5-baseline.log`，见 §3 |
| 3 | 增量 PRD / 架构设计 / 合规事实核查 / 联网 gate 表 | ✅ 已产出，但**全在项目外 `m5-staging/`，未入库** | 见 §6 |
| 4 | `pnpm install`（N1-1） | ⚠️ 已执行、退出码 0，但 `Already up to date`，**没补到 Electron 二进制** | `reports/m5-n1-install.log`，见 §7 坑 B |
| 5 | `pnpm add -D electron-builder electron-updater -w`（N1-2） | ⛔ 已执行**但失败**：WorkBuddy `safe-delete` 保护拦截；**且已部分写入 `pnpm-lock.yaml`** | 完整报错见 §7 坑 A，残留见 §2.4 |
| 6 | N1-3 打包 / N2 下载 / N3 | ⛔ **未执行** | — |
| 7 | §6.2-① frozen 门控收窄 | ⚠️ 只写了孤立草稿 `scripts/frozen-gate.mjs`，**未接进 `acceptance.mjs`、未测试、未提交** | 见 §6.5 / §10.2 |
| 8 | `docs/M5-4-REPORT.md` / `M5-5-REPORT.md` / `M5-6-REPORT.md` | ⛔ **均不存在** | — |
| 9 | D-61 / D-62 / D-63 | ⛔ **均不存在**，DECISIONS 仍停在 **D-60**（`grep -c '^## D-'` = 60） | — |
| 10 | C1 / C2 / C3 三个 commit | ⛔ **均不存在**，`git log` 最新仍 `e3c0d84` | — |
| 11 | 六份合规文档（NOTICE / LICENSE-COMPLIANCE / BUILD / README / ACCEPTANCE / SHORTCUTS） | ⛔ **均不存在** | — |
| 12 | L3 在线烟测 / C1–C12 | ⛔ 国际网未放行，记 **SKIPPED** | 见 §9.7 / §13 |
| 13 | C13–C16 干净 VM 实测 / U7 | ⛔ **待甲方签字**，AI 不替签 | `docs/M5-VM-CHECKLIST.md` 8 步 |
| 14 | 甲方 `docs/PROJECT-HANDOFF.md` | ✅ 保持 `M` 未提交、未覆盖 | **永远不要动** |
| 15 | `pnpm-lock.yaml` | ⚠️ **被部分写入**：+1944 / −38 行（含 `electron-builder@26.18.0` / `electron-updater@6.8.11` 解析），但 `package.json` **未同步** → 半截不一致状态 | 见 §2.4，下一棒必须**先处理** |
| 16 | `_tmp_2992_c8a08bf15dca424991930c32439a4a06` | ⚠️ 0 字节临时**文件**残留（pnpm 建 store controller 时留下，非目录） | 见 §2.4 |
| 17 | `docs/M5-HANDOFF-V3.md` | ✅ 本交接书（未提交） | — |

**净交付 = 1 个未提交的孤立脚本 + 1 份交接书 + 1 个半截改动的 lock + 1 个临时文件残留 + 若干被 gitignore 的日志 + 4 份项目外设计文档。没有 commit、没有报告、没有决策续号。**

### 0.3 本轮时间线（为什么耗了这么久，供复盘，不用照做）

| 阶段 | 做了什么 | 结果 |
|---|---|---|
| ① 读 v2.1 + 核对基线 | `node scripts/handoff-check.mjs`、`git status`、三件套、**串行** M1–M5（12m15s） | ✅ 全绿；发现 §0.4 文档过期（`151a56e` vs `e3c0d84`） |
| ② 组建团队 | PM → 架构师 → QA 并行，产出 PRD v1.2 / 设计 v1.4 / 合规事实表 / gate 表 | ✅ 四份文档（项目外） |
| ③ 事实核查往返 | 多轮订正：DLL 8→7、LGPL-2.1→3.0、关于框无需改、`M5-SUMMARY` 不改、决策判据 `tail -12`→四条组合 | ✅ 设计定稿 v1.4，但**这些都不是交付物** |
| ④ 派实现 worker ×3 | `software-engineer` ×2 + `general-purpose` ×1，全部**零文件、零 commit** | ⛔ 根因：专家角色模板写死 `write_to_file`（当前环境无此工具），见 §16 |
| ⑤ 同步子代理探针 | 不带 `name` 的 foreground agent 用 Bash/Write/git 三步全部 `Exit Code: 0` | ✅ 证明**工具与权限都正常**，问题只在异步 teammate 调度 |
| ⑥ 甲方叫停后开跑 N1 | `pnpm install` 成功但无二进制；`pnpm add` 被 `safe-delete` 拦下 | ⚠️ 见 §7 坑 A/B |
| ⑦ 写交接书 | 本文件 | — |

**教训（写给下一棒）**：离线四块既然已绿，就不该再拆「离线预实现」；剩余三块的正解是**先改 frozen 门控 → 联网装依赖 → 打包 → 更新 → 文档**，一条直线。设计文档写再多也不能替代一个 commit。

### 0.4 给下一棒的最短路径（只看三行）

1. 跑 §2 的复核命令，确认仓库状态与本文一致；**先按 §2.4 决定「回滚还是补齐」那个半截的 `pnpm-lock.yaml`**，不要带着不一致状态往下走；
2. 按 §10.2 **先改 frozen 门控**（否则 N1 一装依赖 M3/M4 立刻变红；注意 R3 要按 §2.4.2 细化），登记 D-61；
3. 按 §9.5 顺序执行 N1 → 打包 → 更新 → 合规，每块一个 commit + 报告 + 决策续号，最后按 §13 串行跑五套验收；
4. 交付前按 §18 逐条自查，尤其「SKIPPED 不得写成 PASS」「L2 ≠ L3」。

---

## 1. 权威体系与全部相关文件清单

### 1.1 权威优先级（冲突时以靠前者为准，并在 `DECISIONS.md` 留痕）

```
原始任务书 C:/Users/leolee/WorkBuddy/2026-11-05-07-24-49/YTVDLT_HANDOFF.md (933 行)
  > docs/PROJECT-HANDOFF.md (甲方副本，有本地改动，不提交/不覆盖)
  > docs/PRD-M1.md / docs/PRD-M3.md
  > docs/ARCHITECTURE-M1.md / M2 / M3
  > docs/DECISIONS.md (D-01…D-60)
  > docs/M5-HANDOFF-V2.md (v2.1，施工单)
  > 本文 (当前状态)
```

> **已知冲突**：原始任务书 §6.7 / §12.5 写 FFmpeg「LGPL-2.1+ / LGPLv2.1」，而 D-08 实测核实实际随包许可证是 **LGPL-3.0**。这是**事实核查结论**，不是「擅自偏离」——按 §8.5 口径在 M5-6 文档里显式登记差异并引用 D-08。

### 1.2 项目内相关文件（逐个说明）

| 文件 | 作用 / 当前状态 |
|---|---|
| `docs/M5-HANDOFF-V2.md` | v2.1 施工单，§5 剩余三块步骤、§6.2 十七条雷、§7 第一小时、§8 DoD、§9 术语、§10 文件地图、§11 停止声明 |
| `docs/M5-HANDOFF.md` | v1.2「开工前」背景包，已被 v2 取代 |
| `docs/M5-SUMMARY.md` | 离线块收尾报告，**本轮核对不改、不进任何 commit**（§7 坑 F） |
| `docs/M5-0-REPORT.md` … `M5-3-REPORT.md` | 四份块报告，`M5-GATE-docs` 固定检查的 5 份中的 4 份；也是新报告的模板 |
| `docs/M5-VM-CHECKLIST.md` | 甲方 C13–C16 干净 VM 实测 8 步勾选表（AI 不替签） |
| `docs/M5-PREFLIGHT.md` | 开工前预检 |
| `docs/DECISIONS.md` | 决策台账 D-01…**D-60**，下一棒从 **D-61** 续号且**连续不跳号** |
| `scripts/acceptance.mjs` | 验收与门控（1300+ 行），详见 §7 坑 F/G/H |
| `scripts/handoff-check.mjs` | 一条命令看六项现状 + STALE 判定 |
| `scripts/check-layering.mjs` | 分层铁律，只扫 `packages/{shared,core,engine-ytdlp,ui}/src` |
| `scripts/run-e2e.mjs` / `e2e-cases.mjs` | 30 例截图 + 5 反例 |
| `scripts/frozen-gate.mjs` | **本轮新增草稿**，未接线未测试未提交，见 §6.5 |
| `scripts/fetch-runtime.mjs` | `:203-209` 兜底分支含过时 `'LGPL version 2.1 or later'` + `lgpl-2.1.txt` 链接，见 §7 坑 E 补充 |
| `apps/desktop/electron-builder.yml` | 打包配置**已就位，勿改**（`files` 只含 `apps/desktop/dist/**` + `package.json`；`resources/runtime/**` 走 `extraResources`） |
| `apps/desktop/src/main/electron-entry.ts` | 唯一 import `electron` 的装配点；`:83/:92/:93` 三处 `process.cwd()` fixture 路径待修 |
| `resources/runtime/win-x64/**` | 本机已有 `yt-dlp.exe` / `node.exe` / `ffmpeg/` / `FFMPEG-LICENSE.txt` / `SHA2-256SUMS` / `runtime-manifest.json`，**二进制被 .gitignore 忽略、未入库** |
| `reports/` / `coverage/` / `dist/` | 全部 `.gitignore` 忽略，属本地生成证据，**不入库** |
| `package.json` | 当前 devDependencies 无 `electron-builder` / `electron-updater`；`ytvdltPlannedDependencies` 登记了版本 `^26.0.0` / `^6.8.0` |
| `.npmrc` | `shamefully-hoist=false`（§6.2-⑫ 可能需改 hoisted，且改配置也须报备） |

### 1.3 项目外 staging 文档（本轮产出，未入库）

目录：`C:/Users/leolee/WorkBuddy/2026-11-06-22-17-41/m5-staging/`

| 文件 | 版本 / 体量 | 作用 |
|---|---|---|
| `M5-DELTA-PRD.md` | **v1.2** / ~40 KB | 增量 PRD：范围、5 条用户故事、需求池 P0/P1/P2 三层、三块 commit 与 D-61…63 分配、联网清单、DoD 对照、13 条诚实性约束、Q1–Q3 |
| `M5-DELTA-DESIGN.md` | **v1.4 定稿** / 1093 行 / 118,995 B / sha256 `5aac4e6790b8babcf3d9572d3f95a7f157a62dca78ec8e55537d2ec64593b94a` | 主施工图：T01–T05 任务列表、文件清单、类图 ×1、时序图 ×2、任务依赖图 ×1、三个 commit 精确 `git add`、§7.8 QA 12 项审计表、§8.1 十七条雷映射、联网 gate 表 |
| `M5-COMPLIANCE-FACTS.md` | — / 41 KB / 223 行 / 7 节 | 合规只读事实核查：许可证结论、12 条逐条证据状态、§6.7 组件表、关于框、10 处上游冲突 |
| `M5-NETWORK-GATE.md` | — / ~5 KB | 联网 gate 表：N1/N2 逐条命令、耗时、失败后果、Q1–Q3、放行后序 0–9、禁执行清单 |

> 这四份是**设计与核查产物，不是交付物**，不在 git 里。若新工作区没有它们，按本文 §6–§10 的内联摘要即可开工。

### 1.4 绝对不要动的文件

- `docs/PROJECT-HANDOFF.md` —— 甲方本地 `M` 改动，**绝不 `git add`、绝不覆盖、绝不 checkout**。所有 commit 必须精确列文件，禁 `git add -A` / `.` / `-u`。
- `docs/M5-SUMMARY.md` —— 本轮核对不改（§7 坑 F）。
- 任何 `packages/ui/src/**` / `messages.js` —— 改了触发 DOM 基线重建（§7 坑 I）。
- `apps/desktop/electron-builder.yml` —— 只核对、不修改（§6.2-⑥）。
- `M5_ASSERTIONS` / 两条 `deferred` —— 固定 10 条（§7 坑 G）。

---

## 2. 仓库真实状态（下一棒第一条命令）

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt
git status --short
git log --oneline -5
grep -c '^## D-' docs/DECISIONS.md
ls node_modules/electron/dist/electron.exe
```

### 2.1 实测输出（2026-11-06 23:33 复核，不是「期望」而是**实际**）

```
 M docs/PROJECT-HANDOFF.md          <- 甲方改动，保持
 M pnpm-lock.yaml                   <- pnpm add 半截写入，见 §2.4
?? _tmp_2992_c8a08bf15dca424991930c32439a4a06   <- 0 字节临时文件残留
?? docs/M5-HANDOFF-V3.md           <- 本交接书
?? scripts/frozen-gate.mjs         <- frozen 门控草稿（未接线/未测试/未提交）
```

`package.json` **未被修改**（`devDependencies['electron-builder']` / `['electron-updater']` 均为 `undefined`）——即 **lock 已写、package.json 未写**，两者不一致。这是被中断的 `pnpm add` 留下的中间态，详见 §2.4；**下一棒必须先决定「回滚还是补齐」，不要在此状态上直接跑验收**。

### 2.2 git 历史（本轮结束时）

```
e3c0d84 fix(m5): handoff-check 误报 STALE（提交标题含 STALE 字样被当成证据过期）
40fd63d feat(m5): 新增 scripts/handoff-check.mjs —— 交接文档过期自查
ab2ff43 docs(m5): 交接包自查表改用「最后一次代码提交」判定
0f39698 docs(m5): 交接包升 v2.1 + 新增 VM 实测清单
ee79f1b docs(m5): 新增 v2 交接包 + D-60 排雷决策
151a56e fix(m5): 收尾排雷 9 项                 <- v2.1 §0.4 记的是这个
94cb240 docs(m5): 6 条决策 + 4 份块报告 + 收尾报告
119bc44 feat(m5): 主题三态/快捷键/i18n/队列页/IPC 表面 + 87 例测试 + 30 例截图基线
```

> **§0.4 差异**：v2.1 写「最后一次代码提交 = `151a56e`」，实测是 **`e3c0d84`**（后加的 `handoff-check` 脚本及其修复提交）。按 v2.1 §0.4「以仓库现状为准，并把差异补进 `DECISIONS.md`」——**在 D-61 里留痕**，不要改写甲方文档。

### 2.3 被忽略的本地证据（不入库）

| 文件 | 内容 |
|---|---|
| `reports/m5-baseline.log` | 本轮三件套 + 五套串行验收全量输出（2069+ 行） |
| `reports/m5-n1-install.log` | N1-1 成功 / N1-2 失败原文 |
| `reports/acceptance-report-m1..m5.json` | 五套验收 JSON，`allGreen=true` |
| `reports/e2e-summary.json` | 30/30 + 5/5，`allPass=true` |
| `coverage/coverage-summary.json` | 四维覆盖率 |

### 2.4 ⚠️ 半截状态专题：`pnpm-lock.yaml` 已写、`package.json` 未写（**下一棒第一优先级**）

#### 2.4.1 实测证据

```bash
git diff --stat -- pnpm-lock.yaml
#  pnpm-lock.yaml | 1982 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++--
#  1 file changed, 1944 insertions(+), 38 deletions(-)

git diff -- pnpm-lock.yaml | head -20
#  importers:
#        '@vitest/coverage-v8':
# -        version: 3.2.4(vitest@3.2.4(@types/node@22.20.5)(tsx@4.23.15))
# +        version: 3.2.4(vitest@3.2.4(@types/debug@4.1.13)(@types/node@22.20.5)(jiti@2.7.0)(tsx@4.23.15))
#        electron:
#          specifier: 45.2.2
#          version: 45.2.2
# +      electron-builder:
# +        specifier: ^26
# +        version: 26.18.0(electron-builder-squirrel-windows@26.18.0)
# +      electron-updater:
# +        specifier: ^6.8
# +        version: 6.8.11
# ...
# +  packages/ui: {}
#
git diff --stat -- package.json          # 空：package.json 未改
node -e "const p=require('./package.json'); console.log(p.devDependencies['electron-builder'], p.devDependencies['electron-updater'])"
# undefined undefined
ls -la _tmp_2992_c8a08bf15dca424991930c32439a4a06
# -rw-r--r-- 2 leolee 197121 0 Nov  6 23:25 ...   <- 0 字节普通文件，不是目录
```

**结论**：`pnpm add` 在解析并写入 lock 之后、回写 `package.json` 之前被 `safe-delete` 拦下（或后续命令被中断）。lock 里已经有 `electron-builder@26.18.0` / `electron-updater@6.8.11` 的 importer 条目与整棵依赖子树（+1944 行），同时把 `@vitest/coverage-v8` / `vitest` 的 peer 后缀从 `(@types/node@22.20.5)(tsx@4.23.15)` 改成了 `(@types/debug@4.1.13)(@types/node@22.20.5)(jiti@2.7.0)(tsx@4.23.15)`，并新增 `packages/ui: {}` importer。因此产生 **37 条 `-` 内容行**。

#### 2.4.2 这个状态会怎么咬人（三条，务必按顺序处理）

1. **旧 frozen 门控立刻红**：`frozenFilesUntouched()` 要求 `git diff HEAD -- packages/shared/src/request.ts pnpm-lock.yaml package.json` 为空，现在 lock 有 1982 行改动 → `M3-GATE-frozen` / `M4-GATE-frozen` 必 FAIL。**不要用「改报告口径」绕过**（会污染历史结论）。
2. **方案 A 的 R3 也会红**：本轮草稿 `scripts/frozen-gate.mjs::checkFrozen()` 的 R3 是「`lockDiff` 出现任何 `-` 行即 FAIL」。当前 lock 的 37 条 `-` 行**并非既有 resolution 被删**，而是 pnpm 重写 peer 后缀。→ 接线前必须把 R3 细化为「只允许 peer 后缀重写 / importer 新增块，禁止删除 `resolution:` / `version:` 实体条目」，否则即使门控改造完成也过不了。
3. **`pnpm install` 会「修好」也可能「固化」**：若直接重跑 `pnpm install`，pnpm 会以 lock 为准，把两个新依赖装进 `node_modules`，但 `package.json` 仍缺声明（workspace 根缺 devDependencies 条目），后续 `pnpm add` 或 CI 会出现「装了但没声明」的漂移。

#### 2.4.3 两种收尾方案（下一棒自己选，都要留痕）

| 方案 | 操作 | 适用 | 风险 |
|---|---|---|---|
| **A · 回滚到干净基线（推荐先做）** | `git checkout -- pnpm-lock.yaml`（**只此一个文件**，绝不 `checkout .`），删除 0 字节临时文件；然后按 §10.1 先改门控、再按 §9.5 重新走 N1 | 想从干净状态重来、要先验证门控改造 | 会丢掉已解析好的依赖树，重跑 `pnpm add` 仍需解坑 A/B |
| **B · 补齐当前状态** | 手工把 `electron-builder@^26.0.0` / `electron-updater@^6.8.0` 写进根 `package.json` 的 `devDependencies`（**注意 lock 里 specifier 是 `^26` / `^6.8`，而 `ytvdltPlannedDependencies` 登记的是 `^26.0.0` / `^6.8.0`——两者要统一，否则方案 A 的 R2 版本精确校验会 FAIL**），再 `pnpm install` 对齐，然后跑 M3/M4 门控 | 想保留已下载的依赖树、少一次联网 | 必须同时处理 R3 的 `-` 行判定；且这是「手工改 package.json」，要在 D-61 里写明 |

> **无论选哪个，都不要 `git add pnpm-lock.yaml` / `package.json` 进 C1/C2/C3**（架构设计 §6 的三份清单明确排除它们）。N1 产生的依赖声明改动归 **gate 后的增量 commit**，并从 **D-64** 起连续续号（若需改约定）。

#### 2.4.4 0 字节临时文件

`_tmp_2992_c8a08bf15dca424991930c32439a4a06` 是 pnpm `storePathRelativeToHome()` 探测时创建的 0 字节**文件**（`ls -la` 显示 link count 2，非目录），`safe-delete` 拦的就是删它。它未被 `.gitignore` 匹配，所以显示为 `??`。下一棒清理它时**单独删这一个文件**，不要 `rm -rf`、不要批量通配符。

---

## 3. §7 基线核对完整结果（本轮唯一完成的实质工作）

### 3.1 命令全文（全部离线、串行、12m15s）

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt
node scripts/handoff-check.mjs
git status --short
npm test
pnpm turbo run typecheck
node scripts/check-layering.mjs --json
for m in M1 M2 M3 M4 M5; do node scripts/acceptance.mjs --milestone $m; done
```

### 3.2 `handoff-check.mjs` 六项原文

| 校验点 | 仓库现状 | 来源 |
|---|---|---|
| 最后一次代码提交 | `e3c0d84`（2026-11-06） | `git log -1 -- apps packages scripts tests` |
| 决策编号 | D-01…D-60（下一棒从 **D-61** 起） | `grep "^## D-" docs/DECISIONS.md` |
| 截图用例数 | 30 个（PNG 基线数 = 用例数） | `tests/e2e/baselines/*.png` |
| M5 验收 | 8/10 PASS + 2 SKIPPED，`allGreen=true`，fresh | `reports/acceptance-report-m5.json` |
| E2E | 30/30 + 反例 5/5，fresh | `reports/e2e-summary.json` |
| 覆盖率四维最低 | **86.96%** | `coverage/coverage-summary.json` |

### 3.3 三件套

| 项 | 命令 | 实测 |
|---|---|---|
| 全量单测 | `npm test` | **53 files / 670 passed**（`Test Files 53 passed (53)` / `Tests 670 passed (670)`） |
| 覆盖率（v8） | 同上 | Stmts **95.36** / Branch **86.70** / Funcs **95.97** / Lines **95.36**；`[vitest-run] Evidence re-verified: fresh mtime, 0 failed tests, coverage min=86.7% (>=70%)` |
| 类型检查 | `pnpm turbo run typecheck` | **5/5**（5 packages） |
| 分层铁律 | `node scripts/check-layering.mjs --json` | `"violations": []`，**violationsCount = 0** |

> 口径提醒：`npm test` 的 **670** 与验收内部 vitest 的 **676** 是两套口径（后者含 5 个 L2 integration + 1 个额外用例），**不要混着引用**。

### 3.4 串行五套验收（**串行，禁并行**）

| 里程碑 | 实测输出 | 结论 |
|---|---|---|
| **M1** | `17/17 assertions PASS, 5/5 acceptance PASS`；`coverage min = 86.94%`；`allGreen=true` | ✅ |
| **M2** | `37/37 assertions PASS, 5/5 gates PASS`；`allGreen=true` | ✅ |
| **M3** | `48/48 assertions PASS, 3/3 regression rechecks PASS`；`12/12 gates PASS, 4/4 acceptance PASS`；`allGreen=true` | ✅ |
| **M4** | `9/9 assertions PASS`；`10/10 gates PASS, 4/4 acceptance PASS`；`coverage min = 86.95%`；`allGreen=true` | ✅ |
| **M5** | `8/10 assertions PASS, 2 SKIPPED (deferred)`；`10/10 gates PASS`；`coverage min = 86.94%`；**`allGreen=true releaseReady=false`** | ✅（含 2 SKIPPED） |

`M5` 结束时的 e2e 段：`30/30 cases PASS, 5/5 negative checks PASS, allPass=true`；负例 5 条为 `png-baseline-corrupted` / `png-baseline-replaced` / `dom-baseline-corrupted` / `fixture-corrupted-url` / `fixture-corrupted-format-id`。

### 3.5 与 v2.1 §0.4 / §1 逐项对照

| 校验点 | v2.1 写下的值 | 本轮实测 | 判定 |
|---|---|---|---|
| 最后代码提交 | `151a56e`（此前功能提交 `119bc44`） | **`e3c0d84`** | ⚠️ **文档过期**，以仓库为准，D-61 留痕 |
| 单测 | 53 / 670 | 53 / 670 | ✅ |
| 截图 | 30 用例 + 5 反例 | 30 + 5 | ✅ |
| M5 验收 | 8 PASS + 2 SKIPPED，10/10 门控 | 完全一致 | ✅ |
| 决策编号 | 已到 D-60，下一棒 D-61 | D-60 | ✅ |
| 覆盖率最低 | ≈86.9% | 86.70%（浮动 ±0.1） | ✅ |
| 类型检查 | 5/5 | 5/5 | ✅ |
| 分层铁律 | 0 | 0 | ✅ |
| M1–M4 回归 | 17/17+5/5 ／ 37/37+5/5 ／ 48/48+12/12+4/4 ／ 9/9+10/10+4/4 | 全部一致 | ✅ |
| 两条 SKIPPED | `A-4.4-28` / `A-4.4-29` | 仍 SKIPPED，**没写成 PASS** | ✅ |

**结论：除「最后代码提交」一项文档过期外，v2.1 的所有数字仍然成立。**

---

## 4. 已交付的 M5 离线四块（**不要重做**）

### 4.1 M5-0 生产 IPC 表面与装配

| 文件 | 作用 |
|---|---|
| `packages/shared/src/ipc.ts` | 8 个通道常量：`TASK_LIST` / `TASK_DETAIL` / `TASK_ACTION` / `TEMPLATE_LIST` / `TEMPLATE_SAVE` / `TEMPLATE_DELETE` / `SETTINGS_GET` / `SETTINGS_SET` |
| `apps/desktop/src/main/m5-channels.ts` | 8 个 handler + 载荷白名单；列表 DTO **无 `url`**；详情 URL 走 `maskUrlSecrets()`；模板写入过正向白名单；设置写 ConfigStore（accent 已校验） |
| `apps/desktop/src/main/m5-host.ts` | `createM5Host()` = M4 host + 8 通道 + `mergeGateways()`（重复通道抛错）+ `appearance()` |
| `apps/desktop/src/main/bootstrap.ts` | 单实例锁、`ipcMain.handle` 注册、加固窗口（`contextIsolation` / `nodeIntegration:false` / `sandbox`）、托盘、关窗最小化（**无托盘时不隐藏**）、`--url`→`?prefill=`、系统主题监听 |
| `apps/desktop/src/main/electron-entry.ts` | 唯一 import `electron` 的装配点：ports→logger→mapper→verifier→engine→`createM5Host`→bootstrap。**只通过类型检查，从未运行** |
| `apps/desktop/src/main/index.ts` | 导出 `bootstrap` / `createM5Host` / `M5_CHANNELS` |

证据：`tests/unit/m5-channels.test.ts` 14 例、`m5-host.test.ts` 7 例、`bootstrap.test.ts` 7 例。

### 4.2 M5-1 主题三态

- 策略 `packages/core/src/appearance/appearance.ts`（三态、强调色优先级、WCAG、减少动效、触觉省略）。
- 颜色唯一色源 `packages/ui/src/styles/theme.css`（浅色仍在 `ytvdlt.css`，冻结）。
- 应用 `packages/ui/src/theme/theme.js` 只写 `<html data-theme/data-accent/data-motion>`；**默认状态不写任何属性**。
- 证据：`appearance.test.ts` 17 例（从 CSS 反解对比度，5 预设 × 2 主题 × 2 表面全部 ≥4.5:1）；e2e `format-dark` / `queue-dark` / `settings-en-dark`。
- **关键回归证据：14 张 M3 中文截图重建后 `differPixels = 0`，DOM 每例仅 +6 行（1 个 `link` + 5 个 `script`）。**

### 4.3 M5-2 快捷键 + i18n

- 权威表 `packages/core/src/shortcuts/shortcuts.ts`（14 绑定；`Ctrl`→`Cmd`（macOS）；输入框聚焦不劫持；`Ctrl+Shift+V` 全局例外；冲突检测；`--url` 深链）。
- 镜像 `packages/ui/src/shortcuts/shortcuts.js`，**测试解析该文件与 core 逐字段比对**（防漂移）。
- 字典 `packages/ui/src/i18n/messages.js`（两语言键集合一致、占位符同名）；M3 弹窗用短语表运行时替换（HTML 冻结）。
- 证据：`shortcuts.test.ts` 12 例、`i18n.test.ts` 11 例；e2e `format-en` / `queue-en` / `settings-en-dark` 断言 `data-i18n-missing="0"`、`data-text-overflow="0"`。

### 4.4 M5-3 空/错状态 + 队列主页

- 新页面 `packages/ui/src/pages/queue/index.html` + `queue.js`：四 Tab（带计数）、搜索、卡片（进度/速度/ETA/动作）、粘贴框、空态引导、错误重试。
- 四个页面同构状态块：队列 / 详情 / 日志 / 批量入队。
- 证据：`task-view.test.ts` 8 例；e2e 30 例（新增 16 例）。

### 4.5 顺手补的两条断言

- `A-4.5-08` 崩溃守卫 `packages/core/src/crash/crash-guard.ts`（报告含版本/OS、不吞异常、pending→ack 改名不删除、同毫秒冲突改名）。
- `A-4.6-07` 桌面平台策略 `packages/core/src/platform/platform-policy.ts`（HKCU Run 自启、无需管理员；Android 残留扫描对真实 `packages/ui/src` **0 命中**）。

### 4.6 本轮之前已修复的 9 条「看起来绿但真错」

| # | 雷 | 修法 |
|---|---|---|
| 1 | i18n 覆盖子树（英文模式 Tab 计数消失） | 只替换首个文本节点，保留子元素 |
| 2 | i18n 覆盖占位符模板（顶栏显示字面量 `Running {active}/{limit}`） | 模板含 `{x}` 且已渲染 → 跳过，由页面 `t(key, params)` 负责 |
| 3 | 深链把完整 URL 写进 DOM（`data-prefilled="https://…?token=…"`） | 只写 `data-prefilled="true"` + `data-prefill-host`，加反例断言 |
| 4 | 无托盘时关窗即失联 | `trayReady` 门控：托盘创建失败则正常关窗 |
| 5 | 设置可写入垃圾强调色 | 预设 / `system` / 合法 hex 校验，非法抛错 |
| 6 | 硬编码通道名 | 改用 `IPC_CHANNELS.SETTINGS_GET` |
| 7 | e2e 断言假设属性顺序 | 统一 `id="x"[^>]*hidden="true"` |
| 8 | 输入框 focus 让截图抖动 15px | 加 `?focus=0`，`prefill()` 支持 `focus:false` |
| 9 | 空 `<pre>` 让写回检查失败 | 初始内容写 `{}` |

---

## 5. 没做什么（逐项原因，别误以为做了）

| 项 | 状态 | 原因 |
|---|---|---|
| `YTVDLT-Setup-0.1.0.exe` / `YTVDLT-Portable-0.1.0.exe` / `latest.yml` | 未产出 | electron 二进制与 electron-builder 未装成（N1-2 被拦） |
| 真实窗口、托盘图标、通知点击聚焦 | 未验证 | 无 Electron 二进制（B1 / D-39） |
| `electron-entry.ts` 首跑 | 未运行 | 同上 |
| 双通道自动更新（`electron-updater` + `latest.yml`） | 未实现 | 依赖未装 |
| 引擎更新（SHA2-256SUMS + 原子替换 + 回滚 + 暂停队列） | 未实现 | 需 N1 + 真实 `yt-dlp.exe` |
| `THIRD_PARTY_NOTICES.md` / `LICENSE-COMPLIANCE.md` / LGPL 12 条 | 未写 | 属 M5-6，本轮未开工 |
| L3 在线烟测、产物 SHA256 | 未做 | 无国际出口（N3），记 `SKIPPED` |
| 系统强调色读取（注册表 / DWM） | 返回 `null` | 需 N1 后接 `DwmGetColorizationColor`，当前回落预设 |
| 弹窗 i18n 动态拼接串（`'条目 #' + n`） | 仍中文 | 保 M3 基线，见 `M5-2-REPORT.md` §4；**放 M6，别在打包阶段顺手改** |
| 三份 M5-x-REPORT / D-61…63 / 三个 commit | 未产出 | 本轮实现 worker 全部零产出 |

---

## 6. 本轮四份设计/核查产物的内联摘要

### 6.1 增量 PRD v1.2（要点）

- **范围**：本轮 = 国内网类别级放行范围内可完成的 M5-4/5/6；范围外 = N3/L3、C13–C16 干净 VM（甲方签字）、`A-4.4-28/29` 转 PASS、代码签名正式发布、M6 弹窗动态串 i18n。
- **三个正交目标**：G1 打包可交付（不污染 frozen 门控）/ G2 双通道更新（如实标注）/ G3 合规与可信度（LGPL-3.0 12 条、决策连续、报告齐全、不夸大）。
- **用户故事 5 条**：US1 装依赖不打红门控 / US2 每条联网命令先报备确认 / US3 断网或校验失败时静默降级与回滚 / US4 NOTICE 逐条给证据、ACCEPTANCE 不手抄数字 / US5 未实测项明确标 SKIPPED、L3 原样记录等待通知。
- **需求池三层**：`P0`=离线核心+门控红线；`P1`=需 N1/N2 逐条确认；`P2`=甲方签字/国际网/真机转 PASS（本轮不可达）。§5.1 拆 10 条、§5.2 拆 6 条、§5.3 拆 6 条 + 横向收尾 6 条。
- **13 条诚实性约束**（关键 4 条）：代码写完 ≠ 实测通过；SKIPPED ≠ PASS；L3 原样语句；L2 本地实测 ≠ L3 真机/在线实测 ≠ 断言转 PASS。
- **Q1–Q3**（见 §9.4）。

### 6.2 增量架构设计 v1.4（要点 + T01–T05 完整列表）

**关键裁决（本轮反复订正后定稿）**

| # | 裁决 | 依据 |
|---|---|---|
| 1 | `docs/M5-SUMMARY.md` **核对不改、不进任何 commit** | `M5-GATE-docs`(:1246) 要两字面串 + `M5-GATE-blockers`(:1335) 读阻塞登记 + `M5_BLOCKERS`(:1147–1151) 硬编码 N1/N2/N3 |
| 2 | 「关于框措辞」**无需改文件** | `messages.js:153/:304` 已 LGPL-3.0；两份 DOM 基线含原句，改则触发重建 |
| 3 | `acceptance.mjs:1132` deferred 的「N3」笔误**本轮不订正** | 分类以施工单 §0.1 为准，不让脚本反向定义 |
| 4 | `ffmpeg/` = **7 DLL + 3 exe = 10 文件**，175 MB / 155 MB 双口径 | QA 实物核查 |
| 5 | 决策编号用**四条组合判据**，禁用 `tail -12`；**gate 绿 ≠ 编号合规** | 脚本 `decisionsOk` 只要求 ≥6 条连续、不禁止 D-64 |
| 6 | `A-4.4-28/29` 维持 SKIPPED，**L2 全绿也不改判** | 甲方红线 |

**架构核实到的 9 条源码事实**（这些是本轮最有价值、v2.1 没写的部分）

1. `frozenFilesUntouched()` **只被 M3(693) / M4(972) 调用，M5 不调用** → 方案 A 改造只影响两道门。
2. `M5-GATE-docs` 的 `reportFiles` **固定 5 份**（M5-0/1/2/3-REPORT + M5-SUMMARY），新增 M5-4/5/6-REPORT **不在数组内**、不影响门控；但 `decisionsOk` 要求 `dNumbers>=54` 恰好连续 `54+i`。
3. `M5_ASSERTIONS` **固定 10 条**（8 PASS + 2 SKIPPED），`A-4.4-28/29` 带 `deferred` + `layer:'L3'` → **绝不能新增断言 ID / gate ID / 改 deferred**。
4. `electron-updater` 未安装 → **任何静态 import 都会让 typecheck 报 TS2307 破 5/5**。用 `UpdaterPort` 接口 + `AppUpdateCoordinator` 纯协调器 + 依赖注入；适配器文件列为 N1 gate 后创建；`publish` 用运行时 `configure({provider:'generic',url})`，**不写进 yml**。
5. `check-layering.mjs` 的 `SCAN_TARGETS` **只扫 `packages/{shared,core,engine-ytdlp,ui}/src`，不扫 `apps/desktop/src/main`** → 引擎更新 I/O 全走既有 `CorePorts` 注入即可；只需给 `FileSystemPort` append-only 加 `readBytes()`（改 `ports.ts` 不触发 frozen）。
6. `YtDlpEngine.selfUpdate()`（`yt-dlp-engine.ts:332`）当前是 `throw unknownPlaceholder()`；`TaskQueue.pump()`（`task-queue.ts:165`）是取新任务**唯一入口** → 暂停队列 = `pump()` 首行 `if (intakePaused) return` 标志位，不调 `cancel()`、不写 `Canceled`。
7. `FileSystemPort.rename()`（`adapters/node-ports.ts:91-93`）会先 `fs.rm(to)` 再 rename → **引擎更新必须先落 `.bak` 备份**，否则回滚无据。
8. 根 `README.md` **不存在**；6 份合规文档全为新增；`config-store/defaults.ts:58-59` 已有 `updateChannel:'stable'` / `updateInterval:'weekly'`。
9. `messages.js:153/:304` 的 `about.license` 已是 LGPL-3.0（中英一致）；`settings/index.html` 含 about 文本且被 e2e `settings-*` 截图。

**T01–T05 有序任务列表**（依赖：`基线已跑完 → T01 → {T02→C1, T03→T04→C2} → C1&C2 → T05 → C3`）

| 任务 | 内容 | 依赖 | commit | 层级 |
|---|---|---|---|---|
| **T01 基础设施** | `scripts/frozen-gate.mjs` 的 `checkFrozen({coreDiff,pkgHead,pkgWork,lockDiff})`；改 `acceptance.mjs:569-578`；`M3/M4-GATE-frozen` 的 `actual` 附 `reasons`；`tests/unit/frozen-gate.test.ts` ≥6 例并登记 `M3_TEST_FILE_MAP`；D-61（含 §0.4 差异）；`docs/M5-4-REPORT.md` | 无 | C1 | 离线 ✅ |
| **T02 打包离线逻辑** | `apps/desktop/src/main/data-dir.ts`（`ProbePort` / `createNodeProbePort()` / `resolveDataDir()`，可写探针+回退，不用 `process.cwd()`）；`runtime-paths.ts` 加 `resolveFixtureDir(env,cwd)`；`electron-entry.ts` 改 L58-60 数据目录 + L83/92/93 三处 fixture 路径；`m5-host.ts` 加 `aboutInfo?` / `aboutInfo()` 纯数据；`data-dir.test.ts` ≥6、`runtime-paths.test.ts` ≥4 | T01 | C1 | 离线 ✅ |
| **T03 更新内核** | `packages/shared/src/ports.ts` append-only `readBytes()`；新增 `packages/shared/src/update.ts` 纯类型（`EngineUpdateSource`/`QueueIntakeGate`/`UpdaterPort`/`AppUpdateOutcome`/`ChecksumEntry`）；`shared/index.ts` 导出；`packages/engine-ytdlp/src/self-updater.ts`（校验→`.new`→`.bak`→rename→复验→回滚 + `parseChecksums()`，**零 `node:*`**，I/O 走 `CorePorts`，`try/finally` 保证 `resume()`）；`yt-dlp-engine.ts` 用委托替换占位符；`ITaskQueue` 加 `intakePaused`/`pauseIntake()`/`resumeIntake()`；`self-updater.test.ts` ≥10、`task-queue-intake.test.ts` ≥5 | T01 | C2 | 离线 ✅ |
| **T04 更新装配** | `apps/desktop/src/main/app-updater.ts`（`AppUpdateCoordinator.checkAndApply()`，读 `advanced.updateChannel`/`updateInterval`、`intervalDue()`、generic `configure()`、失败 `degrade()` **只写日志 + 一次非阻塞提示、不弹框**）；`adapters/local-dir-update-source.ts`、`adapters/queue-intake-gate.ts`（惰性 getter 消除装配环）；`node-ports.ts` 实现 `readBytes()`；`electron-entry.ts` 装配 stub；`app-updater.test.ts` ≥6；`engine-update-local.test.ts`（**本地 L2 实测**：`os.tmpdir()` 下复制真实 `yt-dlp.exe`+`SHA2-256SUMS`，跑通校验/原子替换/回滚/暂停队列/坏值拒绝，断言**原文件 SHA256 前后不变**）；D-62；`M5-5-REPORT.md` | T03 | C2 | 离线 L2 ✅ / 实测待 gate |
| **T05 合规 + L3** | 六份合规文档；`M5-6-REPORT.md`（产物 SHA256 段标「待 gate」；L3 原样语句；C13–C16/U7 标 SKIPPED/待甲方）；D-63；核对（不改）`messages.js::about.license` | T01/T02/T04 | C3 | 离线 ✅ / L3 不可达 |

**四张 Mermaid 图**：类图 1（更新模块）、时序图 2（引擎更新、应用更新）、任务依赖图 1，均内嵌设计文档 §3.1 / §4.1 / §4.2。

### 6.3 QA 合规事实核查表（要点）

- **许可证三处一致**：`FFMPEG-LICENSE.txt`（7651 B / 166 行 LGPLv3 全文，**已入库**）+ `runtime-manifest.json` 10 个 ffmpeg 项 `"license":"LGPL-3.0"` + D-08。
- **12 条证据分布**：完全缺失 5 / 部分存在 4 / 可直接引用 3（详见 §8.2）。
- **§6.7 组件表**已按「许可证 / 是否随包 / 本地是否存在 / 证据路径」逐项核查（详见 §8.3）。
- **`git check-ignore` 实测**：`yt-dlp.exe`(.gitignore:16) / `node.exe`(:17) / `ffmpeg/`(:18) / `reports/**/*.json`(:8) 全部未入库。
- **ACCEPTANCE.md** 必须引用 `reports/acceptance-report-m5.json` + `e2e-summary.json` 字段、不手抄数字、注明「本地生成、不入库」（`git ls-files reports/` 只有 `.gitkeep`）。
- **10 处上游冲突**（C-1…C-10）：数量错（8→7 DLL）、关于框措辞、设计 §4 要求写「源码链接/编译方式/EULA/DLL 可替换」但恰是缺失项、任务书 §12.5 第12条「LICENSE 与二进制同目录」与实物不符、D-06 说改固定 autobuild 但 manifest 仍用 rolling latest、`fetch-runtime.mjs` 过时文案、12 条不能理解为都有证据、React/Vite/Playwright/Zustand 未安装等。

### 6.4 gate 表要点

见 §9，此处不重复。

### 6.5 `scripts/frozen-gate.mjs` 草稿（本轮唯一项目内新增文件，未提交）

**内容**：导出 `ALLOWED_NEW_DEPS`（`electron-builder: '^26.0.0'` / `electron-updater: '^6.8.0'`）、`lockDiffHasRemoval(lockDiff)`、`checkFrozen({coreDiff, pkgHead, pkgWork, lockDiff}) → {ok, reasons}`，纯函数、不跑 git。

| 规则 | 实现 |
|---|---|
| R1 | `coreDiff`（`git diff HEAD -- packages/shared/src/request.ts`）非空 → FAIL（硬锁 D-50） |
| R2 | `package.json` 除 `devDependencies` 外所有顶层字段稳定比较一致；`devDependencies` 只允许**新增**两个白名单依赖且版本精确；既有键不得改值/删除 |
| R3 | `pnpm-lock.yaml` diff 出现任何 `-` 开头内容行（排除 `--- ` 文件头）→ FAIL；`+` 行为新增依赖产物，放行 |
| R4 | 返回 `{ok, reasons}`，不抛异常 |

**状态**：**草稿，未接进 `scripts/acceptance.mjs`、未写测试、未跑验收、未 commit**。下一棒可复用（按 §10.2 接线 + 补测试 + 登记 `M3_TEST_FILE_MAP`）或直接删除重做。
**已知缺陷两处，复用前必须修**：
1. **R2**：对「既有键恰为白名单依赖且被改版本」有跳过分支；当前 `package.json` 不含这两键故不受影响。
2. **R3 过严（更重要）**：当前规则是「`lockDiff` 出现任何 `-` 行即 FAIL」，但 §2.4 的实测 lock 有 **37 条 `-` 行**，全部来自 pnpm 重写 `@vitest/coverage-v8` / `vitest` 的 peer 后缀（`@types/node@22.20.5)(tsx@4.23.15)` → `(@types/debug@4.1.13)(@types/node@22.20.5)(jiti@2.7.0)(tsx@4.23.15)`），**不是既有 resolution 被删**。若不细化，门控改造完成后仍会 FAIL。建议改为：只禁止删除 `resolution:` / `version:` 实体条目与 importer 删除，允许 peer 后缀重写与新增 importer 块；并在 `tests/unit/frozen-gate.test.ts` 补一例「peer 后缀重写通过、删 resolution 拒绝」。

---

## 7. 排雷总表（**动手前必读**）

### 7.1 v2.1 §6.2「下一棒必踩 17 条」逐条 + 本轮状态

| # | 雷 | 现象 | 处理 | 本轮状态 |
|---|---|---|---|---|
| ① | **装依赖打红 M3/M4 frozen 门控（必踩，先处理）** | `pnpm add` 改 `package.json` + lock，`frozenFilesUntouched()` 的 `git diff HEAD -- request.ts pnpm-lock.yaml package.json` 立刻非空 → `M3-GATE-frozen` / `M4-GATE-frozen` 红。**本轮 lock 已被半截写入，旧门控现在就是红的** | **方案 A**：只锁 `request.ts`，package/lock 改「只允许新增依赖声明」显式检查，登记 D-61。方案 B（放独立 package.json）绕不过 lock；方案 C（改报告口径）会污染 M3/M4 历史结论，不推荐 | ⚠️ 草稿已写、未接线；**R3 还需按 §2.4.2 细化，否则仍会红** |
| ② | **验收必须串行** | 五套共用 `reports/vitest-results.json`、`coverage/`、端口与临时目录；并行 = 证据互相覆盖 | `for m in M1 M2 M3 M4 M5; do ...; done` | ✅ 本轮基线已串行 |
| ③ | **验收运行期间不要改源码** | vitest 读到新旧混合模块，产生假失败 | 验收期间冻结源码 | ✅ 本轮遵守（**属「必须遵守」，不是「不碰」**） |
| ④ | **新增 `<link>`/`<script>` 必改 DOM 基线** | 不加加载点会挂快照；重建若无审计等于丢掉回归证据 | 重建前拷 `tests/e2e/baselines`，重建后逐例 **0 容差**像素对比 | ✅ 本轮零 UI 改动 |
| ⑤ | **打包后 `process.cwd()` 不可靠** | `electron-entry.ts:83/92/93` 的 `tests/fixtures/*.json` 打包后不存在 | 走 `process.resourcesPath`，或把 M3 的 `PROBE` 换 `engine.probe()`（D-31 遗留） | ⛔ 未做 |
| ⑥ | **asar 里不能 spawn** | `resources/runtime/**` 绝不能进 `files` | `electron-builder.yml` 已配好 `extraResources`，**改配置时别顺手加 glob** | ✅ 配置未动 |
| ⑦ | **NSIS 首次构建要符号链接权限** | 下 winCodeSign 解压符号链接，普通账户报 `EBUSY` | 开「开发人员模式」或以管理员跑一次（不影响 per-user 安装属性） | ⛔ 未打包 |
| ⑧ | **便携版数据目录** | `app.getPath('appData')` 仍指 `%APPDATA%`，不等于 exe 同目录 | 自己实现「可写探针 + 回退」，结果写进日志与「关于」框 | ⛔ 未做 |
| ⑨ | **新增测试文件不登记 = 门控必挂** | `M3_TEST_FILE_MAP` 是 M3/M4/M5 三处共享 | 新文件登记映射，新 ID 进 `runM3`/`runM4`/`runM5` 的 `knownIds` | ✅ 待执行 |
| ⑩ | **文档门控是「连续编号」** | `M5-GATE-docs` 要 D-54 起连续 ≥6 条且 5 份报告齐全；跳号（只写 D-61、D-63）会 FAIL | D-61/62/63 按序追加 | ⚠️ 见 §7 坑 H（脚本比想象中宽松，但四条组合更严） |
| ⑪ | **覆盖率只测 `packages/core` + `engine-ytdlp`** | 打包脚本、`apps/desktop` 的 JS 不计入；但**新加的 core 模块必须配测试**，否则四维之一掉到 70% 以下 | 新 core 模块配测试（当前 ≈86.9%，缓冲约 17 点） | ⛔ 待执行 |
| ⑫ | **Electron 45 + builder 26 + Node 22** | `electron-builder` 对 pnpm workspace 常需 `node-linker=hoisted` 或 `shamefully-hoist=true`（当前 `.npmrc` 是 `false`）；报 "cannot find module electron" | 先改 `.npmrc` 再重装，**不要改业务代码**；改配置也须报备 | ⛔ 未触发 |
| ⑬ | **`latest.yml` 的 `sha512` 与签名** | 未签名包能生成 `latest.yml`，但 `electron-updater` 在 Windows 校验签名失败会拒装 | 无证书阶段走「手动下载覆盖安装」，报告写明**签名限制、不是功能缺陷** | ⛔ 待 Q3 |
| ⑭ | **引擎更新的「暂停队列」不是「取消」** | `TaskQueue.cancel()` 会写 `Canceled` 终态，恢复不了 | 用「停止取新任务 + 等当前任务结束」的**标志位**（`pump()` 首行拦截） | ⛔ 待实现 |
| ⑮ | **托盘 / 通知真实行为仍未验证** | `bootstrap` 用假 electron 测过菜单与隐藏策略，图标路径/DPI/点击聚焦只能真机确认（B5） | 留 gate 后 | ⛔ 待 N1 |
| ⑯ | **M3 弹窗仍是「短语表 i18n」** | 英文下 `'条目 #' + n`、`'任务日志 · ' + id` 仍中文 | 重写这些 JS 走 `t(key, params)` 会动 DOM 基线 → **放 M6，别在打包阶段顺手改** | ✅ 本轮未动 |
| ⑰ | **`reports/` 不入库** | `acceptance-report-m5.json`、`e2e-summary.json`、`layering.json` 都在 `.gitignore` | 引用时说明「本地生成」，不要指望 clone 后直接看到 | ✅ 本轮遵守 |

**映射结论**：本轮必须绕/遵守 = ①②③④⑤⑥⑧⑨⑩⑪⑭⑰；部分绕+报告口径 = ⑬；gate 后处理 = ⑦⑫；本轮不碰相关代码 = ⑮⑯。

### 7.2 本轮新增 14 条坑（A–N，v2.1 未覆盖）

**坑 A · `pnpm add` 被 WorkBuddy `safe-delete` 保护拦截（本轮实际失败点，非网络问题）**

`pnpm add -D 'electron-builder@^26' 'electron-updater@^6.8' -w` 完整报错：
```
 ERROR  [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":50,"threshold":50,"scope":"turn","targets":["C:\\Users\\leolee\\WorkBuddy\\2026-11-05-08-16-08\\ytvdlt\\_tmp_2992_c8a08bf15dca424991930c32439a4a06"],"targetCount":1}

pnpm: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":50,"threshold":50,"scope":"turn","targets":["..."]}
    at checkBulkDeleteGuard (C:\Users\leolee\AppData\Local\Programs\WorkBuddy\resources\app.asar.unpacked\cli\vendor\shim\node-safe-delete-shim.cjs:243:19)
    at tryTrash (.../node-safe-delete-shim.cjs:595:5)
    at Object.unlink (.../node-safe-delete-shim.cjs:765:9)
    at storePathRelativeToHome (C:\Users\leolee\AppData\Local\node\corepack\v1\pnpm\9.15.9\dist\pnpm.cjs:109942:29)
    at async createOrConnectStoreController (pnpm.cjs:132747:24)
    ...
N1-2 EXIT=1
```
根因：WorkBuddy 注入的 `node-safe-delete-shim` 按 **turn** 累计删除次数，达 50 次即要求确认；pnpm 创建 store controller 时要删临时文件撞上阈值。**与国内网、与依赖版本都无关。**
处理（按代价从低到高）：① 在**新的命令调用**里单独重跑 `pnpm add`（计数按 turn 重置）；② 减少同一轮里其它删除型命令后再跑；③ 用 `npm install -D ... --no-save` 之类替代路径；④ 检查 `NODE_OPTIONS` 里的 shim 注入，必要时在该命令内临时清除（**需甲方知情**）。**不要静默重试、不要擅自换代理。**

**⚠️ 实测残留（本轮 23:33 复核，比报错本身更重要）**：这次失败并非「什么都没写」。`pnpm-lock.yaml` 已被写入 **+1944 / −38 行**（含 `electron-builder@26.18.0` / `electron-updater@6.8.11` importer 与整棵依赖子树、peer 后缀重写、新增 `packages/ui: {}` importer），而 `package.json` **完全没改**（两个依赖仍 `undefined`）；另留下 0 字节临时文件 `_tmp_2992_c8a08bf15dca424991930c32439a4a06`。**即「lock 已写、package.json 未写」的半截不一致状态**，完整证据与两种收尾方案见 **§2.4**。下一棒若直接重跑 `pnpm add` / `pnpm install`，会在这个中间态上继续，务必先读 §2.4。

**坑 B · `pnpm install` 显示 `Already up to date` 但不补 Electron 二进制**

本轮 `pnpm install` 原文：
```
Scope: all 6 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 7.2s using pnpm v9.15.9
N1-1 EXIT=0
```
但 `node_modules/electron/dist/electron.exe` **仍不存在**，`node -e "console.log(require('electron'))"` 无输出。原因：lockfile 已含 `electron@45.2.2`，pnpm 跳过 postinstall，二进制从未下载。
处理：装依赖后**显式**跑 `pnpm rebuild electron` 或 `node node_modules/electron/install.js`，再验 `ls node_modules/electron/dist/electron.exe` 与 `require('electron')` 返回路径。国内镜像可设 `ELECTRON_MIRROR`（换源仍属联网，须报备）。

**坑 C · 异步 teammate 全部零产出（协作机制坑）**

三次派实现 worker（`software-engineer` ×2、`general-purpose` ×1）全部零文件、零 commit。根因：专家角色模板 `software-engineer.md` 第 41 行写死「使用 `write_to_file` 调用」，当前会话只有 `Write` / `Edit` / `Bash`，worker 一直在找不存在的工具。**已验证**：不带 `name` 的**同步子代理**（`Agent` 默认 foreground）用 `Bash` 写、`Write` 写、`git status` 三步全部 `Exit Code: 0`，项目目录可正常读写。→ 下一棒实现请用同步子代理或主理人自己动手，**不要再派 `software-engineer` 异步 teammate**；团队 6 个 paused worker 不要恢复（详见 §16）。

**坑 D · FFmpeg DLL 是 7 个，不是 8 个**

`resources/runtime/win-x64/ffmpeg/` 实物：`avcodec` / `avdevice` / `avfilter` / `avformat` / `avutil` / `swresample` / `swscale` **7 个 DLL** + `ffmpeg.exe` / `ffprobe.exe` / `ffplay.exe` **3 个 exe** = 10 文件；合计 **174,731,264 B ≈ 175 MB / 166.6 MiB**，仅 DLL **154,699,776 B ≈ 155 MB / 147.5 MiB**。早期文档里的「8 个 DLL、163 MB」是错的，NOTICE 按 7 个列全名单。

**坑 E · FFmpeg 实际许可证 LGPL-3.0；`fetch-runtime.mjs` 残留旧文案**

D-08（`DECISIONS.md:112–119`）原文结论：BtbN LGPL 构建随 FFmpeg 9.0 升级改用 **GNU LESSER GENERAL PUBLIC LICENSE Version 3, 29 June 2007**；zip 内 `LICENSE.txt`（7651 B）与 `ffmpeg.exe -L` 一致；`runtime-manifest.json` 记 `LGPL-3.0`；configure 实测 `--disable-libx264 --disable-libx265`（不含 `--enable-gpl` / `--enable-nonfree`）。D-08 自己已写明「**M5 需按 §12.5 逐条复核文案**（『本软件使用 LGPLv2.1 下的 FFmpeg』应改为与实际文本一致的 LGPLv3 措辞）」。
另：`scripts/fetch-runtime.mjs:203-209` 兜底分支含 `'LGPL version 2.1 or later'` + `lgpl-2.1.txt` 链接（本轮未触发，但上游 zip 改文件名就会生成错误许可证文本）。建议 M5-6 时一并订正为 LGPL-3.0 或「缺 LICENSE 直接报错」；若改动有风险，在 `M5-6-REPORT.md` 的「待 gate」栏登记为已发现待处理，**不要为凑数硬改**。

**坑 F · `docs/M5-SUMMARY.md` 本轮核对不改、不进任何 commit**

`M5-GATE-docs`(`acceptance.mjs:1246`) 要求该文件含「**未获甲方放行**」+「**N1**」两个字面串；`M5-GATE-blockers`(1335) 又读它的阻塞登记，而 `M5_BLOCKERS`(1147–1151) **硬编码 N1/N2/N3 三项**。改它有双重变红风险。所有新状态只写进新增的三份 `M5-x-REPORT.md`。

**坑 G · `M5_ASSERTIONS` 固定 10 条，禁止新增断言/门控 ID**

`acceptance.mjs:1126` 的 10 条中 `A-4.4-28`(:1132) / `A-4.4-29`(:1133) 带 `deferred` 且 `layer:'L3'`。新测试文件一律映射**既有白名单 ID**：`A-M5-00` / `A-4.4-28` / `A-4.4-29` / `M3-GATE-frozen` / `M4-GATE-frozen`（这 5 个在 runM3(803)/runM4(1055)/runM5(1299) 三处 `knownIds` 均合法）。新增测试文件必须登记 `M3_TEST_FILE_MAP`(`acceptance.mjs:444`)，否则三套门控全挂。

**坑 H · 决策编号：四条组合判据严格强于脚本门控**

`acceptance.mjs:1237-1239` 的 `decisionsOk = m5Decisions.length >= 6 && m5Decisions.every((n,i)=>n===54+i)` **只要求「D-54 起 ≥6 条连续」，不禁止 D-64**（[54…64] 共 11 条时照样 PASS），正则还要求编号后有 ` ·`（`/^## D-(\d+) ·/gm`）。→ 不能只凭 `M5-GATE-docs: PASS` 判合规，须独立跑：
```bash
grep -c '^## D-' docs/DECISIONS.md                 # 期望 63
grep '^## D-' docs/DECISIONS.md | tail -10          # 期望 D-54…D-63 共 10 条
grep '^## D-64' docs/DECISIONS.md                   # 期望无命中
# 并确认 D-01…D-63 全序列无跳号
```
**禁用 `tail -12`**（63 条时返回 D-52…D-63，与「共 10 条」不自洽，会制造假 FAIL）。D-61/62/63 必须按序追加、不跳号。

**坑 I · 「关于」框零 UI 改动**

`packages/ui/src/i18n/messages.js:153`（`'about.license': 'FFmpeg 采用 LGPL-3.0，源码与许可全文见 THIRD_PARTY_NOTICES。'`）/ `:304`（`'FFmpeg is LGPL-3.0; see THIRD_PARTY_NOTICES for sources and the full licence.'`）**已是 LGPL-3.0**；`grep -rl LGPL tests/e2e/baselines/` 只命中 `settings-appearance.dom.html` / `settings-en-dark.dom.html`，两份字面含该原句。改文案会挂 `i18n.test.ts` 两语言键集校验 + 触发 §6.2-④ DOM 基线重建。→ 作为**已满足项**写进 `M5-6-REPORT.md` 栏① 并附证据路径，D-63 记「已合规、无需订正及理由」；并如实注明文案指向的 `THIRD_PARTY_NOTICES.md` 本轮新建后才闭环。

**坑 J · 本机二进制未入库**

`resources/runtime/win-x64/` 下 `yt-dlp.exe`(23,575,744 B) / `node.exe`(93,922,624 B) / `ffmpeg/` / zip 被 `.gitignore` 第 16–20 行忽略（`git check-ignore` 实测）。是「**本机工作区磁盘已就位**」，**不是**「随仓库自带」；clone 后 / 干净 VM 无此文件。引擎更新的校验/原子替换/回滚/暂停队列可用**复制到 `os.tmpdir()` 的副本**做离线 L2 实测，**绝不写原目录**；证据须标「本地 L2、非真机、非在线拉取」。

**坑 K · 网络分类口径**

以 v2.1 §0.1 + 甲方原话为准：**N1**=包管理器（`pnpm install` / 装库）、**N2**=发布包（GitHub Releases 取 `yt-dlp.exe` / `SHA2-256SUMS`、Electron 预编译包）、**N3**=国际站点（YouTube）。`acceptance.mjs:1132` 的 deferred 文案把取 `yt-dlp.exe` 写成「N3」属**遗留笔误**，本轮不订正（避免动验收脚本引发回归），只在 `M5-5-REPORT.md` 与 D-62 留痕，**不要让脚本反向定义分类**。

**坑 L · 红线：`L2 本地实测 ≠ L3 真机/在线实测 ≠ 断言转 PASS`**

即便离线 L2 全绿，`A-4.4-28` / `A-4.4-29` **仍维持 SKIPPED**；`releaseReady=false` 不改写；M5 仍应是 8 PASS + 2 SKIPPED + 10/10 门控。范围变的是「证据深度可达」，不是「断言状态词」。

**坑 M · 分层与 typecheck 边界**

`check-layering.mjs` 的 `SCAN_TARGETS` 只扫 `packages/{shared,core,engine-ytdlp,ui}/src`，**不扫 `apps/desktop/src/main`**；`electron-updater` **未安装**，任何静态 import 都会让 typecheck 报 TS2307 破 5/5 → 用端口接口 + 依赖注入，适配器文件留到 N1 之后创建。

**坑 N · 其它已核实的装配事实**

`yt-dlp-engine.ts:332-334` 的 `selfUpdate()` 仍是 `throw unknownPlaceholder('selfUpdate')`；`task-queue.ts:165` 的 `pump()` 是取新任务唯一入口；`adapters/node-ports.ts:91-93` 的 `rename()` 会先 `fs.rm(to)` 再 rename → **必须先落 `.bak` 备份**才能回滚；`config-store/defaults.ts:58-59` 已有 `updateChannel:'stable'` / `updateInterval:'weekly'`；根 `README.md` **不存在**；`frozenFilesUntouched()` **只被 M3(693)/M4(972) 调用，M5 不调用**；`electron-builder.yml` 的 `files` 已只含 `apps/desktop/dist/**/*` 与 `package.json`。

### 7.3 优先级：动手前必须先绕的

① frozen 门控（否则装依赖立刻打红）→ ② 串行验收 → ③ 验收期间冻结源码 → ⑨ 测试文件登记 → ⑩ 决策连续 → ⑭ 暂停队列用标志位 → A/B 两条安装坑 → D/E 两条合规事实 → F/G/H/I/J/K/L 六条口径。

---

## 8. 合规专题（写 M5-6 时照这一节）

### 8.1 许可证事实结论

**随包 FFmpeg 为 LGPL-3.0**（GNU LGPL Version 3, 29 June 2007）。三处证据一致：
1. `resources/runtime/win-x64/FFMPEG-LICENSE.txt`（7651 B / 166 行 LGPLv3 全文，**已入库**）；
2. `resources/runtime/win-x64/runtime-manifest.json` 10 个 ffmpeg 项 `"license":"LGPL-3.0"`；
3. `docs/DECISIONS.md` **D-08**（实测记录：zip 内 `LICENSE.txt` 与 `ffmpeg.exe -L` 均为 LGPLv3；configure `--disable-libx264 --disable-libx265`；等价性说明：仍是 LGPL 弱 copyleft、动态链接 DLL、无 `--enable-gpl` / `--enable-nonfree`）。

原始任务书 §6.7(`:537/:541`)、§12.5 第 6/7 条(`:867/:868`)、§5.2 F5(`:328`)、§5.3(`:347`) 的「LGPL-2.1+ / LGPLv2.1」是**过时文案**。合规文档必须按 LGPL-3.0 写并**显式登记这处差异**（引用 D-08，按设计裁决**不另立 D-64**，并入 D-63 + `M5-6-REPORT.md`）。

### 8.2 §12.5 LGPL 合规 12 条逐条核查表（**只能写「逐条给证据或缺失说明」，不能写「12 条均已履行」**）

来源：FFmpeg 官方 `https://www.ffmpeg.org/legal.html` + 邮件列表 `https://ffmpeg.org/pipermail/ffmpeg-user/2014-October/023839.html`（明确「安装包自带 DLL 时 LGPL 6b 不适用，必须提供对应源码且用户能替换成自编译 DLL」）。

| # | 官方要求 | 本仓库证据 | 状态 | 文档该怎么写 |
|---|---|---|---|---|
| 1 | 不含 `--enable-gpl` / `--enable-nonfree` | BtbN `*-win64-lgpl-shared*.zip` asset 名 + D-08/D-09 叙述；`runtime-manifest.json` 记来源 | **部分** | 写「使用 LGPL shared 构建」，注明**无 `-buildconf` 直接实证** |
| 2 | 动态链接（Windows 即 DLL），用户可替换 DLL | `ffmpeg/` 下 7 个 DLL + 3 exe 实存，DLL 与 exe 同目录原样分发 | **部分** | 写「shared 构建、DLL 可替换设计」，注明**「DLL 可替换」从未实测，需 gate 后才有** |
| 3 | 分发 FFmpeg 源码（无论是否修改） | **无 `ffmpeg-src.zip`、无源码链接**；`LICENSE-COMPLIANCE.md` 不存在；manifest 的 `sourceUrl` 是**二进制 zip 不是源码** | **完全缺失** | 写「外部链接 + 本仓库待补」，不得包装成已有证据 |
| 4 | 源码与二进制精确对应 | `releaseTag` 字段**存在**，但为**滚动** `latest/...published:2026-11-04T13:18:35Z`；**无独立 commit 字段**，version 里 `gb204e94e90` 只是 git describe 短哈希 | **部分 / 未闭环** | 如实写「rolling latest、精确对应未闭环，需 gate 后补固定 autobuild 与 commit」（D-06 说要改固定 autobuild，实物仍是 latest） |
| 5 | 说明编译方式（configure 行 / 构建脚本） | runtime 目录 grep `configure|workflow|commit` **0 命中**；schema 无该字段且 `additionalProperties:false` | **完全缺失** | 写「BtbN 构建 workflow 链接 + 本仓库待补」 |
| 6 | 下载页声明 | 根 `README.md` **不存在**、无发布页；旧文案还含过时 LGPLv2.1 | **完全缺失** | 新建 `README.md`，写 **LGPL-3.0** 固定文案 |
| 7 | 「关于」框声明 | `messages.js:153/:304` 中英已是 LGPL-3.0 | ✅ **可直接引用** | 作为已满足项写进 `M5-6-REPORT.md` 栏① + 证据路径；**不改文件** |
| 8 | EULA 提及 LGPL；不得禁止反向工程；不宣称拥有 FFmpeg 代码 | **无 EULA / LICENSE 文本** | **完全缺失** | 写「EULA 模板待补」，不得写成已具备 |
| 9 | DLL 不得混淆改名（可加前后缀） | `avcodec-*.dll` 等原名保留 | ✅ **可直接引用** | 列全 7 个名单 |
| 10 | 检查内嵌其它 LGPL 库（如 LAME）逐一列入 NOTICE | `THIRD_PARTY_NOTICES.md` 与 `THIRD_PARTY_LICENSES.txt` **均不存在**；`SHA2-256SUMS` 是 yt-dlp 二进制哈希清单，**不是许可证清单** | **完全缺失** | NOTICE 里如实写「待补」 |
| 11 | 不含 libx264 等 GPL 库 | D-08 有 `--disable-libx264 --disable-libx265` 叙述；DECISIONS 有 `-encoders` 叙述但**无产物落盘**，DECISIONS 全文 `U4|libmp3lame` **0 命中** | **部分** | 写「LGPL 构建天然不含；本产品只 remux/合并/转音频，不重编码视频」，注明 U4 未见结论留痕 |
| 12 | 随包完整许可证文本 | `FFMPEG-LICENSE.txt` 已入库 | ✅ **可直接引用** | 按**实物**写「位于同一 runtime 根的相邻目录」（任务书 §12.5 说「与二进制同目录」，但实物 LICENSE 在 `win-x64/` 根、DLL 在 `ffmpeg/` 子目录，两者不一致） |

**统计**：完全缺失 **5** 条（#3/#5/#6/#8/#10）、部分存在 **4** 条（#1/#2/#4/#11）、可直接引用 **3** 条（#7/#9/#12）。
**结论**：LGPL 是弱 copyleft，动态链接 + DLL 可替换 + 履行上述清单即可在自有许可证下分发桌面应用，**不会要求 YTVDLT 自身开源**，与 §3.6 Seal GPL 干净室重写策略无冲突。但**本轮不能声称 12 条均已履行**。

### 8.3 §6.7 组件清单（NOTICE 该列什么）

| 组件 | 版本基线 | 许可证 | 是否随包 | 本地实物 | 备注 |
|---|---|---|---|---|---|
| Electron | 45.2.2（Node 24.22.2 / Chromium 156） | MIT | 随包 | 二进制**缺失** | 需 N1 |
| `yt-dlp.exe` | 2026.10.26 stable（可切 nightly） | 源码 **Unlicense**；standalone exe 含第三方组件，见 `THIRD_PARTY_LICENSES.txt` | 随包 + `SHA2-256SUMS` 校验 | 23.5 MB，本机有、**未入库** | NOTICE 必须收录第三方组件，不能只写 Unlicense |
| `node.exe`（EJS JS runtime） | 24.x | MIT | 随包 | 93.9 MB，本机有、**未入库** | 注入 `--no-js-runtimes --js-runtimes node:<path>` |
| `ffmpeg.exe` / `ffprobe.exe` / `ffplay.exe` + **7 个 LGPL DLL** | 9.0.x BtbN `*-win64-lgpl-shared.zip` | **LGPL-3.0**（D-08） | 随包（`extraResources`，不在 asar） | 10 文件 / ≈175 MB，本机有、**未入库** | 12 条逐条见 §8.2 |
| `aria2c.exe`（可选） | 1.37.x | **GPL-2.0-or-later** | **不捆绑**，用户自备 + 路径配置 | 无 | NOTICE 明确标注 |
| `yt-dlp-ejs` | 官方 exe 内置 | 待确认（F14） | 不单独获取 | — | 每轮引擎升级验证 `--js-runtimes` |
| npm 依赖 | 见 `package.json` devDependencies | MIT 等 | 开发依赖 | 已装 | **只列实际 devDependencies** |

> ⚠️ **不能照抄 §6.7**：任务书把 React / Vite / Playwright / Zustand 列为「常规 MIT 开发依赖」，但 **D-31 已改为零新增依赖的静态 HTML/CSS**，这些包**从未安装**，只在 `package.json → ytvdltPlannedDependencies` 登记。NOTICE 不得写成「已随包 / 已使用」。

### 8.4 「关于」框与 DOM 基线（坑 I 展开）

`grep -rl LGPL tests/e2e/baselines/` 只命中 `settings-appearance.dom.html` / `settings-en-dark.dom.html`，两份字面含 `about.license` 原句 → 改文案会挂 `i18n.test.ts` + e2e 基线 + 触发 §6.2-④ 重建。结论：**零 UI 改动**。另需如实写明：`about.runtime` 的「随包」是**文案声明**，不是打包实证。

### 8.5 过时文案差异登记口径

在 `docs/THIRD_PARTY_NOTICES.md` 与 `docs/LICENSE-COMPLIANCE.md` 里各写一段：「原始任务书 §6.7 / §12.5 基于 FFmpeg 旧构建写作 LGPL-2.1+ / LGPLv2.1；D-08 已实测核实随包 BtbN FFmpeg 9.0 LGPL 构建的许可证文本为 **LGPL-3.0**（`FFMPEG-LICENSE.txt` 全文 + `ffmpeg.exe -L` + `runtime-manifest.json` 三方一致）。本文件按 **LGPL-3.0** 记录；这是事实核查结论，不改变动态链接 + 源码提供 + DLL 可替换的合规路径。」**引用 D-08 即可，不新增决策编号**（保持 D-61/62/63 连续）。

### 8.6 六份合规文档各自的内容要求

| 文件 | 必须包含 |
|---|---|
| `docs/THIRD_PARTY_NOTICES.md` | §6.7 全组件（按 §8.3，不照抄未安装项）；§12.5 **12 条逐条给证据或缺失说明**；Seal GPL-3.0 干净室重写声明（未复制代码、改名原因）；yt-dlp Unlicense + 第三方组件声明；FFmpeg **LGPL-3.0** + 源码获取方式；aria2 GPL-2.0-or-later；Electron/Node MIT；npm 依赖 |
| `docs/LICENSE-COMPLIANCE.md` | LGPL 合规总述 + 12 条落地方式；#3/#5/#8/#2 写成「外部链接 + 待补/未实测」；#4 rolling latest 未闭环；DLL 名单 7 个；源码提供与 DLL 可替换说明；EULA 待补 |
| `docs/BUILD.md` | 环境（Node 22.22.2 / pnpm 9.15.9）、N1 依赖安装、编译主进程、`electron-builder --win --x64`、产物路径、SHA256 命令、签名限制说明、NSIS 权限（§6.2-⑦）、`.npmrc` hoist 条件项（§6.2-⑫） |
| `README.md`（根） | 项目简介、下载页 **LGPL-3.0** 固定文案（英文 `"This software uses code of FFmpeg licensed under the LGPLv3 and its source can be downloaded here"` 的中英对照）、构建/运行入口、合规声明链接 |
| `docs/ACCEPTANCE.md` | **直接引用** `reports/acceptance-report-m5.json` 与 `reports/e2e-summary.json` 的字段（`allGreen` / `skipped` / `releaseReady` / `summary`），**不手抄数字**；注明「本地生成、不入库」，需要时在仓库跑命令重生成 |
| `docs/SHORTCUTS.md` | §6.8 全部 14 绑定（以 `packages/core/src/shortcuts/shortcuts.ts` 为权威表）、`Ctrl`→`Cmd`（macOS）、输入框聚焦不劫持、`Ctrl+Shift+V` 全局例外、`--url` 深链、冲突检测 |

---

## 9. 网络放行与 gate 表

### 9.1 三类定义（v2.1 §0.1 / §9）

| 词 | 含义 |
|---|---|
| **N1** | 包管理器网络（`pnpm install` / 装 electron-builder）；**国内镜像即可，不需要国际出口** |
| **N2** | 代码托管/发布网络（GitHub Releases 取 `yt-dlp.exe` + `SHA2-256SUMS`、Electron 预编译包）；通常国内可完成，慢可走镜像 |
| **N3** | 国际站点网络（访问 YouTube）；**必须国际出口**，没有就记 SKIPPED |

**一句话**：打包和引擎更新只要「国内网」；只有 L3 在线烟测必须「国际网」。

### 9.2 甲方批准状态

- 甲方本轮明确：**「国内网已放行」**（N1/N2 类别级），**国际网未放行**。
- v2.1 §0.1 硬规矩仍在：任何联网步骤先停下来问甲方，说清「哪一类 / 什么命令 / 多久 / 失败会怎样」，得到明确同意再动；**不许静默重试、不许擅自换代理、不许假设「应该能连」**。
- 甲方原话同时要求：「任何联网前先说明类别/命令/耗时并等我确认」「国际网未放行，L3 先记 SKIPPED，等我另行通知」。
- 本轮**已实际发起**的只有 N1-1、N1-2 两条；结果见 §0.2。

### 9.3 逐条命令表

| 序 | 类别 | 命令 / 地址 | 体量·耗时 | 失败后果 | 需甲方逐条确认 |
|---|---|---|---|---|---|
| N1-1 | 装依赖 | `pnpm install`（补 `electron@45.2.2`；**须另跑 `pnpm rebuild electron`**，坑 B） | 100–120 MB ／ 5–20 min | 无二进制 → 不能编译主进程/打包/开窗；改 lock 触发 frozen 门控（须先 D-61） | 是 |
| N1-2 | 装依赖 | `pnpm add -D 'electron-builder@^26' 'electron-updater@^6.8' -w` | 150–250 MB ／ 5–20 min（建议与 N1-1 合并） | 无打包/更新库 → 无 exe 与 `latest.yml`；**必改 `package.json` + lock**；本轮被坑 A 拦截 | 是 |
| N1-3 | 构建工具链 | `pnpm --filter @ytvdlt/desktop exec tsc -p tsconfig.json` → `electron-builder --win --x64`（首次自动下 NSIS / winCodeSign） | 数十 MB ／ 数分钟 | 工具链未下 → 打包失败；符号链接权限报 `EBUSY`（§6.2-⑦，开开发人员模式或管理员跑一次，属本地设置非联网） | 是（含下游下载） |
| N1-4 | 条件触发 | 仅当报 `cannot find module electron`：改 `.npmrc` 为 `node-linker=hoisted` / `shamefully-hoist=true` 后重跑 N1-1 | 等同 N1-1 | 不改则找不到模块；只改配置、**不动业务代码** | 是（改配置 + 重装均报备） |
| N2-1 | 下发布包 | `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe` | 17–20 MB ／ 秒级 | 只影响「从官方源拉新版本」的完整实测；**本地 L2 实测不受影响** | 是 |
| N2-2 | 下校验清单 | `https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS` | KB 级 ／ 秒级 | 同上；本地已有同名清单 | 是 |
| N2-3 | Electron 预编译包 | 约 100 MB | 分钟级 | 二进制不全 → 产物无法运行；多由 N1-1 postinstall 触发，与 N1 重叠，以真实触发命令报备、不重复放行 | 是 |
| **N3** | **国际网** | YouTube L3 在线烟测 + C1–C12（建议甲方有权保存的公开视频，Blender 开放电影） | 3–10 min | **本轮不做**：「国际网未放行，L3 先记 SKIPPED，等我另行通知。」 | — |

### 9.4 仍需甲方拍板（本轮未拍）

| # | 问题 | 不拍板的后果 |
|---|---|---|
| **Q1** | 逐条确认机制与**首批授权范围**（建议首批只授权 N1-1 + N1-2 合并一次）；N2-1/2 是否纳入首批 | 无法发起任何 N1/N2 命令，三块只能停在离线代码 + L2 + 报告 |
| **Q2** | GitHub 不通时允许用哪个**国内镜像 / 代理地址**（条件项，仅当甲方要求补做「拉新版本」实测且官方源不可达时才需要） | 不能擅自换代理；`A-4.4-28` 维持 SKIPPED |
| **Q3** | 是否提供**代码签名证书**；若不提供，是否接受「未签名安装包 + 手动下载覆盖安装 + 报告写明签名限制」降级口径（§6.2-⑬） | 应用自更新 v1→v2 自动安装链路只能按降级口径记录，**不得写 PASS** |

### 9.5 放行后执行顺序（本轮未执行）

```
0   前置（非联网）：handoff-check + 串行 M1–M5 复验，要求全绿、D-54…D-63 连续、git status 仅 M PROJECT-HANDOFF.md
0.5 Q1 拍板
1   N1-1 pnpm install（+ 显式 pnpm rebuild electron 验二进制）
2   N1-2 pnpm add ... → 立刻串行跑 M3、M4 验收，验证方案 A 白名单生效（门控改造的真实联网验证点）
3   N1-3 编译 + electron-builder --win --x64 出包
3.5 本地核验（非联网）：certutil -hashfile <file> SHA256 ×2 + latest.yml + 双击自检 4 项
4   N1-4（条件）
5   N2-3（若独立触发）
6/7 N2-1/2（若纳入首批；Q2 指定镜像/代理）
8   应用更新 v1→本地 v2 静态目录实测、引擎更新官方源全链路
9   Q3 签名口径结论
```
产物（`dist/` 下两个 exe 与 `latest.yml`）**不入库**；gate 后产生的证据**另起增量 commit**（如 `M5-gate-evidence:`），如需改约定从 **D-64** 起连续续号，**不 amend** C1/C2/C3。

### 9.6 本轮禁执行清单（若继续按 v2.1 §0.1 严格逐条报备，这些都要先报）

`pnpm install` / `pnpm add ...` / `electron-builder ...` / 任何 `curl|wget|Invoke-WebRequest` / 任何访问 `github.com` 或 `youtube.com` / 改 `.npmrc` 后重装。

### 9.7 N3 与 L3 口径（红线）

| 项 | 状态 |
|---|---|
| 访问 YouTube 做 L3 在线烟测 + C1–C12 | **不在本轮 · 国际网未放行 · L3 在线烟测不做** |
| 报告要求 | 原样落「**国际网未放行，L3 先记 SKIPPED，等我另行通知。**」；不得写 PASS，不得对外说「YouTube 能下」 |

---

## 10. 下一棒施工单（逐任务，细到函数与命令）

### 阶段 0 · 前置（离线，5 分钟）

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt
node scripts/handoff-check.mjs
git status --short
git log --oneline -3
grep -c '^## D-' docs/DECISIONS.md     # 期望 60（本轮结束时）
ls scripts/frozen-gate.mjs              # 本轮草稿，决定复用或删除
git diff --stat -- pnpm-lock.yaml       # 若非空 → 见 §2.4，先处理半截状态
```

**阶段 0 的额外一步**：`git status --short` 里若看到 ` M pnpm-lock.yaml`，**先按 §2.4.3 选 A（回滚）或 B（补齐）**，再进入阶段 1。不要在此状态上直接跑任何验收——旧门控必红，方案 A 的 R3 也会红。

### 阶段 1 · 先解 §6.2-① frozen 门控（**必须先做**）

1. 复用或重写 `scripts/frozen-gate.mjs::checkFrozen()`（§6.5 已有草稿，注意其 R2 小缺陷）；
2. 改 `scripts/acceptance.mjs:569-578` 的 `frozenFilesUntouched()`：用现有 `gitRun()` 分三次取 `git diff HEAD -- packages/shared/src/request.ts`、`git show HEAD:package.json`、当前 `package.json`、`git diff HEAD -- pnpm-lock.yaml`，调 `checkFrozen()`，保留原有「`"test:e2e"` 只出现 1 次」与「含 `ytvdltPlannedDependencies`」两项校验；
3. 让 `M3-GATE-frozen`(:833) / `M4-GATE-frozen`(:1084) 的 `actual` 附 `reasons`；
4. 新增 `tests/unit/frozen-gate.test.ts` ≥6 例（全空通过 / `request.ts` 被改拒绝 / 白名单两依赖通过 / 版本不符拒绝 / 删既有键或新增其它依赖拒绝 / lock 有 `-` 行拒绝），在 `M3_TEST_FILE_MAP`(:444) 登记 `'frozen-gate.test.ts': ['M3-GATE-frozen','M4-GATE-frozen']`（**不新增 ID**）；
5. 登记 **D-61**（内容见 §11.2）；
6. 跑 `npm test` + typecheck + layering + **串行 M3/M4** 确认两道 frozen 门仍 PASS；
7. 产出 `docs/M5-4-REPORT.md`（两栏结构，见 §12.1）→ **C1 commit**（此 commit 可先只含门控改造，打包证据待 gate 后补入增量 commit）。

> 若不改门控就跑 N1-2，`package.json` + `pnpm-lock.yaml` 一变 → `M3-GATE-frozen` / `M4-GATE-frozen` 立刻红。

### 阶段 2 · M5-4 打包（N1 联网，甲方已批准国内网）

1. 解坑 A 后跑 `pnpm install` + `pnpm add -D 'electron-builder@^26' 'electron-updater@^6.8' -w`；
2. 显式 `pnpm rebuild electron`，确认 `node_modules/electron/dist/electron.exe` 存在且 `require('electron')` 返回路径（坑 B）；
3. **立刻串行跑 M3、M4 验收**，验证方案 A 白名单判定生效；
4. 编译主进程 `pnpm --filter @ytvdlt/desktop exec tsc -p tsconfig.json` → `apps/desktop/dist`（当前不存在）；核对 `electron-builder.yml` 的 `files` 只含 `apps/desktop/dist/**` + `package.json`、`resources/runtime/**` 走 `extraResources`（**配置已就位，勿改**）；
5. 打包 `pnpm --filter @ytvdlt/desktop exec electron-builder --win --x64`（§6.2-⑦ 可能需开发人员模式/管理员）；
6. 三件套验收：`dist/YTVDLT-Setup-0.1.0.exe`、`dist/YTVDLT-Portable-0.1.0.exe`、`dist/latest.yml`，用 `certutil -hashfile <file> SHA256` 记录（产物不入库）；
7. 便携版数据目录「可写探针 + 回退」（`apps/desktop/src/main/data-dir.ts`：**exe 同目录可写 → 同目录 `config/`；不可写 → `%APPDATA%\YTVDLT`**，探针=写临时文件再删，**不用 `process.cwd()`**），结果写进日志与「关于」框；修 `electron-entry.ts:83/92/93` 三处 `process.cwd()` fixture 路径（§6.2-⑤，走 `process.resourcesPath` 或把 PROBE 换 `engine.probe()`）；
8. 双击安装版跑一次自检 4 项（yt-dlp / node / ffmpeg / aria2c，3 必需项全绿）。

### 阶段 3 · M5-5 双通道更新

- **应用更新**：`electron-updater` + `publish`（provider: generic，URL 指向**本地静态目录**即可做 v1→v2 实测）；`latest.yml` 由 electron-builder 生成；用 `UpdaterPort` 接口 + `AppUpdateCoordinator` 纯协调器 + 依赖注入（**零静态 import**，坑 M），运行时 `configure({provider:'generic',url})`，**不改 yml**。
- **引擎更新**：取 `yt-dlp.exe` + `SHA2-256SUMS` → 校验 → **原子替换**（先写 `.new`、落 `.bak`、再 rename、换后复验）→ 失败回滚 → **更新期间暂停队列**（`pump()` 首行标志位，**非 `cancel()`**，§6.2-⑭）；`SelfUpdater` 用 `try/finally` 保证 `intakeGate.resume()`，失败返回 `changed:false` 不抛 UI。
- **通道**：`stable` / `nightly`；间隔 `weekly`（配置键 `advanced.updateChannel` / `advanced.updateInterval` 已存在）。
- **失败降级**：无网络 → 只写日志 + 一次非阻塞提示，**不弹错误对话框**（A-4.4-29「静默降级」）。
- **本地 L2 实测**（离线可做）：`os.tmpdir()` 下**复制** `resources/runtime/win-x64/yt-dlp.exe` + `SHA2-256SUMS`，用真实 `createNodePorts()` 跑通校验 / 原子替换 / 回滚 / 暂停队列 / 坏值拒绝，断言**原文件 SHA256 前后不变**；证据标「本地 L2、非真机、非在线拉取」，**绝不写原目录**。
- **待 gate 的实测**：v1 → 指向 v2 源 → 手动检查 → 下载/安装/重启 → 版本号变化；「更新中断」能否回滚；引擎更新故意改坏校验值 → 必须拒绝替换且原文件未损坏。
- 新增测试：`self-updater.test.ts` ≥10、`task-queue-intake.test.ts` ≥5、`app-updater.test.ts` ≥6、`engine-update-local.test.ts`；全部登记 `M3_TEST_FILE_MAP`，映射既有白名单 ID。
- 登记 **D-62**，产出 `docs/M5-5-REPORT.md` → **C2 commit**。

### 阶段 4 · M5-6 合规文档 + L3

按 §8 写六份文档 + `docs/M5-6-REPORT.md`。「关于」框作为**已满足项**写进报告栏①（坑 I，**零 UI 改动**）。产物 SHA256 段标「**待 gate**」（未产出 exe 就无法记）。L3 段**原样落**「国际网未放行，L3 先记 SKIPPED，等我另行通知。」；C13–C16 / U7 标 `SKIPPED / 待甲方`。登记 **D-63** → **C3 commit**。

### 阶段 5 · 每块收尾（别省）

- **一块一个 commit + 一份 `docs/M5-x-REPORT.md` + 一条 `DECISIONS`（从 D-61 续号、连续不跳号）**；
- 改完必跑：`npm test` → `pnpm turbo run typecheck` → `node scripts/check-layering.mjs --json` → **串行** `for m in M1 M2 M3 M4 M5; do node scripts/acceptance.mjs --milestone $m; done`（§6.2-② 五套共用 `reports/` / `coverage/` / 端口，**禁并行**；§6.2-③ 验收期间不改源码）；
- 新增测试文件登记 `M3_TEST_FILE_MAP`，新断言 ID 进 `runM3`/`runM4`/`runM5` 的 `knownIds`（§6.2-⑨）；
- `docs/PROJECT-HANDOFF.md` **只读、绝不提交/覆盖**；`reports/` / `coverage/` / `dist/` 不入库。

---

## 11. 三个 commit 的精确清单 + D-61/62/63

统一：精确列文件，`git add` **禁 `-A` / `.` / `-u` / `--amend`**；三者**均不含 `docs/M5-SUMMARY.md`**（坑 F）；排除甲方 `docs/PROJECT-HANDOFF.md`、`reports/`、`coverage/`、`dist/`、`*.exe`、`latest.yml`、`node_modules/`。每个 commit 后 `git show --stat HEAD` 复核，message 用中文 `feat(m5): ...` / `docs(m5): ...`。

**C1 · M5-4（T01+T02）**
```
git add scripts/frozen-gate.mjs scripts/acceptance.mjs \
  tests/unit/frozen-gate.test.ts tests/unit/data-dir.test.ts tests/unit/runtime-paths.test.ts \
  apps/desktop/src/main/data-dir.ts apps/desktop/src/main/runtime-paths.ts \
  apps/desktop/src/main/electron-entry.ts apps/desktop/src/main/m5-host.ts \
  docs/DECISIONS.md docs/M5-4-REPORT.md
```
（未实际修改的文件从清单移除；**不 add** `apps/desktop/electron-builder.yml`、`package.json`、`pnpm-lock.yaml`。N1 产生的 package/lock 改动归 gate 后增量 commit。）

**C2 · M5-5（T03+T04）**
```
git add packages/shared/src/ports.ts packages/shared/src/update.ts packages/shared/src/index.ts \
  packages/core/src/ports.ts packages/core/src/task-queue/task-queue.ts \
  packages/engine-ytdlp/src/self-updater.ts packages/engine-ytdlp/src/yt-dlp-engine.ts \
  packages/engine-ytdlp/src/engine-factory.ts packages/engine-ytdlp/src/index.ts \
  apps/desktop/src/main/app-updater.ts apps/desktop/src/main/adapters/local-dir-update-source.ts \
  apps/desktop/src/main/adapters/queue-intake-gate.ts apps/desktop/src/main/adapters/node-ports.ts \
  apps/desktop/src/main/electron-entry.ts \
  tests/unit/self-updater.test.ts tests/unit/task-queue-intake.test.ts \
  tests/unit/app-updater.test.ts tests/unit/engine-update-local.test.ts \
  scripts/acceptance.mjs docs/DECISIONS.md docs/M5-5-REPORT.md
```
（**不 add** `adapters/electron-updater-adapter.ts`——N1 之前不存在。）

**C3 · M5-6（T05）**
```
git add docs/THIRD_PARTY_NOTICES.md docs/LICENSE-COMPLIANCE.md docs/BUILD.md \
  docs/ACCEPTANCE.md docs/SHORTCUTS.md docs/M5-6-REPORT.md \
  docs/DECISIONS.md README.md
```
（不 add 任何 `packages/ui/src/**`、`messages.js`、二进制产物。）

**决策内容**（仿 D-60 四列表格：决策 / 原因 / 验证 / 影响范围，可加「遗留」行）

| 编号 | 必须写的内容 |
|---|---|
| **D-61** | ① frozen 方案 A 收窄（只硬锁 `request.ts`；package/lock 改「只允许新增依赖声明」显式检查，白名单 `electron-builder@^26.0.0` / `electron-updater@^6.8.0`）；② 打包块偏离合并登记（工具链、`.npmrc` hoist 条件项、无签名手动覆盖安装属**签名限制非功能缺陷**、便携版数据目录探针、fixture 路径修正、`extraResources` 配置只核对未改）；③ **§0.4 差异留痕**：v2.1 记 `151a56e`、实测 `e3c0d84`，按 §0.4 以仓库现状为准并在此登记，**不改写甲方文档**；④ 本轮不执行 N1、package/lock 零改动 |
| **D-62** | ① 双通道实现（generic provider 运行时配置不改 yml / `SelfUpdater` 走 `CorePorts` 的校验→`.new`→`.bak`→rename→复验→回滚）；② 暂停队列 = intake 标志位，不调 `cancel()`；③ 静默降级不弹框；④ **离线 L2（本地真实文件副本、未入库）与 N2 在线拉取分层**，`A-4.4-28`(L3) 维持 SKIPPED；⑤ electron-updater 适配器留 gate 后以保 typecheck 5/5；⑥ `acceptance.mjs:1132` deferred 的「N3」笔误本轮不订正、分类以施工单 §0.1 为准 |
| **D-63** | ① 引用 D-08 写 **LGPL-3.0**、12 条逐条证据或缺失说明、显式登记「LGPL-2.1+ / LGPLv2.1」过时文案差异；② 确认 `messages.js::about.license` 已合规**不订正**（避免 DOM 基线重建）、关于框 UI 留 N1 gate；③ L3 / `A-4.4-28` / `A-4.4-29` / C13–C16 / U7 维持 SKIPPED·待甲方、原样落等待通知语句、`releaseReady=false` 不改写；④ ACCEPTANCE 引用 reports 不手抄；⑤ D-08 只引用**不新增编号** |

**编号验证（四条组合，见 §7 坑 H）**：`grep -c '^## D-'` = **63**；`tail -10` = **D-54…D-63 共 10 条**；**无 D-64**；D-01…D-63 全序列无跳号。每块 commit 后的中间态（61 / 62 / 63 条）`M5-GATE-docs` 均 PASS，但**不能只凭 gate 绿判合规**。

---

## 12. 报告 / 决策 / 状态词写法规范

### 12.1 块报告模板（参考 `docs/M5-3-REPORT.md`）

```
# M5-x 报告 · <标题>
> 日期 YYYY-MM-DD ／ 决策 D-xx ／ 对应断言 A-xxx
## 1. 交付            <- 文件表 + 做了什么
## 2. 验证            <- 必须分两栏：
   【已实测】命令 / 证据路径 / 结果
   【代码就绪 / 待 gate / SKIPPED】项 / 原因 / 解锁条件
## 3. 与 PRD 的偏差
## 4. 未完成
## 5. 结论
```
**两栏是硬要求**：产物 SHA256、真机开窗、v1→v2 实测、L3、C13–C16 一律放第二栏并附原因；**禁止在第一栏写「已完成 / 通过」这类越界结论**。

### 12.2 决策表格模板（D-60 格式）

```
## D-xx · YYYY-MM-DD · <标题>
| 项 | 内容 |
|---|---|
| 决策 | ①… ②… ③… |
| 原因 | … |
| 验证 | 命令 → 结果 |
| 影响范围 | 文件路径列表 |
| 遗留 | 可选 |
```

### 12.3 状态词表

| 词 | 含义 | 能否对外说「完成」 |
|---|---|---|
| `PASS` | 有证据、实测通过 | 可以 |
| `SKIPPED` | 因环境不可用而**未验证**，**不等于通过**，必须给原因 | **不可以** |
| `待 gate` | 代码就绪，但需甲方逐条确认联网命令后才有产物/实测 | 不可以 |
| `待甲方` | 甲方签字项（C13–C16 / U7），AI 不替签 | 不可以 |
| `DEVIATION` | 已登记偏离（如 D-31），单独列出，**不冒充 PASS** | 不可以 |

### 12.4 ACCEPTANCE.md 引用规范

直接引用 `reports/acceptance-report-m5.json`（`allGreen` / `skipped` / `releaseReady` / `assertions`）与 `reports/e2e-summary.json`（`summary` 的 30/30 + 5/5 + `allPass`）字段，**不手抄数字**；注明「本地生成、不入库，需要时在仓库跑命令重生成」（`git ls-files reports/` 只有 `.gitkeep`）。

---

## 13. 验收口径 · DoD · 串行铁律

### 13.1 DoD 七条逐条对照（v2.1 §8）

| # | 条目 | 本轮结束状态 | 交付前还差 |
|---|---|---|---|
| 1 | test + typecheck + layering 全绿 | ✅ **完成**（670/670、5/5、0 违规） | — |
| 2 | M5 九条断言全 PASS | ⚠️ **8 PASS + 2 SKIPPED** | 完成 M5-5 更新逻辑 + 真机验证，把 `A-4.4-28/29` 从 SKIPPED 变 PASS（**须附证据路径**，不在本轮） |
| 3 | 安装版 + 便携版 + SHA256 | ⛔ 未产出 | M5-4 打包（N1） |
| 4 | 干净 VM：安装/便携/卸载（C13–C16） | ⛔ 未开始 | 甲方按 `docs/M5-VM-CHECKLIST.md` 8 步实测 |
| 5 | 主题三态 + 快捷键 + 中英切换实测 | ⚠️ 静态面 ✅（e2e 30 例）；真实窗口未跑 | N1 后开窗点一遍 |
| 6 | NOTICE + LGPL-3.0 十二条 | ⛔ 未开始 | M5-6 文档（按 §8 写「证据或缺失说明」） |
| 7 | L3 PASS 或明确 SKIPPED | ⚠️ **明确 SKIPPED**（无 N3） | N3 放行后补做 |

**只有 1–7 全部成立才能说「M5 交付」；现在只能对外说「离线部分完成、打包与在线未开工」。**

### 13.2 验收铁律

- **五套必须串行**：共用 `reports/vitest-results.json`、`coverage/`、端口与临时目录；并行 = 证据互相覆盖（M4 复现过）。
- **验收运行期间不改源码**：vitest 会读到新旧混合模块，产生假失败（M4 复验时发生过一次）。
- **新增 `<link>` / `<script>` 必改 DOM 基线**：重建前拷 `tests/e2e/baselines`，重建后逐例 **0 容差**像素对比，把「只加了加载点」证明出来。
- **新增测试文件必须登记 `M3_TEST_FILE_MAP`**（`scripts/acceptance.mjs:444`），新断言 ID 进 `runM3`(803) / `runM4`(1055) / `runM5`(1299) 的 `knownIds`。
- **覆盖率**：只测 `packages/core` + `engine-ytdlp`，新加 core 模块必须配测试（门控 70%，当前 ≈86.9%，缓冲约 17 点）。

### 13.3 M5 断言固定 10 条（`acceptance.mjs:1126`）

`A-M5-00` / `A-4.1-02` / `A-4.4-16` / `A-4.4-20` / `A-4.4-21` / **`A-4.4-28`(L3, deferred)** / **`A-4.4-29`(L3, deferred)** / `A-4.5-08` / `A-4.6-06` / `A-4.6-07`。
`A-4.4-28` 的 deferred 原文：`N1/N3：需先装 electron/electron-builder（N1）并下载官方 yt-dlp.exe 与 SHA2-256SUMS（N3），本环境禁止联网，未实现也未声称通过`（其中「N3」是遗留笔误，见坑 K）。
`A-4.4-29` 的 deferred 原文：`N1：electron-updater 与 electron-builder 均未安装，M5-4/M5-5 打包块未开工；不得以 SKIPPED 冒充 PASS`。

### 13.4 验收报告先看三个字段

`reports/acceptance-report-m5.json` → `allGreen` / `skipped` / `releaseReady`。当前 `allGreen=true`、`skipped=2`、**`releaseReady=false`（不得改写）**。

---

## 14. 术语表

| 词 | 含义 |
|---|---|
| **N1 / N2 / N3** | 包管理器网络 / 发布包网络 / 国际站点网络，见 §9.1 |
| **L0 / L1 / L2 / L3** | 测试层级：纯单测 / 录制 fixture 契约 / 本地真实进程 / 真实站点 |
| **C1–C12** | 产物校验 12 项：存在、哈希、容器、可解码、时长、流完整、规格、逐帧、附带产物、续传、历史、无假完成 |
| **C13–C16** | 干净 VM 验收：安装版全流程 / 便携版可运行 / 卸载无残留 / 升级后清理（**甲方签字项**） |
| **U1–U8** | 原始任务书未决项；**U7** = 应用自更新在干净 VM 上的实测；U4 = mp3 编码器可用性 |
| **B1 / B5** | 已知阻塞：B1 = Electron 二进制缺失；B5 = 真实 GUI 从未跑过 |
| **D-xx** | `docs/DECISIONS.md` 决策编号，改约定必须续号（当前 D-60） |
| **SKIPPED** | 因环境不可用而**未验证**，**不等于通过**；报告里必须给原因 |
| **deferred** | `M5_ASSERTIONS` 里标记为延后的断言，验收时输出 `SKIPPED` |
| **DoD** | M5 完成定义，§13.1 的 7 条 |
| **frozen 门控** | `frozenFilesUntouched()`，见 §7 ① / 坑 G |
| **extraResources** | electron-builder 中把外部 exe/DLL 放到 asar 外的机制（asar 内是虚拟路径，无法 spawn） |
| **PROBE** | M3 遗留的 fixture 驱动探测通道；D-31 建议改为 `engine.probe()` |
| **asar** | Electron 归档格式；内部文件是虚拟路径，**不能 spawn** |
| **LGPL-3.0** | 随包 FFmpeg 实际许可证（D-08），不是 LGPL-2.1+ |
| **A-4.4-28 / 29** | 引擎更新 / 应用自更新两条 L3 断言，当前 SKIPPED |

---

## 15. 文件地图（要改哪里）

| 要做的事 | 文件 |
|---|---|
| 打包配置（NSIS / portable / extraResources）**只核对不改** | `apps/desktop/electron-builder.yml` |
| 主进程入口（窗口/托盘/单实例/数据目录/fixture 路径） | `apps/desktop/src/main/{bootstrap,electron-entry,runtime-paths,m5-host}.ts`，新增 `data-dir.ts` |
| 更新模块（应用/引擎/协调器/适配器） | `apps/desktop/src/main/app-updater.ts`、`adapters/{local-dir-update-source,queue-intake-gate,node-ports}.ts`、`packages/engine-ytdlp/src/self-updater.ts`、`packages/shared/src/update.ts` |
| 队列暂停标志位 | `packages/core/src/ports.ts`（`ITaskQueue`）、`packages/core/src/task-queue/task-queue.ts`（`pump()`） |
| IPC 通道与校验 | `apps/desktop/src/main/{m5-channels,m5-host}.ts`、`packages/shared/src/ipc.ts` |
| 运行时随包资源（**不入 asar**） | `resources/runtime/win-x64/**` |
| 验收与门控 | `scripts/acceptance.mjs`（`frozenFilesUntouched` / `M3_TEST_FILE_MAP` / `knownIds` / `M5_ASSERTIONS`）、新增 `scripts/frozen-gate.mjs` |
| 截图套装 | `scripts/{run-e2e,e2e-cases}.mjs`、`tests/e2e/baselines/**` |
| 文案（zh/en）**本轮不改** | `packages/ui/src/i18n/messages.js` |
| 外观 / 快捷键 / 视图策略 | `packages/core/src/{appearance,shortcuts,task-view,crash,platform}/**` |
| 决策台账 | `docs/DECISIONS.md`（续号 D-61） |
| 块报告模板 | `docs/M5-0-REPORT.md` … `docs/M5-3-REPORT.md` |
| 合规文档（全新增） | `docs/{THIRD_PARTY_NOTICES,LICENSE-COMPLIANCE,BUILD,ACCEPTANCE,SHORTCUTS}.md`、根 `README.md` |
| **甲方文件（只读）** | `docs/PROJECT-HANDOFF.md` |
| **本轮状态入口** | `docs/M5-HANDOFF-V3.md`（本文） |

---

## 16. 团队与工具链状态（本轮教训）

### 16.1 六个 worker 状态（**不要恢复**）

| name | 角色 | 本轮产出 | 状态 |
|---|---|---|---|
| `software-product-manager` | PM | PRD v1.2（staging） | paused / alive，**已完成** |
| `software-architect` | 架构师 | 设计 v1.4（staging） | paused / alive，**已完成** |
| `software-qa-engineer` | QA | 合规事实表 + 审计前基线快照 | paused / alive，第一阶段完成、第二阶段未启动 |
| `software-engineer` | 工程师 | **零产出** | 已停止（18m31s） |
| `software-engineer-2` | 工程师 | **零产出** | 已停止（5m42s） |
| `m5-impl` | 通用执行 | **零产出** | 已停止（2m28s） |

### 16.2 根因与验证

- 专家角色 `software-engineer.md` 第 41 行写死「使用 `write_to_file` 调用」，当前会话工具是 `Write` / `Edit` / `Bash`；worker 一直在找不存在的工具，且角色模板还强制「ALL-AT-ONCE / Vite+React 脚手架」，与既有 TS monorepo 不匹配。
- **同步子代理探针（不带 `name` 的 foreground `Agent`）实测**：`Bash` 写 `reports/_fg_probe.txt` + `cat` + `rm` → `Exit Code: 0`；`Write` 创建 `scripts/_fg_write_probe.txt` → 成功；`git status --short` → 正常。证明**工具与项目目录写权限都没问题**，问题只在异步 teammate 调度。
- 交接时 **不要**恢复上述 paused worker；实现请用同步子代理或主理人自己动手。

### 16.3 给下一棒的协作建议

1. 不要在「离线已绿」的前提下再拆「离线预实现」——那是本轮两小时空转的根源；
2. 一次只做一块（C1 → C2 → C3），每块 commit 后立刻复核 `git show --stat HEAD`；
3. 设计文档够用即可，**一个 commit 比十页设计更有价值**；
4. 若必须用团队，用同步子代理并明确工具名（`Write` / `Edit` / `Bash`）。

---

## 17. 命令速查表

```bash
# 交接自查
node scripts/handoff-check.mjs
git status --short
git log --oneline -- apps packages scripts tests | head -3
grep '^## D-' docs/DECISIONS.md | tail -10
grep -c '^## D-' docs/DECISIONS.md

# 三件套
npm test
pnpm turbo run typecheck
node scripts/check-layering.mjs --json

# 串行五套验收（禁并行，期间不改源码）
for m in M1 M2 M3 M4 M5; do node scripts/acceptance.mjs --milestone $m; done

# 单文件调试 / 单用例截图
node node_modules/vitest/vitest.mjs run tests/unit/<file>.test.ts --reporter=verbose
node scripts/run-e2e.mjs --case=queue-ready

# N1（须先报备）
pnpm install
pnpm rebuild electron                       # 坑 B：显式补二进制
node -e "console.log(require('electron'))"
pnpm add -D 'electron-builder@^26' 'electron-updater@^6.8' -w
pnpm --filter @ytvdlt/desktop exec tsc -p tsconfig.json
pnpm --filter @ytvdlt/desktop exec electron-builder --win --x64
certutil -hashfile dist/YTVDLT-Setup-0.1.0.exe SHA256
certutil -hashfile dist/YTVDLT-Portable-0.1.0.exe SHA256

# 决策编号四条组合（禁用 tail -12）
grep -c '^## D-' docs/DECISIONS.md
grep '^## D-' docs/DECISIONS.md | tail -10
grep '^## D-64' docs/DECISIONS.md

# 看报告关键字段
node -e "const r=require('./reports/acceptance-report-m5.json'); console.log(r.allGreen, r.skipped, r.releaseReady)"
```

---

## 18. 30 秒自查 / 常见误判

**这份文档是否过期**：跑 `node scripts/handoff-check.mjs`，把输出与 §3.2 六项逐项对照；不一致 → 以仓库现状为准，并把差异补进 `DECISIONS.md`。

| 常见误判 | 正确结论 |
|---|---|
| 「离线部分还没做完」 | **早已做完**（M5-0…M5-3 + 基线全绿），不要再重做 |
| 「SKIPPED 可以当 PASS 用」 | **绝对不行**，SKIPPED 是未验证，必须给原因 |
| 「本地有 yt-dlp.exe，所以 clone 后也能跑」 | 二进制**被 .gitignore 忽略、未入库**，仅本机成立 |
| 「FFmpeg 是 LGPL-2.1+」 | 实际 **LGPL-3.0**（D-08），任务书旧文案过时 |
| 「12 条合规都已履行」 | **5 条完全缺失、4 条部分、3 条可引用**，只能写「证据或缺失说明」 |
| 「装依赖后 frozen 门控红了，改报告口径就行」 | 会污染 M3/M4 历史结论；正解是**方案 A 收窄门控 + D-61 留痕** |
| 「改 `M5-SUMMARY.md` 更新一下状态」 | 双重门控会红；**核对不改**，新状态写进三份新报告 |
| 「给 `M5_ASSERTIONS` 加两条更新断言」 | 固定 10 条，新增 ID 会破坏门控；新测试映射既有白名单 ID |
| 「`M5-GATE-docs: PASS` 就说明编号合规」 | 脚本不禁止 D-64，须独立跑四条组合判据 |
| 「L2 实测全绿就能把 A-4.4-28 改 PASS」 | L2 ≠ L3 ≠ PASS，维持 SKIPPED |
| 「`pnpm install` 成功 = Electron 能用了」 | 可能 `Already up to date` 跳过 postinstall，须显式 `pnpm rebuild electron` 并验二进制 |
| 「`pnpm add` 失败是网络不通」 | 本轮是 **`safe-delete` 保护拦截**（坑 A），与网络无关 |
| 「`pnpm add` 失败就是什么都没改」 | **错**：`pnpm-lock.yaml` 已 +1944/−38 行，`package.json` 未改，还有 0 字节临时文件残留；见 §2.4 |
| 「门控改成方案 A 就能过」 | 草稿 R3「任何 `-` 行即 FAIL」会被 peer 后缀重写的 37 条 `-` 行打红，须按 §2.4.2 细化 |
| 「`_tmp_2992_...` 是个临时目录」 | 是 **0 字节普通文件**；清理时单独删这一个，不要 `rm -rf` / 通配符 |

---

## 19. 停止声明

**本轮未产出任何可交付代码、commit 或块报告；M5 离线四块（M5-0…M5-3）在 v2.1 之前已完成且本轮复核全绿；M5-4 打包 / M5-5 双通道更新 / M5-6 合规文档与 L3 均未开工。N1-1 已执行但未补到 Electron 二进制；N1-2 因本机 `safe-delete` 保护拦截失败，且留下「`pnpm-lock.yaml` 已写 +1944/−38 行、`package.json` 未写、0 字节临时文件残留」的半截状态（§2.4）——下一棒必须先按 §2.4.3 回滚或补齐。国内网已由甲方批准，国际网未放行，L3 记 SKIPPED。下一棒按本文 §0.4 / §10 从「先处理半截状态 + 改 frozen 门控」开始，不要重做离线部分，也不要恢复本轮已暂停的 6 个团队 worker。未获甲方对每条联网命令的明确确认，不执行任何联网命令；不对外声称「成品可安装、可下载」。**
