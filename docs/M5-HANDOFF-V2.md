# YTVDLT · M5 交接包 v2.2（离线已完成，剩打包 / 更新 / 在线三段）

> ## ⛔ 接手第一件事：只看这一段
>
> **离线部分 100% 完成，不要重做、不要"先把能离线写的先写掉"。**
> 你只被允许做三件事：① 用 `node scripts/handoff-check.mjs` 核对现状；② 向甲方要网络放行（§0.1）；③ 放行后按 §5 从 **M5-4 打包** 一路往下做。
> **不要组队/开多角色 worker；不要写 PRD、架构、合规初稿；不要在没有 `electron` 二进制时写"更新逻辑占位代码"；未放行前不要改仓库任何文件。**
> 若你发现自己在做 §5 以外的事 —— 停下，回到这一行。

> **这份文档解决什么问题**：M5 的离线四块已做完并全绿，剩下三块（打包、双通道更新、合规文档+L3）卡在网络上。本文是给下一棒的**自包含施工单**：能开工吗 → 要放行什么 → 按什么顺序做 → 哪些坑必须绕。
> **怎么读**：只想拍板 → §0.1（网络）；只想看进度 → §1；要动手 → §5；怕踩坑 → §6；第一次上手 → §7。
> 版本 v2.2 ／ 2026-11-06 23:4x（v2.2 变更：顶部加硬停框、新增 §4.1 禁止事项、修掉「不放行可做文档与纯逻辑」这句误导） ／ 取代 `docs/M5-HANDOFF.md` v1.2（v1 是"开工前"的背景包，v2 是"离线做完之后"的施工包）。
> 权威优先级（冲突时以靠前者为准，并在 `DECISIONS.md` 留痕）：
> 原始任务书 `C:/Users/leolee/WorkBuddy/2026-11-05-07-24-49/YTVDLT_HANDOFF.md`（933 行，唯一权威）
> > `docs/PROJECT-HANDOFF.md`（甲方副本，**有甲方本地改动，不要提交/覆盖**）
> > `PRD-M1/M3` > `ARCHITECTURE-M2/M3` > `DECISIONS.md`（D-01…**D-60**）> 本文。
> 环境：Windows 10 22631 ／ Node **22.22.2** ／ pnpm **9.15.9** ／ npm 10.9.7 ／ 无 Electron 二进制 ／ 当前离线。

**目录**

| § | 内容 |
|---|---|
| 0 | 只看三件事：网络放行 / 甲方要做什么 / 只发这一个文件够不够 |
| 1 | 现状与验收口径（数字） |
| 2 | 已交付（M5-0…M5-3 + 两条断言） |
| 3 | 没做什么（逐项原因，别误以为做了） |
| 4 | 开工前必须先做的三件判断 |
| 5 | 剩余施工单：M5-4 打包 / M5-5 更新 / M5-6 合规+L3 |
| 6 | 排雷：本轮已修 9 条 + 下一棒必踩 17 条 |
| 7 | 第一小时（命令级） |
| 8 | DoD 逐条对照（现在 vs 交付） |
| 9 | 术语表（N1/N2/N3、L0–L3、C1–C12、C13–C16、U7、B1/B5） |
| 10 | 文件地图（要改哪里） |
| 11 | 停止声明 |

---

## 0. 只看三件事

### 0.1 你要放行哪类网络（**国内网 vs 国际网**）

> 硬规矩（沿用 v1 §0.1）：**任何联网步骤先停下来问甲方**，说清「哪一类 / 什么命令 / 多久 / 失败会怎样」，得到明确同意再动。不许静默重试、不许擅自换代理、不许假设"应该能连"。

| 放行类别 | 用来做什么 | 具体命令 / 地址 | 体量·耗时 | 不放行的后果 | 只放这个够吗 |
|---|---|---|---|---|---|
| **国内网络**（N1 装依赖） | 补 Electron 二进制、装打包与更新库 | ① `pnpm install`（补 `electron@45.2.2`，约 100–120 MB）② `pnpm add -D electron-builder@^26 electron-updater@^6.8 -w`（约 150–250 MB） | 5–20 分钟 | **打包与更新完全做不了**，M5-4/M5-5 一步都动不了 | 够做 M5-4 打包 + M5-5 的代码与本地更新实测 |
| **国内网络**（N2 下发布包） | 取真实 `yt-dlp.exe` 与校验清单，做引擎更新实测 | `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe` 与 `SHA2-256SUMS`（GitHub 慢可走国内镜像/代理） | 约 17–20 MB，秒级；Electron 预编译包另约 100 MB | 引擎更新只能拿假文件测，**不能声称实测通过** | 与 N1 合并放行最省事 |
| **国际网络**（N3 访问 YouTube） | L3 在线烟测：真实下载 + C1–C12 | 一个**甲方有权保存**的公开视频（建议 Blender 开放电影） | 3–10 分钟 | 只能记 `SKIPPED`，**不得**写 PASS，也不得对外说"YouTube 能下" | 只补 L3，不影响打包 |

> **一句话**：**打包和引擎更新只要"国内网"；只有 L3 在线烟测必须"国际网"。**
> 若只能开一个 → **先开国内网**（能拿到安装包与更新功能），L3 继续记 `SKIPPED`。

**按放行组合能走到哪一步：**

| 放行了什么 | 能完成的 DoD 条目 | 仍然缺 |
|---|---|---|
| 只国内网 | 1、3、5（真机）、6 | 2 的 L3 部分、7（L3） |
| 国内 + 国际 | 1–7 全部（2 需先做完 M5-5） | — |
| 都不放行 | **不得动手**：离线部分已完成，重复做只会白跑（当前状态） | 3、4、6、7 全部 |

### 0.2 甲方（你）要做的三件事

1. **放行网络**：按 §0.1 选组合，明确说"已放行国内网 / 已放行国际网"。AI 收到后才会发起任何下载。
2. **VM 实测（C13–C16）**：安装/便携/卸载/更新四段，按 `docs/M5-VM-CHECKLIST.md` 的 8 步填勾选表。**AI 不能替你签字**。
3. **验收口径确认**：`A-4.4-28` / `A-4.4-29` 现在记 `SKIPPED`；真机跑通后由实测结果改成 PASS。改判必须附证据路径。

### 0.3 只发这一个文件够不够？

**够。** 本文是自包含的：现状、数字、命令、路径、坑、验收口径都在里面，不需要翻聊天记录。

| 文件 | 发不发 | 说明 |
|---|---|---|
| `docs/M5-HANDOFF-V2.md`（本文） | **必发** | 唯一入口 |
| `docs/M5-VM-CHECKLIST.md` | **建议附上**（仅当甲方要做 VM 实测） | 8 步勾选表，打印/照填即可 |
| `docs/M5-SUMMARY.md` | 可选 | DoD 逐条对照的"人话版"，内容与本文 §8 重叠 |
| `docs/DECISIONS.md` | 可选 | 只在他要改约定（续号 D-61）时发 |
| `docs/PROJECT-HANDOFF.md` | **不要发** | 甲方本地改动未入库，发出去会造成版本歧义 |
| `reports/*.json` | **不要发** | `.gitignore` 忽略，属本地生成证据；需要时在仓库里跑命令重生成 |

> 判断标准：对方只要能"按 §5 施工 + 按 §6 避坑"，一个文件就够；要动手改代码时，仓库本身就是上下文。

### 0.4 30 秒自查：这份文档是否过期

> 一条命令：`node scripts/handoff-check.mjs` → 打印「代码最后提交 / 决策编号 / 用例数 / M5 验收 / E2E / 覆盖率」六项现状，并标出证据是否早于代码（`STALE`）。把输出与下表逐项对照，不一致就说明本文过期。

| 校验点 | 本文写下的值 | 怎么查 |
|---|---|---|
| 最后一次**代码**提交 | `151a56e`（排雷修复）；此前功能提交 `119bc44` | `git log --oneline -- apps packages scripts tests \| head -3`（文档提交会继续叠加，只看代码路径才不会误判） |
| 单测 | 53 files / 670 passed | `npm test`（口径：unit+contract；验收内部 vitest 是 676，别混用） |
| 截图 | 30 用例 + 5 反例 | `node scripts/run-e2e.mjs` |
| M5 验收 | 8 PASS + 2 SKIPPED，10/10 门控 | `node scripts/acceptance.mjs --milestone M5` |
| 决策编号 | 已到 **D-60**，下一棒从 **D-61** 起 | `grep '^## D-' docs/DECISIONS.md \| tail -1` |

任一项不符 → 本文已落后于仓库，**以仓库现状为准**，并把差异补进 `DECISIONS.md`。

---

## 1. 现状与验收口径

| 项 | 值 |
|---|---|
| 项目根 | `C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\ytvdlt` |
| 已完成 | **M1–M4 全部**；**M5 离线四块**（M5-0 IPC 表面 / M5-1 主题 / M5-2 快捷键+i18n / M5-3 空错状态+基线） |
| 未完成 | **M5-4 打包**、**M5-5 双通道更新**、**M5-6 合规文档 + L3** |
| 单测 | `npm test` → **53 files / 670 passed**（M4 收尾时 44 / 583；本轮 +9 文件 / +87 例） |
| 覆盖率 | 四维最低 **≈86.9%**（门控 70%，缓冲约 17 个点；随运行浮动 ±0.1） |
| 类型检查 | `pnpm turbo run typecheck` → **5/5** |
| 分层铁律 | `node scripts/check-layering.mjs --json` → **violationsCount = 0** |
| 截图 | `node scripts/run-e2e.mjs` → **30/30 用例 + 5/5 反例**，`allPass=true` |
| M5 验收 | `node scripts/acceptance.mjs --milestone M5` → **8 PASS + 2 SKIPPED，10/10 门控**，`allGreen=true`、`releaseReady=false` |
| M1–M4 回归 | 17/17 + 5/5 ／ 37/37 + 5/5 ／ 48/48 + 12/12 + 4/4 ／ 9/9 + 10/10 + 4/4，四套 `allGreen=true` |
| 两条 SKIPPED | `A-4.4-28` 引擎更新（N1+N3）、`A-4.4-29` 应用自更新（N1）——**没有写成 PASS** |

> 口径提醒：`npm test` 的 670 与验收内部 vitest 的 676 是两套口径（后者含 5 个 L2 integration + 1 个额外用例），**不要混着引用**。

---

## 2. 已交付（带证据，可直接复核）

### 2.1 M5-0 生产 IPC 表面与装配

| 文件 | 作用 |
|---|---|
| `packages/shared/src/ipc.ts` | 追加 8 个通道常量：`TASK_LIST` / `TASK_DETAIL` / `TASK_ACTION` / `TEMPLATE_LIST` / `TEMPLATE_SAVE` / `TEMPLATE_DELETE` / `SETTINGS_GET` / `SETTINGS_SET` |
| `apps/desktop/src/main/m5-channels.ts` | 8 个 handler + 载荷白名单；列表 DTO **无 `url`**；详情 URL 走 `maskUrlSecrets()`；模板写入仍过正向白名单；设置写 ConfigStore（accent 已校验） |
| `apps/desktop/src/main/m5-host.ts` | `createM5Host()` = M4 host + 8 通道 + `mergeGateways()`（重复通道抛错）+ `appearance()` |
| `apps/desktop/src/main/bootstrap.ts` | 单实例锁、`ipcMain.handle` 注册、加固窗口（`contextIsolation`/`nodeIntegration:false`/`sandbox`）、托盘、关窗最小化（**无托盘时不隐藏**）、`--url`→`?prefill=`、系统主题监听 |
| `apps/desktop/src/main/electron-entry.ts` | 唯一 import `electron` 的装配点：ports→logger→mapper→verifier→engine→`createM5Host`→`bootstrap`。**只通过类型检查，从未运行** |
| `apps/desktop/src/main/index.ts` | 追加导出 `bootstrap` / `createM5Host` / `M5_CHANNELS` |

证据：`tests/unit/m5-channels.test.ts` 14 例、`m5-host.test.ts` 7 例、`bootstrap.test.ts` 7 例。

### 2.2 M5-1 主题三态

- 策略：`packages/core/src/appearance/appearance.ts`（三态、强调色优先级、WCAG、减少动效、触觉省略）。
- 颜色：`packages/ui/src/styles/theme.css` 是唯一色源（浅色仍在 `ytvdlt.css`，冻结）。
- 应用：`packages/ui/src/theme/theme.js` 只写 `<html data-theme/data-accent/data-motion>`；**默认状态不写任何属性**。
- 证据：`appearance.test.ts` 17 例（从 CSS 反解对比度，5 预设 × 2 主题 × 2 表面全部 ≥4.5:1）；e2e `format-dark` / `queue-dark` / `settings-en-dark`。
- **关键回归证据：14 张 M3 中文截图重建后 `differPixels = 0`，DOM 每例仅 +6 行（1 个 `link` + 5 个 `script`）。**

### 2.3 M5-2 快捷键 + i18n

- 权威表：`packages/core/src/shortcuts/shortcuts.ts`（14 绑定；`Ctrl`→`Cmd`（macOS）；输入框聚焦不劫持；`Ctrl+Shift+V` 全局例外；冲突检测；`--url` 深链）。
- 镜像：`packages/ui/src/shortcuts/shortcuts.js`，**测试解析该文件与 core 逐字段比对**（防漂移）。
- 字典：`packages/ui/src/i18n/messages.js`（两语言键集合一致、占位符同名）；M3 弹窗用短语表运行时替换（HTML 冻结）。
- 证据：`shortcuts.test.ts` 12 例、`i18n.test.ts` 11 例；e2e `format-en` / `queue-en` / `settings-en-dark` 断言 `data-i18n-missing="0"`、`data-text-overflow="0"`。

### 2.4 M5-3 空/错状态 + 队列主页

- 新页面 `packages/ui/src/pages/queue/index.html` + `queue.js`：四 Tab（带计数）、搜索、卡片（进度/速度/ETA/动作）、粘贴框、空态引导、错误重试。
- 四个页面同构状态块：队列 / 详情 / 日志 / 批量入队。
- 证据：`task-view.test.ts` 8 例；e2e 30 例（新增 16 例）。

### 2.5 顺手补的两条断言

- `A-4.5-08` 崩溃守卫：`packages/core/src/crash/crash-guard.ts`（报告含版本/OS、不吞异常、pending→ack 改名不删除、同毫秒冲突改名）。
- `A-4.6-07` 桌面平台策略：`packages/core/src/platform/platform-policy.ts`（HKCU Run 自启、无需管理员；Android 残留扫描对真实 `packages/ui/src` **0 命中**）。

---

## 3. 没做什么（别误以为做了）

| 项 | 状态 | 原因 |
|---|---|---|
| `YTVDLT-Setup-<ver>.exe` / `YTVDLT-Portable-<ver>.exe` | 未产出 | electron / electron-builder 未安装（N1） |
| 真实窗口、托盘图标、通知点击聚焦 | 未验证 | 无 Electron 二进制（B1/D-39） |
| `electron-entry.ts` 首跑 | 未运行 | 同上 |
| 双通道自动更新（`electron-updater` + `latest.yml`） | 未实现 | 依赖未装（N1） |
| 引擎更新（SHA2-256SUMS + 原子替换 + 回滚 + 暂停队列） | 未实现 | N1 + 需真实 `yt-dlp.exe`（N2） |
| NOTICE / LICENSE-COMPLIANCE / LGPL 12 条逐条 | 未写 | 属 M5-6 |
| L3 在线烟测、产物 SHA256 | 未做 | 无国际出口（N3），记 `SKIPPED` |
| 系统强调色读取（注册表/DWM） | 返回 `null` | 需 N1 后接 `DwmGetColorizationColor`，当前回落预设 |
| 弹窗 i18n 动态拼接串（如 `'条目 #' + n`） | 仍中文 | 保 M3 基线，见 `M5-2-REPORT.md` §4 |

---

## 4. 开工前必须先做的三件判断

1. **网络**：按 §0.1 问甲方要"国内"还是"国际"。**没有国内网就完全无法打包**；没有国际网只影响 L3。
2. **冻结门控冲突**（本阶段最大的雷，先读 §6.2-①）：装依赖会改 `package.json` / `pnpm-lock.yaml`，而 M3/M4 的 `frozen` 门控当前要求这两个文件对 HEAD **零改动**。必须先改门控口径并登记 `DECISIONS`（预计 D-61），否则 M3/M4 验收立刻变红。
3. **别动甲方文件**：`docs/PROJECT-HANDOFF.md` 一直是 `M` 状态，是甲方自己的改动，**不要提交、不要覆盖**。

### 4.1 禁止事项（违反任何一条 = 这一小时白跑）

| 禁止 | 为什么 |
|---|---|
| ❌ 重做 M5-0…M5-3（主题/i18n/队列页/IPC） | 已完成并有 670 例测试 + 30 例截图兜底；重做只会做出第二套实现 |
| ❌ "先把能离线写的代码写掉"（更新逻辑、打包脚本占位） | 没有 `electron`/`electron-updater` 时写的逻辑无法验证，等于凭空造 API，后面大概率推翻重写 |
| ❌ 组队 / 开 3 个以上 worker 并行 | 本任务是**单线程串行**施工；多角色会把时间花在交接与查工具上（已发生过：worker 卡在不存在的工具名上，零产出） |
| ❌ 新写 PRD / 架构 / 合规初稿 | `PRD-M1/M3`、`ARCHITECTURE-M2/M3` 已存在且是权威；写第二份只会制造冲突 |
| ❌ 未放行就改 `package.json` / `pnpm-lock.yaml` | 直接打红 `M3/M4-GATE-frozen`，且装不上依赖 |
| ❌ 工具不可用时反复重试同一工具 | 立即降级：用 shell / 直接改文件，别把一小时耗在工具名上 |

---

## 5. 剩余工作施工单

> **前置铁律**：以下每一步都以 **N1/N2 已放行**为前提。未放行前**一行代码都不要改**（改 `package.json` 会打红 frozen 门控，见 §6.2-①，而且没有任何可验证产出）。
> 顺序固定：**M5-4 → M5-5 → M5-6**。不要跳步，不要"并行把三块一起铺开"。

### 5.1 M5-4 打包（前置：N1）

1. `pnpm install` → 确认 `node_modules/electron/dist/electron.exe` 存在；`node -e "console.log(require('electron'))"` 返回路径。
2. `pnpm add -D electron-builder@^26 electron-updater@^6.8 -w`（版本已登记在 `package.json → ytvdltPlannedDependencies`）。
3. **先改 frozen 门控**（§6.2-①），再继续。
4. 编译主进程：`pnpm --filter @ytvdlt/desktop exec tsc -p tsconfig.json` → 生成 `apps/desktop/dist`（当前不存在）；确认 `electron-builder.yml` 的 `files` 只含 `apps/desktop/dist/**` 与 `package.json`，**`resources/runtime/**` 必须走 `extraResources`**（配置已就位，勿改）。
5. 打包：`pnpm --filter @ytvdlt/desktop exec electron-builder --win --x64`（首次下 NSIS / winCodeSign，**可能要符号链接权限**：开"开发人员模式"或以管理员跑一次）。
6. 三件套验收：`dist/YTVDLT-Setup-0.1.0.exe`、`dist/YTVDLT-Portable-0.1.0.exe`、`dist/latest.yml`；记录 SHA256（`certutil -hashfile <file> SHA256`）。
7. 便携版配置目录：**不要用 `process.cwd()`**。规则「exe 同目录可写 → 写同目录 `config/`；不可写 → `%APPDATA%\YTVDLT`」，探针用"写临时文件再删"实现，并把结果写进日志与「关于」框。
8. 双击安装版跑一次：自检 4 项（yt-dlp / node / ffmpeg / aria2c），3 必需项全绿。

### 5.2 M5-5 双通道更新（前置：N1/N2）

1. 应用更新：`electron-updater` + `publish`（provider: generic，URL 指向本地静态目录即可做 v1→v2 实测）；`latest.yml` 由 electron-builder 生成。
2. 引擎更新：取 `yt-dlp.exe` + `SHA2-256SUMS` → 校验 → **原子替换**（先写 `.new` 再 rename）→ 失败回滚 → **更新期间暂停队列**。
3. 通道：`stable` / `nightly`；间隔 `weekly`（配置键已存在：`advanced.updateChannel` / `advanced.updateInterval`）。
4. 失败降级：无网络 → 只写日志 + 一次非阻塞提示，**不弹错误对话框**（A-4.4-29「静默降级」）。
5. 验收：v1 → 指向 v2 源 → 手动检查 → 下载/安装/重启 → 版本号变化；再测"更新中断"能否回滚；引擎更新时故意改坏校验值 → 必须拒绝替换且原文件未损坏。

### 5.3 M5-6 合规文档 + L3（前置：N3 仅 L3 部分）

1. `THIRD_PARTY_NOTICES.md`：覆盖 §6.7 全部组件；FFmpeg 是 **LGPL-3.0**（不是 2.1+，D-08），12 条逐条给证据；`resources/runtime/win-x64/FFMPEG-LICENSE.txt` 已在仓库。
2. `LICENSE-COMPLIANCE.md`、`BUILD.md`、`README.md`、`ACCEPTANCE.md`、`SHORTCUTS.md`：`ACCEPTANCE` 直接引用 `reports/acceptance-report-m5.json` 与 `e2e-summary.json`，**不要手抄数字**。
3. 「关于」框：版本、运行时三件套、LGPL 声明、触觉省略说明（文案已在 `messages.js → about.*`）。
4. L3：选一个甲方有权保存的公开视频，真实下载 + C1–C12；**网络不可达 → `SKIPPED` + 原因，绝不写 PASS**。
5. 产物 SHA256 与归档：两个 exe + `latest.yml` 一起记进报告。

### 5.4 每块的收尾动作（别省）

- 一个块一个 commit + `docs/M5-x-REPORT.md` + 一条 `DECISIONS`（**从 D-61 续号**）。
- 改完必跑：`npm test` → `pnpm turbo run typecheck` → `node scripts/check-layering.mjs --json` → **串行** `node scripts/acceptance.mjs --milestone M1..M5`。
- 新增测试文件必须同时登记 `M3_TEST_FILE_MAP`，并把新断言 ID 加进 `runM3`/`runM4`/`runM5` 的 `knownIds`（§6.2-⑨）。

---

## 6. 排雷清单

### 6.1 本轮已排掉并修复（9 条，"看起来绿但真错"）

| # | 雷 | 现象 | 修法 |
|---|---|---|---|
| 1 | **i18n 覆盖子树** | 英文模式 Tab 计数消失（`textContent = 'All'` 把 `<span class="n">6</span>` 一起抹了） | 只替换首个文本节点，保留子元素 |
| 2 | **i18n 覆盖占位符模板** | 顶栏显示字面量 `Running {active}/{limit}` | 模板含 `{x}` 且页面已渲染 → 跳过，由页面 `t(key, params)` 负责 |
| 3 | **深链把 URL 写进 DOM** | `data-prefilled="https://…?token=…"` 把签名链接留在快照/日志 | 只写 `data-prefilled="true"` + `data-prefill-host`，并加反例断言 |
| 4 | **无托盘时关窗即失联** | 托盘创建失败仍走"关窗最小化"，窗口隐藏后无入口 | `trayReady` 门控：只有托盘建起来才隐藏 |
| 5 | **设置可写入垃圾强调色** | `SETTINGS_SET` 只校验 `typeof string` | 预设 / `system` / 合法 hex 校验，非法抛错 |
| 6 | 硬编码通道名 | `dispatch('ytvdlt:settings:get')` 与常量重复 | 改用 `IPC_CHANNELS.SETTINGS_GET` |
| 7 | e2e 断言假设属性顺序 | `id="log-lines" hidden="true"` 匹配不到 | 统一 `id="x"[^>]*hidden="true"` |
| 8 | 输入框 focus 让截图抖动 | `queue-prefill` 反复差 15 px（光标闪烁） | 加 `?focus=0`，`prefill()` 支持 `focus:false` |
| 9 | 空 `<pre>` 让写回检查失败 | 新页面 `#ytvdlt-output` 为空 → 写回断言 FAIL | 初始内容写 `{}` |

> 共同点：**门控全绿 ≠ 真没问题**。这 9 条都是"测试通过但用户会看见/会遇到"的错，靠人工看截图与读代码才发现。

### 6.2 下一棒一定会踩（按杀伤力排序）

**① 装依赖会直接打红 M3/M4 的 frozen 门控（必踩，先处理）**

`scripts/acceptance.mjs → frozenFilesUntouched()` 现在要求下面这条命令输出为空：

```js
git diff HEAD -- packages/shared/src/request.ts pnpm-lock.yaml package.json
```

而 M5-4 必然新增 `electron-builder` / `electron-updater` → `package.json` 与 `pnpm-lock.yaml` 都变 → `M3-GATE-frozen`、`M4-GATE-frozen`（以及 M5 的 frozen 检查）立刻红。

三种处理，推荐 A 并登记 `DECISIONS`（预计 D-61）：
- **A. 收窄门控**：只锁 `packages/shared/src/request.ts`（D-50 真正冻结的对象）；`package.json`/lock 改成"只允许新增依赖声明"的显式检查。
- B. 把打包依赖放进独立 `apps/desktop/package.json` —— workspace 仍会改 lock，**绕不过去**。
- C. 接受门控变红并改写报告口径 —— 不推荐，会污染 M3/M4 的历史结论。

**② 验收必须串行**：五套验收共用 `reports/vitest-results.json`、`coverage/`、端口与临时目录。并行 = 证据互相覆盖，结果不可信（M4 复现过）。

**③ 验收运行期间不要改源码**：vitest 会读到新旧混合模块，产生假失败（M4 复验时发生过一次）。

**④ 新增 `<link>`/`<script>` 必改 DOM 基线**：重建前先把 `tests/e2e/baselines` 拷一份，重建后逐例做 **0 容差**像素对比，把"只加了加载点"证明出来，否则等于把回归证据扔了。

**⑤ 打包后 `process.cwd()` 不可靠**：`electron-entry.ts` 里 `tests/fixtures/*.json` 用的是 `join(process.cwd(), 'tests','fixtures')`，**打包后不存在**。要么把 fixture 放进 `extraResources` 走 `process.resourcesPath`，要么把 M3 的 `PROBE` 换成 `engine.probe()`（D-31 遗留）。

**⑥ asar 里不能 spawn**：`resources/runtime/**` 绝对不能进 `files`；`electron-builder.yml` 已配好，改配置时别"顺手"加 glob。

**⑦ NSIS 首次构建要符号链接权限**：下载 winCodeSign 会解压符号链接，普通账户报 `EBUSY`/权限错误。开"开发人员模式"或以管理员跑一次（不影响 per-user 安装属性）。

**⑧ 便携版数据目录**：便携版 `app.getPath('appData')` 仍指向 `%APPDATA%`，**不等于 exe 同目录**。必须自己实现"可写探针 + 回退"，并写进日志与「关于」框，否则验收无法证明配置落在哪。

**⑨ 新增测试文件不登记 = 门控必挂**：`M3_TEST_FILE_MAP` 是共享的（M3/M4/M5 三处门控都读）；新 ID 还要进 `runM3`/`runM4`/`runM5` 的 `knownIds`。

**⑩ 文档门控是"连续编号"**：`M5-GATE-docs` 要求 `D-54` 起连续 ≥6 条且 5 份 M5 报告齐全；跳号（只写 D-61、D-63）会 FAIL。

**⑪ 覆盖率只测 `packages/core` + `engine-ytdlp`**：打包脚本、`apps/desktop` 的 JS 不计入；但**新加的 core 模块必须配测试**，否则四维之一会掉到 70% 以下（当前 ≈86.9%，缓冲约 17 个点）。

**⑫ Electron 45 + electron-builder 26 + Node 22**：`electron-builder` 对 pnpm workspace 常需 `node-linker=hoisted` 或 `shamefully-hoist=true`（当前 `.npmrc` 是 `shamefully-hoist=false`）。若报 "cannot find module electron"，先改 `.npmrc` 再重装，**不要改业务代码**。

**⑬ `latest.yml` 的 `sha512` 与签名**：未签名安装包能生成 `latest.yml`，但 `electron-updater` 在 Windows 上校验签名失败会拒绝安装。无证书阶段走"手动下载覆盖安装"，并在报告写明这是签名限制，不是功能缺陷。

**⑭ 引擎更新的"暂停队列"不是"取消"**：`TaskQueue.cancel()` 会写 `Canceled` 终态，恢复不了。要的是"停止取新任务 + 等当前任务结束"的标志位。

**⑮ 托盘 / 通知的真实行为仍未验证**：`bootstrap` 已用假 electron 测过菜单与隐藏策略，但图标路径、DPI、点击聚焦只能真机确认（B5）。

**⑯ M3 弹窗仍是"短语表 i18n"**：英文下由 JS 拼接的动态串（`'条目 #' + n`、`'任务日志 · ' + id`）仍是中文。彻底解决要重写这些 JS 走 `t(key, params)`，会动 DOM 基线 → **放到 M6**，别在打包阶段顺手改。

**⑰ `reports/` 不入库**：`acceptance-report-m5.json`、`e2e-summary.json`、`layering.json` 都在 `.gitignore` 里。引用时说明"本地生成"，不要指望 clone 后直接看到。

---

## 7. 第一小时（命令级）

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt

# 0) 核对基线：一条命令看六项现状（代码提交/决策号/用例数/验收/E2E/覆盖率）
node scripts/handoff-check.mjs
git status --short                 # 期望：只有 M docs/PROJECT-HANDOFF.md

# 1) 三件套（离线可跑，先确认现状是绿的）
npm test                           # 53 files / 670 passed
pnpm turbo run typecheck           # 5/5
node scripts/check-layering.mjs --json   # violationsCount=0

# 2) 串行跑五套验收（约 12–15 分钟，别并行）
for m in M1 M2 M3 M4 M5; do node scripts/acceptance.mjs --milestone $m; done
#    全绿 → 到此为止。去要网络放行（§0.1），不要在等待期间开始任何新工作。

# 3) 需要联网前，先按 §0.1 向甲方请示；放行后再执行：
pnpm install
pnpm add -D electron-builder@^26 electron-updater@^6.8 -w

# 4) 装完立刻做"门控体检"（frozen 大概率红，见 §6.2-①）
node scripts/acceptance.mjs --milestone M3
```

**单文件调试**：`node node_modules/vitest/vitest.mjs run tests/unit/<file>.test.ts --reporter=verbose`
**单用例截图**：`node scripts/run-e2e.mjs --case=queue-ready`
**验收报告**：`reports/acceptance-report-m5.json`（`allGreen` / `skipped` / `releaseReady` 三个字段先看）

---

## 8. DoD 逐条对照

| DoD # | 条目 | 现在 | 交付前还差 |
|---|---|---|---|
| 1 | test + typecheck + layering 全绿 | ✅ | — |
| 2 | M5 九条断言全 PASS | ⚠️ 8 PASS + 2 SKIPPED | 完成 M5-5 更新逻辑 + 真机验证，把 `A-4.4-28/29` 从 SKIPPED 变 PASS |
| 3 | 安装版 + 便携版 + SHA256 | ⛔ | M5-4 打包 |
| 4 | 干净 VM：安装/便携/卸载（C13–C16） | ⛔ | 甲方按 `docs/M5-VM-CHECKLIST.md` 8 步实测 |
| 5 | 主题三态 + 快捷键 + 中英切换实测 | ⚠️ 静态面 ✅，真实窗口未跑 | N1 后开窗点一遍 |
| 6 | NOTICE + LGPL-3.0 十二条 | ⛔ | M5-6 文档 |
| 7 | L3 PASS 或明确 SKIPPED | ⚠️ SKIPPED | N3 放行后补做 |

**只有 1–7 全部成立才能说"M5 交付"；现在只能对外说"离线部分完成、打包与在线未开工"。**

---

## 9. 术语表（怕看不懂就先看这）

| 词 | 含义 |
|---|---|
| **N1** | 包管理器网络（`pnpm install` / 装 electron-builder）；国内镜像即可，**不需要国际出口** |
| **N2** | 代码托管/发布网络（GitHub Releases 取 `yt-dlp.exe`、Electron 预编译包）；通常国内可完成，慢可走镜像 |
| **N3** | 国际站点网络（访问 YouTube）；**必须国际出口**，没有就记 `SKIPPED` |
| **L0 / L1 / L2 / L3** | 测试层级：纯单测 / 录制 fixture 契约 / 本地真实进程 / 真实站点 |
| **C1–C12** | 产物校验 12 项（存在、哈希、容器、可解码、时长、流完整、规格、逐帧、附带产物、续传、历史、无假完成） |
| **C13–C16** | 干净 VM 验收：安装版全流程 / 便携版可运行 / 卸载无残留 / 升级后清理 |
| **U7** | 应用自更新在干净 VM 上的实测项 |
| **B1 / B5** | 已知阻塞：B1 = Electron 二进制缺失；B5 = 真实 GUI 从未跑过 |
| **D-xx** | `docs/DECISIONS.md` 的决策编号，改约定必须续号 |
| **SKIPPED** | 因环境不可用而未验证，**不等于通过**；报告里必须给原因 |
| **DoD** | M5 完成定义，本文 §8 的 7 条 |

---

## 10. 文件地图（要改哪里）

| 要做的事 | 文件 |
|---|---|
| 打包配置（NSIS / portable / extraResources） | `apps/desktop/electron-builder.yml` |
| 主进程入口（窗口/托盘/单实例） | `apps/desktop/src/main/{bootstrap,electron-entry}.ts` |
| IPC 通道与校验 | `apps/desktop/src/main/{m5-channels,m5-host}.ts`、`packages/shared/src/ipc.ts` |
| 运行时随包资源 | `resources/runtime/win-x64/**`（**不入 asar**） |
| 验收与门控 | `scripts/acceptance.mjs`（含 `M5_ASSERTIONS` / `runM5`） |
| 截图套装 | `scripts/{run-e2e,e2e-cases}.mjs`、`tests/e2e/baselines/**` |
| 文案（zh/en） | `packages/ui/src/i18n/messages.js` |
| 外观 / 快捷键 / 视图策略 | `packages/core/src/{appearance,shortcuts,task-view,crash,platform}/**` |
| 决策台账 | `docs/DECISIONS.md`（续号 D-61） |
| 块报告模板 | 参考 `docs/M5-0-REPORT.md` … `docs/M5-3-REPORT.md` |

---

## 11. 停止声明

**M5 离线四块已完成并全绿；打包（M5-4）、双通道更新（M5-5）、合规文档与 L3 烟测（M5-6）未开工，原因是 N1/N2/N3 未放行。未获甲方明确放行，不执行任何联网命令，也不对外声称"成品可安装、可下载"。**
