# YTVDLT 交付报告（0.2.8 · 最新）

> 交付日期：2026-11-10 ｜ 交付人：Buddy ｜ 接收人：LeoLee
> 本轮三件事：① 修「本地文件已被外部删除时，勾选『同时删除本地文件』导致任务历史删不掉」（D-120）；② 任务卡片增加本地文件状态检测与打开文件/打开文件夹的准确反馈（D-120）；③ 设置 → 关于改为「本软件主许可 + 各组件各自许可」分层，并逐字内嵌完整英文许可证全文（D-121）。**本轮仅本地打包，GitHub Release 未发布**，等业主明确指令。

## 一、交付物

| 交付物 | 位置 | 大小 |
|---|---|---|
| 安装版（NSIS） | `dist-0.2.8\YTVDLT Setup 0.2.8.exe` | 226,309,350 B（215.8 MiB） |
| 差分清单 | `dist-0.2.8\YTVDLT Setup 0.2.8.exe.blockmap` | 233 KB |
| 更新清单 | `dist-0.2.8\latest.yml` | 341 B |
| 免安装目录 | `dist-0.2.8\win-unpacked\` | 真机 CDP 验证用 |

按铁律 9 只打 NSIS 安装版（未打便携版）。两个 `package.json` 打包前同步升到 0.2.8，打包后根 `package.json` 未被 electron-builder 改写（与备份逐行比对，仅 version 一行差异）；仓库版本基准 0.2.8。安装包 SHA-256 `e5ba021a…1db2`，`latest.yml` 的 sha512 / size 与本地 exe 逐项一致。

## 二、逐项落地

| # | 诉求 | 落地 |
|---|---|---|
| 1 | 视频被手动删除后，勾选「同时删除本地文件」→ 整个删除失败、历史记录删不掉 | 根因在 `TASK_ACTION`：`shell.trashItem` 对不存在文件抛 `ENOENT`，旧实现把它算作「部分失败」并在 `taskDetail.perform('remove')` **之前** return。改为逐路径 `trashed/missing/error` 结构化结果，先 `stat` 判存在；`ENOENT` 幂等视为已完成，`EACCES/EBUSY/EIO` 才保留记录并回报真实原因；被其它在册任务引用的同一物理文件跳过回收。（D-120） |
| 2 | 卡片在文件已被外部删除后仍显示「已完成」、点打开无反馈 | 新增主进程 `local-file-status.ts`（按需 `stat`、errno 五分类、1.5 s TTL、用户操作时强制重查），复用 `TASK_LIST`/`TASK_ACTION` 两个现有通道，不新增 IPC；卡片 meta 行加轻量状态标识，live 模式注入「打开文件」按钮；`open-folder` 改为只依赖原目录存在。（D-120） |
| 3 | 设置 → 关于放完整英文许可证，注明本软件与各组件各自遵循什么许可 | 标题「开源许可声明」→「许可与授权」（本软件是 source-available 非商业许可，非 OSI 开源、非 MIT）；三列表格：YTVDLT Non-Commercial License 1.0 + yt-dlp Unlicense / FFmpeg LGPL-3.0 / aria2c GPL-2.0-or-later / Electron MIT / Node.js MIT；折叠块逐字内嵌根 `LICENSE` 英文部分 71 行。（D-121） |

## 三、验收结果

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | 5/5 successful |
| 全量单测（不带覆盖率） | 88 文件 1152/1152 通过（含 D-120 新增 77 例、D-121 新增 11 例） |
| `run-e2e.mjs` | 31/31 case + 反例 5/5 全绿；D-121 改 UI 后按 §7 逐 case 重建 `settings-appearance` / `settings-en-dark` 两个 DOM 基线，PNG 未动、像素差 0 px |
| `check-layering` / `frozen-gate` | 0 violations / 通过 |
| `build-desktop.mjs` | 成功（main 285.6 KB / preload 3.7 KB / renderer 已拷贝） |
| 打包产物自检 | asar 内 `version=0.2.8`、`main=apps/desktop/dist/main/main.cjs`；D-120/D-121 关键串（`about-licence-text`、`card-file-state`、`FILE_DELETE_FAILED`、许可证英文全文）均在包内；`icon.ico` 四档 DIB 载荷在 `YTVDLT.exe` 内命中 4 次；`resources/runtime/` 含 yt-dlp / ffmpeg / node / aria2c 与许可全文；`app-update.yml` 已生成 |
| `handoff-check.mjs` | 已跑，决策编号 D-01…D-121（下一棒 D-122） |

## 四、已知边界

1. **未在已安装的真机环境点过本轮三个改动**：打包产物只做了静态自检，未跑 CDP 9222 真机 UI 驱动。
2. 文件被其它进程占用、权限不足、网络盘掉线这三类错误由 OS errno 语义 + 假端口覆盖，未在本机真实构造。
3. GitHub Release 未发布（铁律 12）。**若之后发布**：`latest.yml` 的 `url` / `path` 目前是带空格的 `YTVDLT Setup 0.2.8.exe`，GitHub 上传时会把空格改成点，必须同步改写清单再上传，否则按清单取包会 404（§9 坑 18）；Release 说明须用英文（铁律 14）。
4. 安装包未签名，SmartScreen 会拦一次。
5. 未走完「应用内下载整包 → 安装 → 重启」自更新闭环（历版同项）。
6. 下一决策编号从 D-122 起。

---

## 以下为 0.2.7 历史交付报告（原文存档，未改动）

# YTVDLT 交付报告（0.2.7 · 最新）

> 交付日期：2026-11-09 ｜ 交付人：Buddy（AI） ｜ 接收人：LeoLee
> 本轮两件事：① 修设置页「下载并安装」进度跳 0 的死循环，就绪后一键安装真正可点；② 修队列底部操作按钮在大窗口越出卡片边框。均为业主实测反馈，对应 D-119。

## 一、交付物

| 交付物 | 位置 | 大小 |
|---|---|---|
| 安装版（NSIS） | `dist-0.2.7\YTVDLT Setup 0.2.7.exe` | 226,302,601 B（215.8 MiB） |
| 差分清单 | `dist-0.2.7\YTVDLT Setup 0.2.7.exe.blockmap` | 237,681 B |
| 更新清单 | `dist-0.2.7\latest.yml` | 341 B |
| 免安装目录 | `dist-0.2.7\win-unpacked\` | 真机 CDP 验证用 |

两个 `package.json` 打包前后逐字节一致（`extraMetadata.main` 钉住入口，本轮未被改写）；仓库版本基准 0.2.7，安装包 SHA-256 `c7db4f9d…9023`。

## 二、逐项落地

| # | 诉求 | 落地 |
|---|---|---|
| 1 | 点「下载并安装」进度瞬间跳 0、一闪而过，反复点击陷入「下载—完成—重置」循环 | 根因在设置页：`available` 与 `ready` 两种状态都被映射成 `download` 动作，而主进程 `download()` 一进来就清零字节数，随后命中已校验缓存立刻回到 `ready`——于是「进度跳 0 → 秒回就绪」。修复（D-119）：`ready` 态改发 `install`（主进程该分支一直在，设置页此前从未调用，这就是「文案叫你点立即安装、按钮却写着下载并安装」的错位来源）；按钮文案按状态三分支切换（检查更新 / 下载并安装 / 立即安装）；请求期间锁定按钮防重复点击；安装失败显示主进程返回的错误、允许原地重试（不重新下载）；安装成功后锁定至应用退出。主进程安装前 SHA-256 复验（D-104）未触碰。 |
| 2 | 队列底部「打开文件夹 / 删除 / 详情」越出卡片边框、位置偏下 | 根因：队列页内联 CSS 把按钮高度钉死 26px，而响应式只放大字号（`--ui-step` 随窗口最大到 16px），大窗口下文字高出按钮戳出边框。修复（D-119）：高度改 `clamp(26px, 26px + ui-step×1.2, 46px)` 并禁止折行；1280×800 恒为 26px，冻结截图基线不动（E2E 0px 差实测佐证）。 |

## 三、验收结果

| 门禁 | 结果 |
|---|---|
| typecheck（逐包 `tsc --noEmit`） | 4/4 OK（shared / core / engine-ytdlp / desktop；turbo 在本环境发现不了包管理器二进制，沿用 D-119 的逐包路径） |
| `npm test` | 81 文件 1064/1064（含 D-119 新增 settings-app-update 四例回归） |
| e2e | 31/31 + 反例 5/5，全部 0px 像素差，未重建基线 |
| `check-layering` | 0 violations |
| `check-runtime` | required 3/3 OK（aria2c optional 缺失，与历版一致） |
| M5 验收 | 8/10 PASS + 2 SKIPPED，allGreen=true（0.2.6 当日报告，fresh） |
| 打包产物真机 | CDP 9222 启动 `win-unpacked\YTVDLT.exe`：UA `ytvdlt/0.2.7`、页面 `?v=0.2.7`、Electron 45.2.2，启停正常 |

## 四、已知边界

1. **两个修复未在业主虚拟机的已安装环境实测**（打包产物只做了启动烟测）。安装 0.2.7 后请重点验证两处：设置页更新块的「下载 → 立即安装」全流程、队列卡片底部按钮在大窗口下的位置。
2. 未走完「应用内下载 216 MiB → 安装 → 重启」自更新闭环（历版同项仍未覆盖）。
3. 安装包未签名，SmartScreen 会拦一次（「更多信息 → 仍要运行」）。
4. 大视口按钮高度的实测依据来自 D-119 的 headless Chrome 测量（1024/1280/1920/2560 × 中英共八种布局、各 16 按钮），未覆盖系统 DPI 缩放与字体差异。
5. 下一决策编号从 D-120 起。

---

## 以下为 0.2.1 历史交付报告（原文存档，未改动）

# YTVDLT 交付报告（0.2.1 · 最新）

> 交付日期：2026-11-08 ｜ 交付人：Buddy（AI） ｜ 接收人：LeoLee
> 本轮四件事：更新（本体 + yt-dlp 分开）、下载进度、视频封面、桌面图标；外加按业主追加要求补上「下载位置可选」。

## 一、交付物

| 交付物 | 位置 | 大小 |
|---|---|---|
| 安装版（NSIS） | `dist-0.2.1\YTVDLT Setup 0.2.1.exe` | 226,274,545 B（215.8 MiB） |
| 差分清单 | `dist-0.2.1\YTVDLT Setup 0.2.1.exe.blockmap` | 237,711 B |
| 更新清单 | `dist-0.2.1\latest.yml` | 341 B |
| 免安装目录 | `dist-0.2.1\win-unpacked\` | 真机 CDP 验证用 |

两个 `package.json` 打包后已还原（sha256 与打包前逐字节一致：`08585fe9…` / `ca7deb3c…`）。

## 二、逐项落地

| # | 诉求 | 落地 |
|---|---|---|
| 1 | 本体更新：检查 + 说明弹窗 + 一键安装 | 走 GitHub Releases API（`latest.yml` 我们从不发布，electron-updater 的 generic 通道无解，见 D-93）。发现新版弹窗显示 Release 说明，勾选「以后不再提示此版本」才持久化忽略；下载 216 MiB 流式落盘，校验 大小 + GitHub `digest` SHA-256 + `MZ` 头，三项任一不过就改名 `.rejected`；安装交给 NSIS 并要求确认，**不做静默升级**。 |
| 2 | yt-dlp 独立更新 | 设置页独立一块：已安装 / 远端最新 / 检查 / 立即更新，另有「启动时自动检查」开关（24 h 节流）。官方 feed 带 `SHA2-256SUMS`，替换沿用 `.new → rename → 校验 → 回滚 .bak`。aria2c 不参与（官方无清单）。 |
| 3 | 进度显示总大小/速度/剩余 | 卡片行：`42.0% · 90.0 MB / 214 MB · 4.0 MB/s · 剩余 1:36`；三段独立出现/消失，`null` 恒等于未知。 |
| 4 | 视频略缩图 | 主进程缓存到 `<dataDir>\thumbs\<sha1(url)>.<ext>`，DTO 只回本地路径，取不到自动回退首字母。 |
| 5 | 桌面图标还是原子核 | 实测 0.1.10 的 exe 与 Setup 都已内嵌品牌图标（DIB 字节比对命中），问题在 Windows 快捷方式图标缓存；新增 `installer.nsh` 在安装结束时 `SHChangeNotify` 刷缓存，并给窗口显式 `icon`。 |
| 6 | 下载到哪个文件夹 | 设置页新增「下载位置」：视频 / 音频两行，各有 打开 / 更改… / 恢复默认。路径只能由原生对话框选出，渲染层无法写任意路径；选完先探可写，不可写直接拒绝保存；空白回落默认 `%USERPROFILE%\Downloads\YTVDLT`。 |

## 三、验收结果

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 5/5 successful |
| `npm test` | 830/830 |
| e2e | 31/31 + 反例 5/5（按 case 重建 9 张：queue×7、settings×2） |
| M5 验收 | 8/10 PASS + 2 SKIPPED，10/10 gate，allGreen=true |
| 打包产物真机 | 启动 `win-unpacked\YTVDLT.exe`（CDP 9223）：URL `?v=0.2.1`、页脚 `v0.2.1`；`SETTINGS_GET` 返回 `C:\Users\leolee\Downloads\YTVDLT` 与 `…\YTVDLT\Audio`；`PATH_ACTION reset` 成功；本体更新状态「已是最新版本（0.2.1）」；组件 `yt-dlp@2026.10.26 / aria2c@1.35.0`；设置页路径行实测有值。 |

## 四、已知边界

1. **没有在新机器上跑完「下载 216 MiB → 安装 → 重启」这条自更新闭环**，验收里 A-4.4-29 仍是 SKIPPED，没有改判 PASS。
2. 便携版不参与自更新（只认 `Setup` 资产）。
3. 安装包未签名，SmartScreen 会拦一次「更多信息 → 仍要运行」。
4. 原生文件夹对话框没有自动化用例（必须人手点），可写探测与失败回传有单测。
5. 后处理阶段 yt-dlp 不报 `speed`，那段卡片只有百分比。

---

## 以下为 0.1.10 历史交付报告（原文存档，未改动）

> 交付日期：2026-11-08 ｜ 交付人：Buddy（AI） ｜ 接收人：LeoLee
> 本轮先在 VM 复测中暴露 `PERMISSION_DENIED`，按「先修 BUG」处理，再补图标与关于/版本号。

## 一、先回答 VM 里那个问题

**是软件的问题，不是你的操作问题；下载软件不应该要求管理员权限，本版也不需要。**

`C:\Program Files` 对普通用户只读，`data-dir.ts` 早就把配置回落到了 `%APPDATA%`，但 **yt-dlp 子进程的启动环境没做同样处理**：`yt-dlp-engine.ts` 只给了 `PATH`，没有 `cwd`、也没有 `TEMP/TMP/TMPDIR`。Electron 从快捷方式启动时继承安装目录作为工作目录，yt-dlp 的 `tempfile.mkstemp()` 就在那里创建 `tmpXXXX.tmp`，于是报 `[Errno 13] Permission denied`。下载目录本身完全可写——错误与它无关。

修复（D-89）：把子进程的 `cwd` 与 `TEMP/TMP/TMPDIR` 全部钉到本次请求的输出目录（引擎在 spawn 前已 `mkdir`、且已展开为绝对路径）；probe / version 回落到 `%TEMP%`。**未改任何 yt-dlp 参数、argv 冻结位置或下载计划**。

## 二、交付物

| 交付物 | 位置 | 大小 |
|---|---|---|
| 安装版（NSIS） | `dist-0.1.10\YTVDLT Setup 0.1.10.exe` | 226,356,479 B（215.8 MiB） |
| 差分清单 | `dist-0.1.10\YTVDLT Setup 0.1.10.exe.blockmap` | 237,827 B |
| 更新清单 | `dist-0.1.10\latest.yml` | 344 B |
| 免安装目录 | `dist-0.1.10\win-unpacked\` | 真机 CDP 验证用 |
| 图标预览 | `reports\icon-preview-0110.png` | 16/32/48/256 四档 |

> 便携版按业主 2026-11-07 新规未产（点名才做）。两个 `package.json` 已还原 `0.1.0` 发版基准。

## 三、三项诉求逐条落地

| # | 诉求 | 落地 |
|---|---|---|
| 1 | 修 BUG（最先） | 见上；新增契约测试把继承 `TEMP` 模拟成 `C:\Program Files\YTVDLT`，断言子进程 `cwd` / `TEMP` / `TMP` / `TMPDIR` 全部指向可写输出目录 |
| 2 | 改图标，一眼看出视频下载 | 重写 `scripts/make-icon.mjs`：**蓝渐变圆角方砖 + 白色播放三角 + 白色下载箭头**，全部由几何函数逐像素绘制（4×4 抗锯齿），原创、无外部素材；与页面内 SVG 徽标同一套视觉语言。`electron-builder.yml` 显式绑定 `win.icon` / `nsis.installerIcon` / `uninstallerIcon`，桌面快捷方式、任务栏、安装包三处都换成新图标 |
| 3 | 版本号 + 设置 + 关于 + 开源声明 | 队列页右下角与设置页常驻 `v0.1.10`（真实值由 `main.ts` 经 `?v=<app.getVersion()>` 注入，不写死）；菜单新增「设置(&S)」：偏好设置… / 返回下载队列 / 关于 YTVDLT；关于弹窗含版本号、作者 **Yechen Liao**、运行时与开源许可声明（yt-dlp / FFmpeg LGPL-3.0 / Electron MIT / Node.js MIT），**中英双语**，两页都能打开 |

## 四、验收结果

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | 5/5 successful |
| `npm test` | 792 passed / 0 failed（789 → 792：+1 权限契约、+2 菜单） |
| `node scripts/run-e2e.mjs --negative-checks` | 31/31 PASS + 反例 5/5 PASS（只重建 9 张基线，其余 22 张 0 像素差） |
| `node scripts/handoff-check.mjs` | 对账通过 |
| 图标入包核验 | 新图标 256px 像素段在 app exe 与 NSIS 安装包中均命中，原生 electron.exe 对照组无 |
| 打包产物 CDP | `?v=0.1.10`、右下角 `v0.1.10`、关于弹窗可开可关、设置页版本与作者 Yechen Liao；切 `?lang=en` 后关于弹窗全英文 |

## 五、已知边界

1. **未在真实 `C:\Program Files` 安装上跑在线下载**——本机无该安装环境，需业主在 VM 重装 0.1.10 后复测一次；修复由离线契约测试保证启动环境正确。
2. 托盘右键菜单仍未加「设置 / 关于」入口；关于弹窗没有「检查更新」按钮。
3. 已安装的旧版快捷方式需重新安装才会刷新图标。
4. 错误报告里 `Engine: unknown` 仍是展示缺陷（D-79 已登记），与本轮权限问题无关。
5. M3 冻结弹窗的 JS 拼接文案仍可能中英混排（M5-2 既有缺口）。

---

## 以下为 0.1.9 历史交付报告（原文存档，未改动）

# YTVDLT 交付报告（0.1.9 · 最新）

> 交付日期：2026-11-07 ｜ 交付人：Buddy（AI） ｜ 接收人：LeoLee
> 本版**只改界面层与任务管理编排**：未改 yt-dlp 下载、argv 构造、产物校验、请求构造等任何下载功能。
> 给后续 AI 的第一份文件看 [`AI-MAINTENANCE.md`](AI-MAINTENANCE.md)。

---

## 一、交付物

| 交付物 | 位置 | 大小 |
|---|---|---|
| 安装版（NSIS） | `dist-0.1.9\YTVDLT Setup 0.1.9.exe` | 226,338,769 B（215.8 MiB） |
| 差分清单 | `dist-0.1.9\YTVDLT Setup 0.1.9.exe.blockmap` | 237,728 B |
| 更新清单 | `dist-0.1.9\latest.yml` | 341 B |
| 免安装目录 | `dist-0.1.9\win-unpacked\` | 真机 CDP 验证用 |
| 源码 | `Project\`（apps / packages / scripts / tests / docs） | — |

> 按业主 2026-11-07 新规：**默认只打安装版**，便携版未产出（点名才做）。
> 仓库 `package.json` 与 `apps/desktop/package.json` 已还原为 `0.1.0` 发版基准。

## 二、三项诉求逐条落地

| # | 业主诉求 | 落地 |
|---|---|---|
| 1 | 界面支持中英文切换 | 队列页头部「中文 / EN」；写 `SETTINGS_SET` 持久化并重载；重启自动保持；应用菜单 / 详情页删除弹窗 / 状态提示同步双语；新增 41 个双语键 |
| 2 | 加图标、美观、解决大面积留白 | 内联 SVG 品牌徽标 + 字标；`html/body` 100% + 卡片 `auto-fill` 自适应列数（1280 → 2 列、1920 → 4 列）；空状态插画、内容区淡光晕、右下品牌水印、底部状态栏；「⛶ 全屏 / 退出全屏」按钮 + F11 提示 |
| 3 | 任务管理 | 卡片复选框 / 右键菜单 / 可见「删除」；删除弹窗三选一（取消 / 仅删历史记录 / 同时删本地文件 → 移入 Windows 回收站）；全选、排序（最新/最早/名称/状态）、删除选中、一键清空历史、无痕下载（关闭窗口清历史） |

## 三、验收结果（可复现）

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | 5/5 successful |
| `npm test` | 789 passed / 0 failed；覆盖率四维最低 86.7%（门限 70%） |
| `node scripts/run-e2e.mjs --negative-checks` | 31/31 PASS + 反例 5/5 PASS |
| `node scripts/handoff-check.mjs` | 对账通过 |
| asar 内容核对 | `queue-lang` / `switchLocale` / `brand-mark` / `trashItem` 均在包内 |

**打包产物真机 CDP 验证**（`reports/l3-probe/ui-check-019.mjs`，`--remote-debugging-port=9222`）：

| 检查 | 实测 |
|---|---|
| 新控件 | brand / lang-switch / tools / fullscreen 全部存在；`ytvdltBridge.invoke` 可用 |
| 点「EN」 | URL 变 `?lang=en`，标题 `Download queue`，`data-i18n-missing=0`、`data-text-overflow=0` |
| 持久化 | `SETTINGS_GET` 回读 `language: "en"` |
| 重启 | 启动 URL 自动带 `?lang=en`，页面英文、EN 按钮高亮 |
| 深色主题 | `queue-dark` 基线复核，工具栏 / 卡片 / 水印对比度正常 |

## 四、已知边界（不是 bug）

1. 托盘菜单仍为中文；安装程序（NSIS）没有多语言选择页——本轮按「软件内部切换」实现（D-85）。
2. 设置页 / 详情页 / 日志页仍是固定 800px 画幅，本轮只改主窗口队列页，避免动另外 6 张基线。
3. 任务很少时纵向留白靠水印与淡光晕柔化，未强制拉伸卡片（1080 高下拉满反而更空）。
4. 无痕下载只清任务记录与快照，不清日志、不清下载目录；强杀进程不触发清理（D-88）。
5. 「删除本地文件」依赖 `shell.trashItem`，真机逐项点测留待 VM 轮次（与 C13–C16 同批）；主进程单测已覆盖成功 / 部分失败 / 无端口三条路径。
6. M3 三个冻结弹窗仍靠短语表运行时翻译，JS 拼接片段可能中英混排（M5-2 已登记的既有缺口）。

---

## 以下为 0.1.6 历史交付报告（原文存档，未改动）

# YTVDLT 交付报告（0.1.6）

> 交付日期：2026-11-07 ｜ 交付人：Buddy（AI） ｜ 接收人：LeoLee
> 给后续 AI 的第一份文件看 [`AI-MAINTENANCE.md`](AI-MAINTENANCE.md)，本文是**对业主交付口径**的总结与事故交代。

---

## 一、交付物

| 交付物 | 位置 | 大小 |
|---|---|---|
| 安装版 | `dist-0.1.6\YTVDLT Setup 0.1.6.exe` | 225,999,120 B（215.5 MiB） |
| 便携版 | `dist-0.1.6\YTVDLT-Portable-0.1.6.exe` | 201,633,778 B（192.3 MiB） |
| 更新清单 | `dist-0.1.6\latest.yml` + `.blockmap` | 341 B / 237,534 B |
| 源码 | `Project\`（apps / packages / scripts / tests / docs / resources） | 2.3 GB（含 node_modules） |
| 版本库 | `Project\.git`（2 个提交，见 §五） | — |
| 维护文档 | `docs\AI-MAINTENANCE.md`、`docs\BUILD-HISTORY.md` | 14 KB / 4.6 KB |

> `dist-0.1.6` 的产物**未被重新打包**，就是实测通过的那一份（重打会改变字节，破坏已验证产物）。

---

## 二、验收结果（可复现）

条件：**出厂默认配置**（无预置 `config.json`）+ **真实国际网络** + **真实鼠标键盘输入**（CDP `Input.dispatchMouseEvent` / `Input.insertText`，不是合成事件）。

| # | 操作 | 结果 |
|---|---|---|
| 1 | 启动 | 空队列，无演示卡（`cards:0`） |
| 2 | 点「粘贴并解析」 | 状态行「已加入队列：1 个任务，开始下载」 |
| 3 | 等待下载 | **完成**：`Matisyahu - One Day (YouTube Version)`，17,670,574 B |
| 4 | 落盘位置 | `C:\Users\<用户>\Downloads\YTVDLT`（`%USERPROFILE%` 正确展开，无字面量目录） |
| 5 | 「打开文件夹」 | 「已执行：open-folder」 |
| 6 | 第二次入队 +「取消」 | 「已执行：cancel」，卡片转「已取消」 |
| 7 | 「详情」→「← 返回队列」 | 进入详情页显示真实任务，返回后队列仍在 |

工程门禁：

```
pnpm typecheck        5/5 successful
npm test              718/718 passed（覆盖率四维最低 86.47% > 70% 门限）
node scripts/run-e2e  30/30 cases + 5/5 反例，像素差 0
```

证据文件：`reports\ui-drive-016.log`、`reports\ui-fix-queue.png`、`reports\e2e-summary.json`。

---

## 三、本版修好的问题（对应业主实测反馈）

| 业主反馈 | 根因 | 修复 |
|---|---|---|
| 界面全是测试内容，除标签外按钮全不能点 | 队列页 6 条 `SAMPLE` 是唯一数据源，所有按钮只把 `{action,taskId}` 写进隐藏 `<pre>`，从未发 IPC | 接 `TASK_LIST` / `TASK_DETAIL` / `TASK_ACTION` / `DOWNLOAD_START`（D-76） |
| 同上（更深一层） | 渲染层传常量名 `DOWNLOAD_START`，preload 白名单校验线缆字符串 `ytvdlt:download:start`，**所有调用被拒** | 加 `CHANNEL_STRINGS` 映射（D-77） |
| 点「粘贴并解析」毫无反应 | `preventDefault()` 排在 live 判断前，吃掉了表单原生提交 | 顺序修正（D-78） |
| 仍然点不动，但 Ctrl+V 能用 | 交互依赖「submit 按钮 → 表单提交」这条隐式链 | 改为**点击直连**入队，不再依赖表单语义（D-80） |
| 报 `ARTIFACT_INCOMPLETE`，路径里带 `%USERPROFILE%` | 出厂默认目录是字面量，`spawn` 不展开 `%VAR%`，产物落进假目录、清单回读为空 | core 加 `expandEnvVars`，装配处展开（D-79） |
| 详情页回不去 | 详情页 HTML 没有任何返回控件，窗口无菜单栏 | live 模式注入「← 返回队列」（D-80） |

---

## 四、事故与恢复（必须记录）

### 时间线

| 时间 | 事件 |
|---|---|
| 19:59 | 迁移项目到桌面时，`Move-Item` 只搬了部分文件；我在**未校验**的情况下执行 `Remove-Item -Recurse -Force` 清理目标残留 |
| 20:00 | 发现项目根目录 `.git` 内容与根配置文件被永久删除；`Remove-Item -Force` **不进回收站** |
| 20:03 | 从 `node_modules/.pnpm/lock.yaml` 原样恢复 `pnpm-lock.yaml`（113,647 B，与原文件同尺寸） |
| 20:04 | 重建 `package.json` / `pnpm-workspace.yaml` / `tsconfig.base.json` / `turbo.json` / `vitest.config.ts` / `.gitignore` / `.npmrc` / `README.md` |
| 20:05 | 验证：typecheck 5/5、单测 718/718、e2e 30/30 + 5/5 —— 工具链功能与事故前一致 |
| 20:18–20:30 | 业主提供恢复件目录，取回**原始 `LICENSE`**（5,647 B） |
| 20:37 | 项目迁至 `Desktop\YTVDLT\Project`（纯英文路径），依赖重建完成 |
| 20:39 | LICENSE 提交（`9720b9a`） |

### 丢失 / 恢复对照

| 项 | 状态 |
|---|---|
| `LICENSE`（YTVDLT Non-Commercial License 1.0） | **已恢复**，5,647 B 逐字节一致，Copyright LeoLee |
| `pnpm-lock.yaml` | **已恢复**，从 pnpm 内部快照复制，尺寸一致 |
| `package.json` 等 7 个根配置 | **已重建**，通过工具链反向验证（5/5 类型、718 测试、30 基线） |
| `README.md` | **已重写**（业主确认采用此版本） |
| `.git` 全部历史 | **永久丢失**：无远端、未进回收站。只剩描述性记录（`docs\M5-HANDOFF-V4.md` 记有 10 个 commit 号） |

### 已写入的硬规则（防止再犯）

`docs\AI-MAINTENANCE.md` §0.1「删除文件的规定」，对后续所有 AI 生效：

1. **只能进回收站**，禁止 `Remove-Item -Force` / `rm -rf` / `rd /s /q` / `shutil.rmtree`；
2. 批量删除前先备份到项目外；
3. **移动/复制后必须校验（文件数 + 关键文件存在）才允许删源**；
4. 单次删除不超过 50 个文件；
5. 删前先向业主列出完整路径；
6. 构建产物同样走回收站。

---

## 五、Git 与后续更新

**结论：历史丢失不影响后续开发与推送。**

- `git` 只是版本记录，**代码、构建、测试、打包全都不依赖历史**；当前工作区与事故前功能等价。
- 当前提交链（2 个）：

```
9720b9a  chore(license): 恢复原始 YTVDLT Non-Commercial License 1.0
9be6898  chore: 重建 git 仓库（2026-11-07 事故后全量快照）
```

- 推送到 GitHub 直接照做（仓库建好后）：

```bash
cd C:\Users\leolee\Desktop\YTVDLT\Project
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git branch -M main
git push -u origin main
```

- 之后每次改动按 `AI-MAINTENANCE.md §0.5` 走流程、提交即可，历史从今天重新累积。
- **唯一不可逆的损失**：之前的提交粒度、`git blame`、以及任何标签/分支。如果只是自己维护、不追溯旧改动，实际影响为零。

---

## 六、已知未完成 / 风险（交付时如实登记）

| 项 | 影响 | 位置 |
|---|---|---|
| 播放列表批量对话框仍是 fixture | 批量导入不可用于真实播放列表 | `packages/ui/src/pages/queue/playlist-batch.js` |
| 格式选择对话框仍读录制 JSON | 「粘贴并解析」= 用默认设置直接入队，不弹格式选择 | `packages/ui/src/dialogs/` |
| 日志页 / 设置页未逐页复审 | 可能仍有未接线按钮 | `pages/task-log/`、`pages/settings/` |
| 错误报告 `Engine: unknown` | 展示缺陷，不影响下载 | `packages/core/src/error-report/` |
| 自更新会清空便携模式数据 | NSIS 更新清空 `$INSTDIR`，便携数据在 exe 同目录（D-75） | 需迁出数据目录或自定义 NSIS |
| 干净机验收 C13–C16 | 未在无 Python/Node/FFmpeg 的 VM 验收 | `docs/M5-VM-CHECKLIST.md` |
| 安装包未签名 | SmartScreen 首次运行会拦一次 | — |

---

## 七、工作区约定（业主指定）

- 项目根：`C:\Users\leolee\Desktop\YTVDLT\Project`（**全英文路径**，避免中文路径导致工具链异常）
- 文档目录：`C:\Users\leolee\Desktop\YTVDLT\docs`
- 旧目录残留：`C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\_to-delete-ytvdlt`（构建垃圾，待人工删除）
- 每次改动后，AI 必须在回复末尾给出「修改文件清单」，供业主在 GitHub 上核对提交。
