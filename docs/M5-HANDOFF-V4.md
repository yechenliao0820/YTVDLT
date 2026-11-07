# YTVDLT · 交接书 v4.2（国内网收尾 / 国际网开工版）

> 更新 **2026-11-07 12:45** ／ 本文是**当前状态唯一入口**，取代 v3.1 与 v4.0。
> **⚠️ 已被 `docs/M5-HANDOFF-V5.md` 取代（2026-11-07 国际网实测之后）。本文保留为国内网阶段的历史状态，不要再按本文 §6 的清单开工。**
> 本版围绕一个目标重写：**让下一棒（人或 AI）不空转、不重做、不越界**。每节都写清「做什么、跑什么命令、看到什么算成功、失败了怎么办」。
>
> 权威优先级：原始任务书 `C:/Users/leolee/WorkBuddy/2026-11-05-07-24-49/YTVDLT_HANDOFF.md`（**933 行，唯一权威**）＞ `docs/PROJECT-HANDOFF.md`（甲方副本，**有本地改动，不要提交/覆盖**）＞ `docs/PRD-M1.md` / `PRD-M3.md` ＞ `ARCHITECTURE-M1/M2/M3.md` ＞ `docs/DECISIONS.md`（D-01…**D-67**）＞ `docs/M5-HANDOFF-V2.md`（施工方法）＞ `docs/M5-HANDOFF-V3.md`（上一棒状态）＞ 本文。
> 环境：Windows 10 22631 ／ Node **22.22.2** ／ pnpm **9.15.9** ／ Electron **45.2.2** ／ electron-builder **26.18.0** ／ electron-updater **6.8.11** ／ 分支 `master`
> 项目根：`C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\ytvdlt`（下文相对路径均相对此目录）

---

## §0 开工前必做（10 分钟，做完再动手）

### 0.1 三条体检命令 + 期望输出（逐字对照，不一致就先别写代码）

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt

# ① 代码在哪一棒
git log --oneline -3
```
期望（顺序可能因新提交前移，但**必须能看到 `1521675` 或它的后代**）：
```
1521675 feat(m5): 非商业许可（D-66）+ 组件独立更新 yt-dlp/aria2c（D-67）
c1316c2 docs(m5): 交接书 v4 同步 D-66/D-67 —— 许可、组件更新按钮、甲方启用步骤
8cea189 docs(m5): 交接书 v4 —— 国内网收尾状态、已验证/未验证分栏、下一棒待办
```

```bash
# ② 工作区应只有两个「不许动」的东西
git status --short
```
期望**恰好**两行：
```
 M docs/PROJECT-HANDOFF.md
?? _tmp_2992_c8a08bf15dca424991930c32439a4a06
```
出现**任何第三个文件**，先 `git diff <file>` 搞清是谁改的，不要直接 `checkout` 掉。

```bash
# ③ 交接自查（打印当前真实数字，与本文对照）
node scripts/handoff-check.mjs
```
期望：`最后一次代码提交 1521675`、`决策编号 D-01…D-67（下一棒从 D-68 起）`、`截图用例数 30`、`M5 验收 8/10 PASS + 2 SKIPPED`、`E2E 30/30`、`覆盖率 86.75%`。
**任一项与本文不符 → 以脚本为准，本文过期，把差异写进报告。**

### 0.2 三条纪律（违反任何一条，后面的工作都不算数）

1. **先看后改**：改任何文件前先读它和它的调用方，别凭函数名猜行为。
2. **改完必跑**：`pnpm turbo run typecheck` + 相关单测；只改文档也要跑 `node scripts/handoff-check.mjs`。
3. **不重做已验证的东西**（§4.1 列了 13 项）。重做既浪费预算，也会把已验证的结论改坏。

### 0.3 什么算「空转」，以及空转时必须做什么

**空转的 7 个信号**（出现任意 2 个就停手）：

| # | 信号 | 说明 |
|---|---|---|
| 1 | 同一条命令**第 3 次**执行 | 前两次失败说明方法错了，不是运气差 |
| 2 | 反复读同一个文件超过 3 次 | 说明没读懂，应该 `grep` 关键函数名而不是整篇重读 |
| 3 | 连续「改一点 → 跑 → 又红 → 再改一点」但没新增信息 | 说明在猜，应先复现并打印实际值 |
| 4 | 开始修**与当前任务无关**的历史问题 | 记下来，别顺手修 |
| 5 | 没有明确失败用例就「顺手重构」 | 禁止 |
| 6 | 试图绕过门控（改阈值、删测试、把 SKIPPED 改 PASS） | 禁止，见 §11 |
| 7 | 20 分钟内没有任何可验证产出 | 停下来写 BLOCKED |

**空转时的强制动作（照做，不要继续试）**：

1. 停止一切执行；
2. 写 `docs/BLOCKED-<日期>.md`，只要四段：
   - 我想达到什么；
   - 我试了哪几条命令（原文）；
   - 每条命令的**真实报错原文**（不要转述）；
   - 我判断卡在哪（缺网络？缺文件？版本不匹配？需求不清？）。
3. 把「需要甲方提供什么」压成一句话（放行 `github.com`、给更新源地址、给一台干净 VM……）。

**不要**用「再试一次」代替这三步。

---

## §1 一分钟跑起来（命令照抄）

```bash
# 只跑测试（约 50 秒）
npm test

# 五套验收（必须串行，共用 reports/ 与 coverage/；约 12 分钟）
for m in M1 M2 M3 M4 M5; do node scripts/acceptance.mjs --milestone $m; done

# 重建前端产物（改了 packages/ui 或 main 之后）
node scripts/build-desktop.mjs

# 重打包（四参数缺一不可，约 2–7 分钟）
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
CSC_IDENTITY_AUTO_DISCOVERY=false \
./node_modules/.bin/electron-builder \
  --config apps/desktop/electron-builder.yml \
  --config.directories.buildResources=apps/desktop/build \
  -c.electronDist=node_modules/electron/dist \
  -c.extraMetadata.main=apps/desktop/dist/main/main.cjs \
  --win nsis portable
```

打包前**先**把旧输出挪走，否则会被本机 safe-delete 守卫打断（§7 第 6 条）：

```bash
mv dist/win-unpacked dist/win-unpacked-vN 2>/dev/null
mv dist/ytvdlt-0.1.0-x64.nsis.7z dist/ytvdlt-0.1.0-x64.nsis-vN.7z 2>/dev/null
```

---

## §2 仓库真实状态（2026-11-07 12:45 实测）

### 2.1 提交链（本轮 8 个）

| commit | 内容 |
|---|---|
| `c1316c2` | 交接书同步 D-66/D-67 |
| `1521675` | **D-66 / D-67** 非商业许可 + 组件独立更新（yt-dlp/aria2c）+ 设置页按钮 |
| `8cea189` | 交接书 v4 首次入库（含把上一棒 V3 一并入库） |
| `9821cf4` | **D-65** aria2c 随包 + 修 `--downloader-args` 误用 |
| `f505651` | **C3 / D-63** 合规与收尾（六份文档 + README） |
| `ffb9ee0` | **C2 / D-62** 更新内核（引擎自更新 + 队列暂停 + 应用更新协调器） |
| `e10afb0` | **D-64** N1 依赖落地（electron-builder / electron-updater） |
| `4e0bc0c` | **C1 / D-61** 打包块（frozen 门控 + 便携数据目录 + 构建链 + 真产物） |

### 2.2 工作区脏文件（**有意保留**）

| 路径 | 状态 | 处理 |
|---|---|---|
| `docs/PROJECT-HANDOFF.md` | `M` | **永不提交、永不覆盖**（甲方本地改动） |
| `_tmp_2992_c8a08bf15dca424991930c32439a4a06` | `??` | 与本项目无关，不 commit、不删 |

### 2.3 产物（`dist/`，被 `.gitignore` 忽略）

| 文件 | 体积 | SHA-256 |
|---|---|---|
| `YTVDLT Setup 0.1.0.exe` | 215.7 MB | `ba2d43e240352aa6cb146e5d963bbc13c25e5b6bfc72f1ebd9e96c6e96f5d1aa` |
| `YTVDLT-Portable-0.1.0.exe` | 192.5 MB | `e36ce86d4c763c3ae309478685d7aa7fa4fb29909c6865a43cd6d108bcfab221` |
| `win-unpacked/YTVDLT.exe` | 238.1 MB | `040ee7db5c30b3453a4fb056ce7dc9bc4defd223d2149d1ea1c590c752efdfb1` |
| `win-unpacked/resources/app.asar` | 0.6 MB | `98e03d0614d6515259cf19c99a290690f61c8c51e8b7016f75b773d0a14fd7c0` |

> 重打包哈希必变（NSIS 时间戳）。别把本文哈希当「当前产物校验值」，只当「这一版长什么样」。

### 2.4 随包运行时（`resources/runtime/win-x64/`，**二进制未入库**）

| 文件 | 必需 | 说明 |
|---|---|---|
| `yt-dlp.exe` | ✅ | 2026.10.26，Unlicense，23.6 MB |
| `node.exe` | ✅ | v24.22.2，MIT，93.9 MB |
| `ffmpeg/`（10 个文件） | ✅ | BtbN lgpl-shared `n9.0.2-47-gb204e94e90`，LGPL-3.0 |
| `aria2c.exe` | ⬜ 可选 | **1.35.0**，GPL-2.0-or-later，5.1 MB |
| `SHA2-256SUMS` | ✅ | 引擎自更新清单（yt-dlp 官方发布那份） |
| `ARIA2-COPYING.txt` / `FFMPEG-LICENSE.txt` | ✅ | 许可证全文，随包 |
| `runtime-manifest.json` | ✅ | **13 项**，自检与合规的唯一来源 |

**入库边界**：文本资产（manifest / schema / LICENSE / SUMS / README）**入库**；四个二进制**未入库**。干净 clone 后这些文件不存在，`check-runtime` 与打包都会失败——**这不是 BUG**。

### 2.5 数字（随时回源，别手抄）

| 项 | 值 | 来源 |
|---|---|---|
| vitest | **759 tests / 0 failed** | `M5-GATE-vitest` |
| 覆盖率四维最低 | **86.75%**（阈值 70%） | `M5-GATE-coverage` |
| 分层违规 | 0 | `reports/layering.json` |
| 运行时自检 | 3/3 必需 OK；aria2c 显示 OPTIONAL | `reports/check-runtime.json` |
| e2e | 30/30 + 5/5 反例 | `reports/e2e-summary.json` |
| 测试文件映射 | **67** mapped，0 unmapped | `M5-GATE-file-coverage` |
| 决策编号 | D-01…**D-67**（下一棒 **D-68** 起） | `grep "^## D-" docs/DECISIONS.md` |

---

## §3 本轮做了什么（按块）

### 3.1 C1 / D-61 打包块（`4e0bc0c`）

| 改动 | 为什么 |
|---|---|
| 重写 `scripts/frozen-gate.mjs`（R1/R2/R3） | 旧门控要求 `package.json`/lock 对 HEAD 零改动，装任何打包依赖都判红 |
| `apps/desktop/src/main/data-dir.ts` | 便携版把配置写在 exe 旁边；用「写探针再删」判断目录可写性 |
| `runtime-paths.ts` 加 `resolveFixtureDir()` | 打包后 `process.cwd()` 由启动方决定，指向陌生目录 |
| `m5-host.ts` 加 `aboutInfo()` | 「关于」框需要版本/运行时/数据目录/LGPL 声明的纯数据 |
| `main.ts` + `preload/index.ts` | **仓库原本没有可被 `package.json#main` 启动的入口**，exe 起来就退 |
| `scripts/build-desktop.mjs` | 三个 workspace 包要内联；用 vite 带来的 esbuild，**不新增直接依赖** |
| `scripts/make-icon.mjs` | 仓库原本**一个图标都没有**，托盘构造会抛错、安装包用默认图标 |
| `electron-builder.yml` 改 1 处 | v26 把 `signingHashAlgorithms` 移到 `signtoolOptions`，旧位置整个 win 块校验失败 |

### 3.2 N1 / D-64 依赖落地（`e10afb0`）

`electron-builder@26.18.0`、`electron-updater@6.8.11` 进根 `devDependencies`；Electron 45.2.2 二进制经 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 补齐。lock 新增 203 个包、**0 个既有包消失**。

### 3.3 C2 / D-62 更新内核（`ffb9ee0`）

| 组件 | 行为 |
|---|---|
| `SelfUpdater` | 校验清单 → 字节哈希全等才动盘 → `.bak` → `.new` → `rename` → 复验 → 失败回滚；校验不符**一个字节都不写** |
| `TaskQueue.pauseIntake/resumeIntake` | 只停「从 FIFO 取新活」，**不 cancel、不写 `Canceled`**；`try/finally` 保证恢复 |
| `AppUpdateCoordinator` | 无源跳过（零网络）/ 非 http 拒绝 / 失败静默降级 / 用户只提示一次 / 禁 `showErrorBox` |

### 3.4 C3 / D-63 合规与文档（`f505651`）

六份文档：`THIRD_PARTY_NOTICES` / `LICENSE-COMPLIANCE` / `BUILD` / `ACCEPTANCE` / `SHORTCUTS` / `README`。FFmpeg 按实测写 **LGPL-3.0**（任务书 §6.7/§12.5 的「LGPL-2.1+」是过时文案，已登记差异）。

### 3.5 D-65 aria2c 随包（`9821cf4`）

三个二进制之外再加第四个：`aria2c.exe` 进 `extraResources`，默认启用。顺带修真 BUG：原来把 exe 路径塞进 `--downloader-args aria2c:<path>`，该值会被原样拼进 aria2c 命令行 → 路径变成额外下载目标。改为只发 `--downloader aria2c`，目录进子进程 `PATH`。

### 3.6 D-66 / D-67 许可与组件更新（`1521675`）

- **许可**：自定义 `LICENSE`，可改可分发、**禁商用**（MIT 做不到禁商用，两者不可兼得）。`package.json` 加 `license`，frozen 门控放行这**唯一**一个新增顶层字段。
- **组件更新**：`HttpPort`（系统里唯一网络端口）+ `HttpUpdateSource`（静态 HTTPS 目录）+ `SelfUpdater` 通用化（`componentFileName` / 已最新短路 / `reason`）+ `ComponentUpdater`（yt-dlp + aria2c，单失败不中断）+ 两条 IPC + 设置页按钮。

---

## §4 已验证 / 未验证（别混，别把左栏搬去右栏）

### 4.1 已验证（13 项，均有证据路径）

| 项 | 层级 | 证据 |
|---|---|---|
| 五套验收全绿 | L0–L1 | `reports/acceptance-report-m{1..5}.json` |
| 安装包能产出 | L4 构建 | `dist/*.exe` + §2.3 哈希 |
| **exe 真能启动** | L4 运行 | 4 进程存活；`reports/ui-shot.png`（Electron `capturePage()`） |
| 便携数据目录探针 | L4 运行 | `dist/win-unpacked/config/` 被创建 |
| **aria2c 真被调用** | L2 本地 | `[debug] Invoking aria2c downloader` + `-x16 -j16 -s16`，本地直链 1 MiB 下载成功 |
| 引擎更新（替换/回滚/拒写） | L0 + L2-local | `self-updater.test.ts` 12 例；`engine-update-local.test.ts` 5 例 + `reports/engine-update-l2.json` |
| 组件更新（协议/失败隔离/短路） | L0 | `component-updater.test.ts` 8 例 + `http-update-source.test.ts` 5 例 |
| 队列暂停不产生 `Canceled` | L0 | `task-queue-intake.test.ts` 6 例 |
| frozen 门控语义 | L0 | `frozen-gate.test.ts` 16 例 |
| 页面渲染 | L1 | `e2e-summary.json` 30/30 + 5/5 |
| 多语言目录完整 | L0 | `i18n.test.ts`（新增 5 个键中英齐全） |
| 分层守卫 0 违规 | L0 | `reports/layering.json` |
| 打包配置只需 1 处适配 | L4 | D-61 ④ |

### 4.2 **未验证**（一项都别写成「通过」）

| 项 | 为什么没做 | 依赖 |
|---|---|---|
| 真实站点下载（L3） | 国际网未放行 | N3 |
| 引擎**在线**更新 | 同上（官方 release 在 GitHub） | N3 |
| **组件在线更新**（真实 HTTPS 拉取） | 没有可用发布目录 | N2/N3 |
| 应用自更新 v1→v2 | 无托管更新源；`electron-updater` **不进 asar**；甲方明确「等 GitHub 仓库」 | N2 + 配置变更 |
| C13 干净机安装 | 本机是开发机，装了 Node/Python，**不能**冒充干净机 | 干净 VM |
| C14 干净机便携 | 同上 | 干净 VM |
| C15 删任一 exe 后的报错 | 逻辑在，真机演练没做 | 干净 VM |
| C16 PATH / 卸载残留 | 同上 | 干净 VM |
| 代码签名 | 无证书（甲方已决定不采购） | 甲方 |
| 自定义许可的外部合法性审查 | 条款未过律师 | 甲方 |

---

## §5 甲方待办（按优先级）

### 5.1 立即：VM 里跑一次（最小验收，30 分钟）

1. 找一台 **Win10 1809+ / Win11 x64**：**没装过 Node / Python / FFmpeg / Chocolatey**，没手动装过 VC++ 运行库。Windows Sandbox 也行（它无声音/无托盘通知，不影响下载）。
2. 拷 `dist/YTVDLT Setup 0.1.0.exe` 进去，双击 → SmartScreen「更多信息 → 仍要运行」→ 安装。
3. 启动 → 设置里确认主题/语言/并发能改；「关于」显示 `LGPL-3.0`。
4. 粘一个**真实单视频链接**（先别上播放列表）→ 下载 → 看到进度（aria2c 生效时 16 连接分片）→ 完成后能播放 → 「打开文件/打开目录」可用。
5. 再跑**便携版**：解压到 `D:\` 之类可写目录 → 双击 → 同目录应出现 `config\`。
6. 记录**哪一步报什么错、弹什么窗**。失败就把 `%APPDATA%\YTVDLT\logs\*.jsonl` 或便携目录 `logs\*.jsonl` 发回来（已脱敏，可整份贴）。

### 5.2 想让「组件更新」按钮可用（可选，5 分钟）

按钮现在是**灰的**，因为还没有更新源。启用两步：

1. 准备一个可公开访问的目录，放：
   - `yt-dlp.exe`（最新版）
   - `SHA2-256SUMS`（官方发布页那份清单，须含 `yt-dlp.exe` 行；要更新 aria2c 就再放 `aria2c.exe` + 对应行）
2. 设环境变量后重启应用：

```bat
set YTVDLT_COMPONENT_FEED=https://你的域名/updates/
```

也可在配置里写 `advanced.componentFeedUrl`。配好后：设置 → 更新 →「组件更新 yt-dlp/aria2c」显示当前版本、按钮可点；点一次 = 下载 → 校验 → 覆盖 → 复验，失败自动回滚，成功提示「重启后生效」。

### 5.3 之后：三项决定

| 项 | 现状 | 说明 |
|---|---|---|
| 代码签名 | **已决定不采购** | 代价：每次首启弹 SmartScreen，点「仍要运行」即可。若日后开放商用或真开源（换 MIT），可试 SignPath 免费通道 |
| 自有许可 | **已定**：自定义非商业许可（可改可分发、禁商用、商用需授权） | **不是 OSI 开源**，对外只能说「源码公开、非商业免费」。要放开商用就把 `LICENSE` 换成 MIT 全文 |
| 应用本体更新 | **等 GitHub 仓库** | 甲方明确：仓库建好后再接，见 §6 T4 |

---

## §6 国际网阶段（N3）任务清单 —— 下一棒就干这个

> 前置：甲方放行 `github.com` / `raw.githubusercontent.com` / 真实站点。**没放行前，T2–T5 一律不做**，只做 T1 与 T6。

### T1 网络放行验证（10 分钟，必须先做）

```bash
# 期望：两个 200
curl -sS -o /dev/null -w "%{http_code}\n" https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest
curl -sS -o /dev/null -w "%{http_code}\n" https://github.com
```
- 都是 `200` → 继续；
- `000` / `fetch failed` / TLS 错 → **停**，按 §0.3 写 BLOCKED。别试代理、别试镜像（镜像不是官方源，不能当 L3 证据）。

### T2 L3 在线烟测 —— **先 YouTube，后别的站**

> ⚠️ **这一节是全阶段最可能失败的地方，必须第一个跑。** 后面的 T3/T4 再完美，YouTube 下不动就是零。
> **不要**先改代码再来测；先用命令行把「yt-dlp 本身能不能拿 YouTube」问清楚，再进应用。

#### T2.0 命令行先行（不进应用，5 分钟，只读探测）

用**随包的那个二进制**（不是系统里别处的 yt-dlp），先只探测不下载：

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt/resources/runtime/win-x64

# a) 版本必须是 2026.10.26 或更新
./yt-dlp.exe --version

# b) 只解析不下载（最省流量，最容易看清错误）
./yt-dlp.exe --simulate --no-playlist --print "%(title)s | %(ext)s | %(resolution)s" "<YouTube 单视频 URL>"

# c) 列格式（确认有没有可下的流，尤其 1080p 以上是否只有 SABR）
./yt-dlp.exe --no-playlist -F "<同一个 URL>"

# d) 真下一小段（≤1 分钟，验证落盘）
./yt-dlp.exe --no-playlist -f "bv*+ba/b" --download-sections "*0-30" -o "probe-%(id)s.%(ext)s" "<同一个 URL>"
```

**判定**：

| 结果 | 含义 | 下一步 |
|---|---|---|
| b 打印出标题/格式 | 解析通过 | 继续 c、d |
| `Sign in to confirm you're not a bot` | YouTube 对**本机 IP** 触发了机器人校验 | 见下方「失败处理」第 2 步（cookies），别浪费时间改代码 |
| `HTTP Error 403` / `Unable to extract` / `nsig extraction failed` | 多为 yt-dlp 版本落后于 YouTube 改动 | 走 **T3 先把 yt-dlp 更新到最新**，再重跑 b |
| `Requested format is not available` | 格式选择问题，不是网络问题 | 用 `-F` 看实际格式，改用 `bv*+ba/b` |
| 卡住不动 / 超时 | 网络或代理问题 | 先 `curl -I https://www.youtube.com` 确认连通性 |

> `nsig`（签名解密）依赖 JS runtime。**本应用显式传** `--no-js-runtimes` + `--js-runtimes node:<绝对路径，指向随包 node.exe>`（见 `packages/engine-ytdlp/src/argv-builder-download.ts` 第 95–96 行）。
> 所以命令行复现时，要加上同样的参数才有可比性：
> ```bash
> ./yt-dlp.exe --js-runtimes node:./node.exe --simulate --no-playlist "<URL>"
> ```
> 若应用内报 `no JS runtime` / `nsig extraction failed`，先查 `resources/runtime/win-x64/node.exe` 是否还在、路径有没有被挪——**别急着换 yt-dlp 版本**。

#### T2.1 站点矩阵（应用内，用**打包后的 exe**）

每一行都要单独记录，别用「YouTube 能下」概括全部：

| # | 场景 | 判据 | 常见坑 |
|---|---|---|---|
| 1 | **YouTube 普通单视频**（≤5 分钟，公开） | 进度条正常、成品可播放、`logs/*.jsonl` 有完成记录 | 机器人校验；SABR 导致只剩低清 |
| 2 | **YouTube 长视频**（>10 分钟，有分片） | 分片并发不炸、断点续传可用（中途取消再重试） | 分片超时；aria2c 与 `--concurrent-fragments` 互斥（已按 D-65 处理） |
| 3 | **YouTube Shorts** | 能解析、能下 | 部分 Shorts 走不同的 player client |
| 4 | **YouTube 播放列表**（3–5 条） | 整表解析 → 勾 2 条 → 生成 2 个独立任务、并发不超 3 | 列表解析失败常是 cookies 问题 |
| 5 | **需要登录的内容**（年龄限制 / 会员，可选） | 配 `network.cookiesFile` 后能下；不配时**给出明确错误码，不崩** | 无 cookies 时必须是「明确失败」，不是卡死 |
| 6 | **非 YouTube 站点对照**（B站 或 Vimeo，任选一个） | 能下 | 用来区分「YouTube 特有问题」和「整个下载链路坏了」 |

**只有 1–4 + 6 全过，才能说「L3 通过」。** 第 5 项是加分项，不做不算失败，但**必须记录它失败时的错误码**（证明降级是明确的而不是崩的）。

#### T2.2 失败处理顺序（**严格按这个顺序，别跳步**）

1. **先升级 yt-dlp**：YouTube 改动比 yt-dlp 发版快，`2026.10.26` 之外大概率需要更新。用 T3 的组件更新，或手动替换 `yt-dlp.exe`。升级后**重跑 T2.0 b**，仍失败才进第 2 步。
2. **再加 cookies**：从浏览器导出 Netscape 格式 cookies 文件，在设置里指到 `network.cookiesFile`。注意：cookies 属于凭据，**日志里会被掩码**，报告里只写「已配 cookies」，不要贴内容。
3. **再考虑 extractor 参数**（如 `--extractor-args "youtube:player_client=..."`）：这属于**绕过**，会让行为不稳定，**必须记进决策**，不能悄悄加。
4. **仍失败 → 停**：把 `yt-dlp --simulate -v` 的**完整 stderr** 存到 `reports/l3-smoke.json`，按 §0.3 写 BLOCKED。**不要**开始改应用代码——问题不在应用层。

#### T2.3 证据文件

`reports/l3-smoke.json`，一行一个场景，至少包含：

```json
{
  "generatedAt": "2026-11-08T...",
  "ytdlpVersion": "2026.10.26",
  "aria2cUsed": true,
  "cookiesConfigured": false,
  "cases": [
    { "id": "yt-single", "urlKind": "youtube-video", "result": "pass|fail", "errorCode": null, "durationMs": 41230, "stderrHead": "" },
    { "id": "yt-playlist", "urlKind": "youtube-playlist", "result": "pass", "errorCode": null, "durationMs": 63000, "stderrHead": "" }
  ]
}
```

**没有这个文件，不要说 L3 通过**；文件里 `result: "fail"` 的行必须带 `stderrHead`（前 3 行原始报错）。

### T3 引擎 / 组件在线更新

1. 设 `YTVDLT_COMPONENT_FEED` 指向**官方 yt-dlp release 的资产目录**（或自建镜像）；
2. 点「检查并更新」：下载 → 校验 → 覆盖 → 复验；
3. 验回滚：故意把 `SHA2-256SUMS` 改一个字符再点 → 必须 `checksum-mismatch` 且**原文件字节不变**（前后 `sha256sum` 对比）。

### T4 应用自更新（甲方 GitHub 仓库就绪后）

**这是唯一需要改打包配置的任务**，改动点已定位：

1. `apps/desktop/electron-builder.yml` 的 `files` 追加 `node_modules/electron-updater/**` 及其运行时依赖（或把 adapter 改成静态 bundle 并 `external: []`）；
2. 发布设置：`publish: { provider: 'generic', url: 'https://你的域名/updates/app/' }`（GitHub Releases 亦可，用 `provider: 'github'`）；
3. 产出 `latest.yml` + `.blockmap`（electron-builder 已自动生成），上传；
4. 配 `advanced.updateFeedUrl`，跑 v1→v2：
   - **必须验证差分下载**：第二次更新看日志里 blockmap 命中，而不是整包 200 MB；
   - **必须验证用户数据不丢**：更新后配置、队列历史仍在；
   - **必须验证失败降级**：断网后点检查 → 只写 WARNING，不弹错误框，应用照常可用。

### T5 干净机 C13–C16（与网络无关，可与 T2 并行）

| 用例 | 判据 |
|---|---|
| C13 安装版 | 干净 VM 装完 → 自检 4 项全绿 → 完成一次真实下载 → 无「缺少 xxx.dll / 未找到 Python」 |
| C14 便携版 | 免安装可跑；注册表无安装项；PATH 前后无变化 |
| C15 完整性 | 删任一 exe → 明确 `ENGINE_MISSING`/`JS_RUNTIME_MISSING`/`FFMPEG_MISSING`，不崩 |
| C16 不污染 | 卸载后 PATH 无变化、无残留进程；**用户下载目录的成品文件不被删** |

### T6 收尾（每完成一项都要做）

```bash
pnpm turbo run typecheck
npm test
for m in M1 M2 M3 M4 M5; do node scripts/acceptance.mjs --milestone $m; done
```
任一项红 → 先修再继续；**别带着红门控做下一件事**。

### T7 把 `A-4.4-28/29` 从 SKIPPED 改成 PASS（只有真做完才允许）

- 现状：两条 `deferred` 文案写于 gate 关闭期，说「未实现」——**已过时**（D-62 ⑤ 登记）。
- 改法：把 `scripts/acceptance.mjs` 两条 `deferred` 改成「已实现，L3 已实测（证据路径）」，同时更新 `M5-5-REPORT.md` 栏②；改完**必须串行重跑五套验收**。
- **禁止**：没做 T2/T3 就把 state 改 PASS。

---

## §7 排雷总表（16 条，含报错原文）

| # | 坑 | 症状（原文） | 正确做法 |
|---|---|---|---|
| 1 | Electron 45 主进程不能用 ESM 具名导入 | `SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'` | 主进程打 **CJS**（`main.cjs`），用 `__dirname` |
| 2 | electron-builder 26 schema 变更 | `configuration.win should be one of these: null` | `signingHashAlgorithms` 放 `win.signtoolOptions` 下 |
| 3 | 根 `package.json` 没有 `main` | 打包成功但启动即退 | `-c.extraMetadata.main=apps/desktop/dist/main/main.cjs` |
| 4 | `buildResources` 默认在仓库根 | 图标不生效、`default Electron icon is used` | `--config.directories.buildResources=apps/desktop/build` |
| 5 | npmmirror CDN 偶发 502 | `⨯ Response code 502 (Bad Gateway) failedTask=build` | 加 `-c.electronDist=node_modules/electron/dist`，彻底不下载 |
| 6 | 本机 safe-delete 守卫（>50 文件/轮） | `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":121,...}` | **改名不删**：`mv dist/win-unpacked dist/win-unpacked-vN`；覆盖率清理同理 `mv coverage/.tmp coverage/.tmp-$(date +%s)` |
| 7 | frozen 门控按「任何 `-` 行」判 | 每次合法 `pnpm add` 都判红（实测 39 行删除全是 pnpm 重解析） | 已改语义判定（D-61 ②），别退回文本 diff |
| 8 | `--downloader-args aria2c:<path>` | aria2c 把路径当额外下载目标 | 只发 `--downloader aria2c`，目录进 `PATH`（D-65） |
| 9 | 环境里 `ELECTRON_RUN_AS_NODE=1` | `Cannot read properties of undefined (reading 'isPackaged')`，日志出现 `Node.js v22/v24` | 启动前 `env -u ELECTRON_RUN_AS_NODE` |
| 10 | `resources/runtime/**` 二进制未入库 | 干净 clone 后打包出空 runtime | 明确告知甲方：不是 BUG，需先放二进制 |
| 11 | `PROJECT-HANDOFF.md` 有甲方改动 | 误提交会覆盖甲方内容 | 永不 `git add`，永不 `-A` |
| 12 | e2e 页面直接读 `packages/ui/src`（不是 dist） | 改了 dist 但截图没变 | 改 UI 要改源码，`build-desktop` 只影响打包产物 |
| 13 | 中文界面**不走** i18n 目录 | 改了 `messages.js` 的中文值，页面还是旧文案 | zh 文案以 HTML 为准；`messages.js` 的 zh 只在切语言时用 |
| 14 | `--update-baselines` 会重写全部 30 例 | 看不出哪几个真变了 | 跑完 `git status tests/e2e/baselines`，只应有预期文件，多出来的逐个看 |
| 15 | 打包后 `electron-updater` 不在 asar | 配了 feed 也只记一条 `WARNING` | 见 T4，需改 `files` |
| 16 | `check-runtime` 里 aria2c 恒 OPTIONAL | `optionalMissing: 1` 看着像缺文件 | **历史语义**：`required:false` 的组不校验文件。修法见下 |

> 第 16 条修法（低优先级）：`RuntimeResolver.checkGroup()` 对 `required:false` 的组若 manifest 有条目则逐个 `checkFile()`，全在报 `OK`，同时保持 `required:false`（`requiredOk` 仍为 3，`M3-GATE-runtime` 的 `requiredOk===3` 不能动）；`runtime-resolver.test.ts` 第 69 行原断言需同步改。

---

## §8 决策索引（D-61…D-67，全文见 `docs/DECISIONS.md`）

> 编号现状：**D-01…D-67**，连续无跳号。**下一棒从 D-68 起**，不要复用或重排。

| 决策 | 一句话 |
|---|---|
| **D-61** | frozen 门控收窄为「语义不删除」；顺带落地 N1 依赖、构建链、便携数据目录、`electron-builder.yml` 唯一一处 schema 修复 |
| **D-62** | 双通道更新（引擎走 CorePorts / 应用走 UpdaterPort）+ 队列暂停用标志位 + 静默降级；三层口径分开标注 |
| **D-63** | 合规统一 LGPL-3.0（任务书旧文案登记为过时）；「关于」框无需订正；L3 与 C13–C16 维持 SKIPPED |
| **D-64** | N1 依赖声明与 Electron 二进制补齐，**单独 commit**，与代码决策分开回滚 |
| **D-65** | aria2c 随包（1.35.0 / GPL-2.0-or-later / 独立进程聚合分发）+ 修 `--downloader-args` 误用 |
| **D-66** | 许可证 = 自定义非商业（源码公开、禁商用），`package.json` 加 `license` 并放行该顶层字段 |
| **D-67** | 组件独立更新：`HttpPort` + `HttpUpdateSource` + 双组件更新器 + 设置页按钮；ffmpeg/node 不参与 |

---

## §9 文件地图（改之前先读这里）

**核心新增**
```
scripts/frozen-gate.mjs                      冻结门控纯函数（R1 request.ts / R2 依赖白名单 / R3 lock 语义）
scripts/build-desktop.mjs                    主进程 + preload bundle + 渲染层复制
scripts/make-icon.mjs                        现画四尺寸 ICO
apps/desktop/src/main/main.ts                唯一入口（CJS），路径全部相对 __dirname
apps/desktop/src/main/data-dir.ts            便携探针
apps/desktop/src/main/app-updater.ts         应用更新协调器（零 electron-updater import）
apps/desktop/src/main/component-updater.ts   yt-dlp / aria2c 组件更新
packages/engine-ytdlp/src/self-updater.ts    校验/替换/回滚（normalizeToolVersion 也在这）
packages/engine-ytdlp/src/http-update-source.ts  静态 HTTPS 目录源
packages/shared/src/update.ts                更新域类型
```

**改前必读**
| 要改 | 先读 |
|---|---|
| 打包配置 | `docs/BUILD.md` §4 + §7 第 2/3/4/5 条 |
| 更新逻辑 | `packages/engine-ytdlp/src/self-updater.ts` 全文 + `tests/unit/self-updater.test.ts` |
| IPC / 设置页 | `apps/desktop/src/main/m5-channels.ts`（`PAYLOAD_KEYS`）+ `tests/unit/m5-channels.test.ts` |
| 验收脚本 | `scripts/acceptance.mjs` 的 `M3_TEST_FILE_MAP` + `docs/M5-HANDOFF-V2.md` §7.4 |
| 任何 UI | `packages/ui/src/**` + `tests/e2e/baselines/**`（改完必须重建并逐张核对） |

**改了就红线**（会触发连锁）
`packages/shared/src/request.ts`（D-50 冻结）、`tests/e2e/baselines/**`（除非有意改 UI）、`docs/M5-SUMMARY.md`（`M5-GATE-docs` / `blockers` 依赖）、`docs/PROJECT-HANDOFF.md`（甲方副本）。

---

## §10 一次交付的 Definition of Done

下次交接时必须同时满足：

1. `pnpm turbo run typecheck` **5/5**；
2. `npm test` **0 failed**，覆盖率四维 ≥ 70%；
3. 五套验收 `allGreen=true`；`releaseReady` 只有在 C13–C16 全做完后才允许改 `true`；
4. `reports/` 有本轮新增证据（`l3-smoke.json` 站点矩阵 / 干净机 / 更新实测，各一个 JSON），且 L3 里 YouTube 单视频与播放列表两行必须 `pass`；
5. `docs/DECISIONS.md` 连续编号，新增决策都有「原因 + 验证 + 影响范围」；
6. 每个 commit 能单独回滚，不出现「一个 commit 塞三个决策」；
7. 本文（或后继版本）更新到「下一棒照着做就能开工」，且 `node scripts/handoff-check.mjs` 的数字与文中一致。

---

## §11 禁止清单（违者交付不算数）

1. 用 `git add -A` / `git add .` / `git add -u`；提交 `docs/PROJECT-HANDOFF.md`。
2. `rm -rf` / `del /S` 任何目录；本项目一律「改名不删」。
3. 改 `M3_TEST_FILE_MAP` 之外的验收口径；调低覆盖率阈值；把 SKIPPED 改 PASS。
4. 没复现失败就改代码；没跑测试就写「已修复」。
5. 在报告里写没做过的实测（尤其 L3、干净机、签名）。
6. 为了让门控变绿而删测试、改断言、跳过 e2e。
7. 顺手重构与当前任务无关的模块。
8. 把 `ffmpeg/`、`node.exe` 纳入「组件更新」（与应用版本耦合，会崩）。
9. 把「源码公开 + 禁商用」对外说成「开源」。
10. 在没有 `reports/*.json` 证据的情况下说「通过」。

---

## §12 一句话口径（对外就这么说）

> **国内网部分已完成：可安装、可运行的 Windows 包（安装版 + 便携版），五套验收全绿，759 条测试零失败；yt-dlp / aria2c 可在应用内单独更新（覆盖式、失败回滚）。**
> **未完成的是需要国际网、干净虚拟机或采购项的部分：真实站点在线下载（L3）、组件与应用的在线更新实测、干净机安装与卸载验收（C13–C16）。**
> **`releaseReady` 仍为 `false`。**
