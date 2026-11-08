# AI 维护手册（YTVDLT Desktop）

> 给下一个接手的人／AI：不看任何历史报告，也能在十分钟内知道
> **项目是什么、文件夹干什么、改哪个文件、先排查哪里、改完怎么验、验完交什么**。
>
> **本手册只写不会过期的结构知识**：路径、命令、规则、契约、分诊顺序。
> 版本号、测试数、覆盖率、PASS 数、交付状态、某版实测结论一律**不写**——它们每天在变，
> 抄进来就必然腐烂。版本流水在 `CHANGELOG.md`，决策原文在 `DECISIONS.md`。
>
> 平台：Windows 10/11 x64（Electron 45 + yt-dlp 随包）。
> 一句话：**Electron 桌面下载器；前端零依赖静态页，主进程只做编排，真正的下载交给随包的 yt-dlp。**

---

## 0. 维护铁律

**每次改完代码，必须在回复末尾输出「修改文件清单」**（业主据此提交）：

```
### 修改文件清单
| 文件 | 改动 | 影响 |
|---|---|---|
| packages/ui/src/pages/queue/queue.js | 修 X | 队列页按钮 |
| docs/DECISIONS.md | 追加 D-xx | 决策记录 |
（未改动的不列；新增文件标「新增」）
```

1. **不要动 `packages/shared/src/request.ts`**（D-50 冻结，逐字节锁定）。
2. **不要往 `devDependencies` 加新依赖**（D-61 白名单只允许 `electron-builder` / `electron-updater`）。
3. **不要改 `apps/desktop/electron-builder.yml` 的 `files` glob**。要加文件进包，走 `extraResources` 或用 esbuild 内联（D-75）。
4. **不要在别人的原稿／文档里加「由 AI 生成」之类声明。**
5. **改行为必须留决策记录**：`docs/DECISIONS.md` 追加 `## D-<下一编号> · 日期 · 标题`，写「现象／根因／决策／验证／未覆盖」。
6. **不要把 `SKIPPED` 改成 `PASS`**，除非前置条件真做完了。
7. **删除文件只能进回收站，禁止永久删除**（细则见 §0.1）；应用内「同时删除本地文件」也必须走 `shell.trashItem`。
8. **改 UI 后不得全量覆盖截图基线，也不得改结论迁就新 UI**：按 §7 的「按 case 重建」流程做，并在 `DECISIONS.md` 写明重建范围。
9. **默认只打安装版**（`--win nsis`）。便携版与更新清单属点名项，业主说「打包」才跑；不要主动打包（一次约 5 分钟）。
10. **改了本手册或 `BUILD-HISTORY.md` 要同步外层阅读副本**：业主在 `C:/Users/leolee/Desktop/YTVDLT/docs/` 放了副本，两边不一致会让人拿着旧规则干活。
11. **版本号按 §7 的十进制进位规则取**，任一段都不写两位数；发版前查 `CHANGELOG.md` 确认下一版号。
12. **维护完成后不要主动推送仓库或发布 Release**。等业主明确说「上传仓库」/「发布 release」再执行；执行后把仓库地址、分支、提交号与上传方法一起交给业主或下一位接手者（见 §11）。推送和发布是对外动作，不是收尾的自动步骤。
13. **`README.md` 与 `README.zh-CN.md` 必须同时改**（D-100）：英文是默认门面，中文是镜像，两份章节一一对应、顶部各有语言切换行。只改一份等于制造两种真相；`docs/assets/` 里的截图随之更新时也要确认两份引用一致。
14. **GitHub Release 说明一律用英文**：Release 页面是仓库门面，面向国际读者；中文只写进 `CHANGELOG.md` / `DECISIONS.md` 这类内部文档。发版时把英文说明贴进 Release，不要把中文正文直接发出去（`DECISIONS.md` 里的 D-xx 编号可以保留，作为可追溯的括注）。

### 0.1 删除文件的规定（一次真实事故换来，不可协商）

事故：迁移目录时未校验就 `Remove-Item -Force` 清理残留，把 `.git` 与根目录配置永久删除，
`LICENSE` 和 git 历史至今未找回。`Remove-Item -Force` / `rm -f` **不进回收站**。

任何删除必须同时满足：

1. 只能进回收站：用 `Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile/DeleteDirectory` +
   `RecycleOption.SendToRecycleBin`。**禁止** `Remove-Item -Force`、`rm -f/-rf`、`rd /s /q`、`shutil.rmtree`。
2. 先备份到项目外临时位置，确认新位置可用再删。
3. 移动/复制后**校验再删源**：核对文件数与 `package.json`、`.git/HEAD`、`LICENSE` 存在。
4. 单次删除 ≤ 50 个文件（本机 safe-delete 守卫阈值）。
5. 删前列完整路径给业主确认，尤其 `.git`、`LICENSE`、`docs/`、`resources/`。
6. 构建产物（`dist-*/`、`coverage/`、`node_modules/`）虽可再生，**同样走回收站**。

---

## 1. 先自证，再看文档

```bash
ls package.json pnpm-workspace.yaml turbo.json apps packages scripts   # 缺一个就说明目录不对
git log -1 --oneline                                                 # 最近一次提交
node -e "console.log(require('./package.json').version)"              # 仓库版本（打包后回到发版基准）
```

**事实来源优先级（冲突时按此采信）**

1. 代码本身（`grep` 出来的实现）
2. 当场跑出来的结果（`npm test` / `run-e2e.mjs` / `handoff-check.mjs`）
3. 代码注释里的决策编号 `D-xx`
4. `docs/DECISIONS.md`
5. `docs/*-REPORT.md`（历史快照，**大概率已过期**）

文档里的数字一律只是当日快照，引用前现跑一次。`node scripts/handoff-check.mjs` 会把文档数字
和仓库现状对账；**它报不一致就是文档旧了，改文档，不要改结论**。

---

## 2. 目录地图（每个文件夹干什么）

```
ytvdlt/
├── apps/desktop/                  # Electron 唯一可执行外壳
│   ├── src/main/                  # 主进程：窗口、托盘、菜单、IPC 编排、宿主装配
│   ├── src/preload/               # contextBridge 白名单（渲染层唯一出入口）
│   ├── src/main/adapters/         # 真实 node/electron 能力注入（CorePorts 实现）
│   ├── electron-builder.yml       # 打包配置：files / extraResources / nsis / publish / 图标
│   ├── build/icon.ico             # 应用 / 安装包 / 快捷方式图标（由脚本生成）
│   └── dist/                      # 【生成】build-desktop 产物，会被打进 asar
├── packages/
│   ├── shared/                    # 纯类型 + 常量：IPC 通道、请求/任务/错误/更新契约
│   ├── core/                      # 纯逻辑（禁 node:*）：队列、校验、路径、配置、错误映射
│   ├── engine-ytdlp/              # yt-dlp 适配：argv、进度解析、产物清单、子进程启动环境
│   └── ui/src/                    # 零依赖静态前端：pages / styles / i18n / theme / dialogs / about
├── resources/runtime/win-x64/     # 随包二进制：yt-dlp / ffmpeg / aria2c / node（不进 git）
├── scripts/                       # 构建、测试、验收、烟测脚本（见 §7）
├── tests/                         # unit / contract / integration / e2e（截图基线在 e2e/baselines）
├── docs/                          # 设计、决策、里程碑报告、本手册、版本流水
├── reports/                       # 【不入库】本地证据：烟测 JSON、截图、日志
└── dist-<version>/                # 【不入库】当前交付包（Setup + blockmap + latest.yml）
```

**依赖方向（单向，`check-layering.mjs` 会拦）**

```
ui（零依赖） ← preload ← apps/desktop
                 ↑
      shared ← core ← engine-ytdlp
```

`core` 里禁止 `node:fs` / `node:child_process` / `electron`；外部能力一律经 `CorePorts` 注入。

---

## 3. 功能 → 代码位置（最常改的重点文件）

| 要改的功能 | 先打开 |
|---|---|
| 队列页：渲染、轮询、按钮、语言切换、任务管理、全屏 | `packages/ui/src/pages/queue/queue.js` + 同目录 `index.html`（版式与内联 CSS） |
| 所有界面文案（中/英） | `packages/ui/src/i18n/messages.js`（双语键集合必须一致）、`i18n/i18n.js` |
| 版本号 / 关于弹窗 / 开源声明 | `apps/desktop/src/main/main.ts`（注入 `?v=`）、`packages/ui/src/about/about.js` |
| 主题、强调色、动效 | `packages/ui/src/theme/theme.js`、`styles/theme.css`；共享基线样式 `styles/ytvdlt.css` |
| 应用菜单（文件/编辑/视图/窗口/设置） | `apps/desktop/src/main/app-menu.ts`（纯数据）→ `bootstrap.ts` 安装与重建 |
| 窗口、托盘、单实例、菜单跳转、关闭清理 | `apps/desktop/src/main/bootstrap.ts` |
| 生产依赖装配、回收站删除、无痕清理、真实入口 | `apps/desktop/src/main/electron-entry.ts` / `main.ts` |
| IPC 通道白名单、payload 校验、设置读写 | `apps/desktop/src/main/m5-channels.ts`；装配在 `m5-host.ts` / `m4-host.ts` |
| 粘贴入队、格式选择落到下载请求 | `m5-channels.ts` → `m4-host.ts::applyFormatChoice` / `enqueueSingle` |
| 下载计划、清晰度、音频码率、私有模式 | `packages/core/src/decision/download-plan.ts`、`config-store/defaults.ts` |
| yt-dlp 参数、进度、产物清单 | `packages/engine-ytdlp/src/argv-builder-download.ts`、`progress-parser.ts`、`artifact-manifest.ts` |
| **子进程启动环境（cwd / TEMP / PATH）** | `packages/engine-ytdlp/src/yt-dlp-engine.ts::spawnBase` —— 任何新 spawn 都从这里取 |
| 产物校验、错误码与中文提示、错误报告 | `core/src/artifact-verifier/`、`shared/src/errors.ts`、`core/src/error-mapper/`、`error-report/` |
| 队列调度、并发、暂停、历史快照 | `core/src/task-queue/`、`task-store/`；数据目录判定在 `data-dir.ts` |
| 详情页、日志页、设置页、M3 三个对话框 | `packages/ui/src/pages/*`、`packages/ui/src/dialogs/*` |
| 打包配置、图标、安装包 | `apps/desktop/electron-builder.yml`、`scripts/make-icon.mjs`、`apps/desktop/build/installer.nsh` |
| **应用本体更新（检查 / 说明弹窗 / 下载校验 / 安装 / 忽略版本）** | `main/app-update-service.ts`、`main/github-releases.ts`、`main/adapters/http-download.ts`；纯规则在 `core/src/app-update/`；弹窗在 `ui/src/updates/update-dialog.js` |
| **yt-dlp 组件更新（版本查询 / 换文件 / 自动检查）** | `main/component-updater.ts`（`feedUrl` / `versionApiUrl`）、`engine-ytdlp/src/self-updater.ts` |
| **队列进度（总大小 / 速度 / 剩余时间）** | `core/src/task-queue/task-queue.ts`（progress 分支）→ `main/m5-channels.ts::toTaskListItem` → `ui/src/pages/queue/queue.js::progressText` |
| **队列封面缩略图** | `main/thumbnail-cache.ts`、`main/m5-channels.ts::ThumbnailPort`、`queue.js::thumbNode` |
| **下载位置（视频 / 音频目录）** | `ui/src/pages/settings/*`（`#section-paths`）→ `main/m5-channels.ts::PATH_ACTION` → `core/config-store/defaults.ts::DEFAULT_PATH_TOKENS`；原生对话框在 `main/adapters/path-picker.ts` |
| **设置页分区目录 + 滚动联动** | `ui/src/pages/settings/index.html`（`.settings-shell` / `.settings-nav` / `.settings-scroll`）、`settings.js::installSectionNav()` |
| 截图基线用例 | `scripts/e2e-cases.mjs`、`tests/e2e/baselines/` |

---

## 4. 常见问题：先排查这几处（分诊表）

> **这是分诊顺序，不是排除法结论。** 像看感冒先抽血：先验高概率、低成本的原因，
> **但前几项排除后必须继续按 §1 的事实来源优先级查代码、查日志、查端口注入**，
> 不能因为「常见的都查过了」就下结论。

| 现象 | 按顺序先查 | 为什么先查它 | 排除后继续 |
|---|---|---|---|
| **按钮点了没反应** | ① 符号名 ↔ 线缆字符串三处映射（§5）② `preventDefault()` 顺序 / 隐式表单提交 ③ live 与 fixture 分支走错 ④ 是否用合成事件「验证」过（会假通过） | 这三类各造成过一次真实事故；成本最低 | 查主进程 handler、`PAYLOAD_KEYS` 白名单、端口是否注入 |
| **下载失败 / 出现错误码** | ① `logs/app-*.jsonl` 里 `ERROR` 与 `scope` ② stderr 原文 ③ `error-mapper` 映射 ④ 产物 manifest 是否为空 | 错误码只是翻译结果，stderr 才是一手证据 | 再查 argv、下载计划、校验器、网络 |
| **装到 `C:\Program Files` 报 `PERMISSION_DENIED` / `tmp*.tmp`** | ① 子进程是否走 `spawnBase()` 拿到可写 `cwd` + `TEMP/TMP/TMPDIR` ② 配置目录是否已回落 `%APPDATA%` ③ 输出目录是否绝对且可写 | 这是启动环境缺陷，**不是用户没开管理员** | 再查具体哪个文件落到只读路径；**绝不要建议以管理员运行绕过** |
| **界面留白 / 样式错乱 / 全屏不自适应** | ① 共享 `ytvdlt.css` 把 `html/body` 钉成固定画幅 ② 本页内联 CSS 是否覆盖 ③ 主题变量 `data-theme` / `data-accent` | 冻结截图基线要求固定画幅，新页面容易继承 | 再查网格列数、overflow、截图基线 |
| **只有中文 / 文案不切换** | ① `?lang=` 有没有传到启动 URL ② 新文案是否两边字典都有键 ③ `data-i18n` 是否被运行时覆盖 | 字典与运行时都在，缺的通常是入口或键 | 再查菜单/托盘是否也跟随语言、`i18n.test.ts` 是否报缺键 |
| **e2e 全红** | ① 是否刚改了 UI（DOM/像素必然变）② 失败 case 的 `dom=true` 是否仍成立 ③ 是否只有预期 case 失败 | 基线是冻结快照，改 UI 不等于改坏 | 按 §6 逐 case 重建；**不要**改松断言或全量覆盖 |
| **打包后界面还是旧的** | ① 是否先跑 `build-desktop.mjs` ② asar 内对应文件是否是新内容 ③ `package.json` 是否被构建改写未还原 | 顺序反了会把上一版前端塞进包 | 再查缓存、`dist/` 与输出目录、图标是否重生成 |
| **改了代码没效果 / 行为异常** | ① `grep` 定位真实实现（别猜文件名）② 是否违反分层 ③ 是否改到了 fixture 分支 | 项目有多处同名的 M3/M4/M5 通道 | 再按 §1 优先级查日志与当场输出 |
| **「检查更新」没反应 / 一直提示失败** | ① `logs/app-*.jsonl` 里 `app-update` 与 `component-check` ② GitHub API 是否可达（`api.github.com/repos/yechenliao0820/YTVDLT/releases/latest`）③ `advanced.autoCheckAppUpdate` / `lastAppUpdateCheckAt` 是否把自动检查挡在节流窗口内 ④ 该版本是否已被「以后不再提示」写进 `advanced.skippedAppVersion` | 更新链路不碰 UI 状态，失败只写日志、不动正在运行的版本 | 再查 Release 资产名是否还能被 `selectInstallerAsset` 认出来（改名成非 `Setup` 且带 portable 字样会被打 0 分） |

---

## 5. IPC 契约（两处必须对齐）

渲染层调用**符号名**，preload 白名单校验**线缆字符串**。映射分布在这三处，漏一处就是「按钮点了没反应」：

- `packages/ui/src/pages/queue/queue.js::CHANNELS`
- `packages/ui/src/pages/task-detail/task-detail.js::CABLE`
- `packages/ui/src/ipc-bridge.js::CHANNEL_STRINGS`

通道常量定义在 `packages/shared/src/ipc.ts`（append-only）；主进程 handler 在 `m5-channels.ts` 与 `ipc-gateway.ts`。

约束：

1. **payload 键白名单**：`m5-channels.ts::PAYLOAD_KEYS` 只放行登记过的键，多一个直接抛错；枚举值越界同样拒收，不会带进 argv。
2. **URL 脱敏**：`TASK_LIST` 不返回 URL；`TASK_DETAIL` 返回 `maskUrlSecrets()` 后的值。新增字段别把原始链接带出去。
3. **删本地文件**：`TASK_ACTION` 的 `withFiles: true` 只允许配 `action: 'remove'`；主进程只取该任务 `artifacts`，经 `TrashFilesPort` 移入回收站，**部分失败保留记录**。
4. **无痕**：`SETTINGS_SET` 的 `privateMode` 只收 boolean，`SETTINGS_GET` 回读；关闭窗口时清任务记录，**不动本地文件**。
5. `PROBE` / `PROBE_PLAYLIST` / `DIALOG_CONFIRM` 仍是 fixture 通道，别当成真实能力。
6. **更新三分家**（D-93 / D-94）：`APP_UPDATE_*` 管应用本体（GitHub Release），`COMPONENT_CHECK` / `COMPONENT_UPDATE` 管随包二进制，`COMPONENT_STATUS` 只读本地版本。`APP_UPDATE_STATUS` 是纯内存读，队列页与设置页都以轮询方式消费，**不要为它加主进程推送**。
7. **`TASK_LIST` 只回本地封面路径 `thumbPath`**：远端缩略图 URL 由主进程缓存成文件，URL 本身永不出主进程（与 URL 脱敏同一条规则）。
8. **`PATH_ACTION` 不接受路径字符串**（D-98）：渲染层只能发 `{action: pick|reset|open, kind: video|audio}`，能写进 `paths.*` 的只有主进程对话框选出来的目录。改这条等于给渲染层开一个"任意写配置路径"的口子。

---

## 6. 数据落在哪

| 运行形态 | 配置 / 日志 |
|---|---|
| exe 目录可写（便携 / 默认安装） | `<exe目录>\config\config.json`、`<exe目录>\logs\app-YYYYMMDD.jsonl` |
| 装到 `C:\Program Files`（不可写） | `%APPDATA%\YTVDLT\config\…`（`data-dir.ts` 写探针实测可写性） |
| 默认下载目录 | 视频 `%USERPROFILE%\Downloads\YTVDLT`、音频 `…\YTVDLT\Audio`（**运行时展开**，spawn 不经过 shell） |
| 用户改过下载目录 | `paths.videoDir` / `paths.audioDir` 存**绝对路径**；未改过则存 token（`%USERPROFILE%/…`），换机器仍跟用户目录走（D-98） |
| 封面缓存 / 更新包 | `<dataDir>\thumbs\<sha1(url)>.<ext>`、`<dataDir>\updates\YTVDLT-Setup-*.exe`（D-93 / D-96） |

`config/config.json` 按域组织：`general / format / subtitle / paths / network / advanced`；
`config/tasks.json` 是队列快照。

---

## 7. 改动流程与文档分工

```
1. grep 定位实现（别猜文件名）
2. 改代码，保持 §2 的分层
3. pnpm typecheck            → 看输出，要求全 successful
4. npm test                  → 看输出，要求 0 failed（覆盖率门限由脚本管）
5. node scripts/run-e2e.mjs  → 看输出，要求全绿 + 反例全 PASS
   改了 UI：先跑一次确认只有预期 case 失败且 dom=true；
   再逐 case `node scripts/run-e2e.mjs --case=<id> --update-baselines`；
   最后全量复验。不要全量 --update-baselines，不要改断言。
6. 动了 UI → node scripts/build-desktop.mjs，再按 §0 铁律 9 打包
            打包后立刻还原被改写的 package.json（见 §9 坑 2）
7. 打包产物真机验证：--remote-debugging-port=9222 启动，用 reports/l3-probe/ 下的驱动
8. docs/DECISIONS.md 追加 D-xx；发版另在 CHANGELOG.md 加一行
9. 回复末尾输出「修改文件清单」（§0 格式）
```

| 改了什么 | 至少重跑 |
|---|---|
| `packages/ui/**` | `build-desktop` + `run-e2e` + 打包后真机点一遍 |
| `packages/core/**` | `typecheck` + `npm test` |
| `packages/engine-ytdlp/**` | `typecheck` + `npm test` + `scripts/l3-smoke.mjs`（真下载） |
| `apps/desktop/src/main/**` | `typecheck` + `npm test` + 打包后真机走一遍 |
| `electron-builder.yml` / 图标 | 重新打包 + 检查 asar、图标、真机启动 |
| 只改 `docs/**` | `node scripts/handoff-check.mjs` 对账 |

**文档分工（写错地方就是制造下一个屎山）**

| 内容 | 唯一去处 |
|---|---|
| 版本、日期、交付状态、某版改了什么 | `CHANGELOG.md` |
| 现象／根因／决策／验证／未覆盖 | `DECISIONS.md`（append-only） |
| 构建产物考据、为什么淘汰某版 | `BUILD-HISTORY.md` |
| 对业主的交付口径、验收结论、已知缺陷 | `DELIVERY-REPORT.md` |
| 打包步骤与环境、打包相关的坑 | `BUILD.md` |
| **路径、规则、契约、分诊顺序** | **本手册** |

### 版本编号规则（十进制进位，业主 2026-11-08 定）

版本号三段 `0.<minor>.<patch>`，**每段是一位十进制数，满 9 向前进位**：

```
0.1.8 → 0.1.9 → 0.2.0 → 0.2.1 → … → 0.2.9 → 0.3.0 → … → 0.9.9 → 1.0.0
```

- **禁止在任一段写两位数**：`0.1.9` 的下一版是 `0.2.0`，绝不写 `0.1.10`。
- 发版前同时改根 `package.json` 与 `apps/desktop/package.json`（两处必须一致）；
  打包后按本节上方步骤 6 还原成发版基准。
- 号必须单调递增且能被 `electron-updater` 按 semver 认成新版本，**不回退、不重号**。
- **当前发到哪一版、下一版取什么号，看 `CHANGELOG.md` 的版本表末行与「版本编号规则与历史例外」一节。**
  本手册不写当前版本号——那是会过期的状态，不属于这里。

收尾一律跑 `node scripts/handoff-check.mjs`；输出不齐说明有文档没跟上。

---

## 8. 脚本一览

| 脚本 | 用途 |
|---|---|
| `scripts/build-desktop.mjs` | esbuild 打包主进程 + preload，拷贝 `packages/ui/src` 到 `apps/desktop/dist`。**改前端后必须先跑** |
| `scripts/make-icon.mjs` | 生成四档 `icon.ico`；改图标后必须重跑并重新打包 |
| `scripts/run-tests.mjs` | vitest 封装（`all --coverage` / `unit` / `contract` / `integration`） |
| `scripts/run-e2e.mjs` | PNG + DOM 基线对比，含反例；`--case=<id>` / `--update-baselines` |
| `scripts/handoff-check.mjs` | 把文档数字与仓库现状对账 |
| `scripts/acceptance.mjs` | 里程碑验收，产出 `reports/acceptance-report-m*.json` |
| `scripts/l3-smoke.mjs` | 打包应用在线烟测（CDP 驱动真实 IPC） |
| `scripts/check-layering.mjs` | 分层依赖检查（core 不许 import `node:*`） |
| `scripts/frozen-gate.mjs` | 冻结门控（`request.ts` 逐字节、package.json 白名单） |
| `scripts/verify-artifact.mjs` | 单个媒体文件的产物校验 |
| `reports/l3-probe/ui-drive.mjs` | 真机 UI 驱动（需 9222 端口） |

---

## 9. 稳定坑（原理，不随版本变）

1. **先 `build-desktop.mjs` 再 `electron-builder`**：后者只是把 `apps/desktop/dist` 塞进 asar，顺序反了包里就是旧前端。
2. **electron-builder 会就地改写根 `package.json`**（丢 `scripts` / `devDependencies`、写 `main`）：打包后必须还原；带 `publish` 块时靠 `extraMetadata.main` 钉住入口。
3. **用户路径里的 `%VAR%` 必须运行时展开**：spawn 不经过 shell，否则生成字面量目录并导致产物为空。
4. **验证要用真实输入事件**（`Input.dispatchMouseEvent` / `Input.insertText`），不要用 `dispatchEvent(new Event(...))`——合成事件会稳定地骗过测试。
5. **打包可能被本机 safe-delete 守卫超时打断**：Setup 已产出而其它 target 缺失、`exit=1` 时，原样重跑同一条命令即可；**不要 rm -rf**。
6. **真机 CDP 启动报 `bad option: --remote-debugging-port=...`**：会话继承了 `ELECTRON_RUN_AS_NODE=1`，Electron 被当成 Node。启动前用 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS ./YTVDLT.exe --remote-debugging-port=9222`。
7. **任何子进程 spawn 都要带可写 `cwd` 与 `TEMP/TMP/TMPDIR`**：装到只读目录时，缺了它们 yt-dlp 的临时文件会落到安装目录。不要自己拼 `env: { PATH }`。
8. **改 UI 后截图基线必然变**，这是预期；处理方式见 §7，不是「测试坏了」。
9. **桌面图标是 shell 缓存问题，先证明打包没坏**：把 `build/icon.ico` 里 256 档的 DIB 载荷（跳过 40 字节头）在 `dist-<ver>/win-unpacked/YTVDLT.exe` 里搜一遍，命中就说明 `win.icon` 已生效，别再改打包配置；接着看 `build/installer.nsh`（`SHChangeNotify` 刷缓存）是否被执行，最后才是 `ie4uinit.exe -show` 或删快捷方式重装。
10. **设置页的滚动发生在内层 `.settings-scroll`**：目录要跟着高亮，就必须用内层 `scrollTop` 而不是文档滚动；并且**底部要留出 `max(140px, 60vh)` 的空白**，否则最后两个分区永远滚不到探针线，点「关于」会停在高亮「下载位置」的位置（D-99）。首帧 rect 不可信，`load` + `ResizeObserver` 各复测一次。
11. **yt-dlp 不会覆盖同名文件**：第二次下载只会打印 `has already been downloaded` 并退出 0，应用随后拿到的是**旧文件**。要让用户「再存一份」，必须在 spawn 之前把 ` (n)` 插进 `-o` 模板（`TaskQueue.withCopySuffix()`），而不是事后改历史（D-101）。同理：这种情况**不能判 Error**，文件在盘上、校验也过了。

分诊顺序与这些坑的对应关系见 §4；**§4 给顺序，本节给原理，不重复叙述事故经过**。

---

## 10. 已知未完成（接手时别当成 bug）

| 项 | 位置 |
|---|---|
| 播放列表批量对话框仍是 fixture，未接真实批量入队 | `ui/src/pages/queue/playlist-batch.js`、`ipc-gateway.ts` |
| 逐格式选择对话框仍读录制 JSON（`PROBE` 是 fixture） | `ui/src/dialogs/` |
| 错误报告里的 `Engine: unknown`（展示缺陷） | `core/src/error-report/` |
| 自更新会清空便携模式数据（NSIS 清空 `$INSTDIR`） | 需迁出数据目录或自定义 NSIS 脚本 |
| 干净机验收、部分 `SKIPPED` 验收项（按规则不改判） | `docs/M5-VM-CHECKLIST.md`、`scripts/acceptance.mjs` |
| 托盘菜单与 NSIS 安装向导未双语；托盘右键无「设置/关于」 | `apps/desktop/src/main/tray.ts` |
| M3 弹窗里 JS 拼接的文案可能中英混排 | `ui/src/i18n/messages.js::PHRASES` |
| 便携版不参与自更新（只认 `Setup` 资产，`-portable` 被打 0 分） | `core/src/app-update/release.ts::selectInstallerAsset` |
| 缩略图缓存按 URL 哈希去重但从不清理 | `apps/desktop/src/main/thumbnail-cache.ts` |
| 后处理（合并/转码）阶段没有速度与剩余时间（引擎不报 `speed`） | `ui/src/pages/queue/queue.js::progressText` |
| 应用更新没有差量下载，每次整包（约 216 MiB） | `apps/desktop/src/main/adapters/http-download.ts` |
| 删本地文件、只读目录安装的在线下载，仍待目标环境真机复测 | §4 分诊表对应行 |

> 这张表会随开发推进变短。**完成一项就删一行**，不要留着写「已做」——那是本手册最容易腐烂的地方。

---

## 11. 文档索引与检索

| 想了解 | 看哪份 |
|---|---|
| **版本流水（某版改了什么）** | `docs/CHANGELOG.md` |
| **给外部看的产品门面（安装 / 构建 / 功能）** | `README.md`（英，默认）与 `README.zh-CN.md`（中，镜像）；截图在 `docs/assets/` |
| 做过哪些决策、为什么 | `docs/DECISIONS.md`（最新编号看 `handoff-check.mjs` 输出） |
| 构建产物考据 / 淘汰版本 | `docs/BUILD-HISTORY.md` |
| 对业主的交付口径 / 验收结论 | `docs/DELIVERY-REPORT.md` |
| 打包步骤与环境 | `docs/BUILD.md` |
| 验收口径、架构演进、里程碑交接 | `docs/ACCEPTANCE.md`、`ARCHITECTURE-*.md`、`M*-HANDOFF-*.md` |
| 历史报告 `docs/*-REPORT.md` | **可能已过期**，只作线索，不作结论 |

```bash
grep -rn "ytvdlt:task:action" apps packages        # 某个 IPC 通道的实现
grep -rn 'data-action="cancel"' packages/ui/src    # 某个按钮的绑定
grep -rn "ARTIFACT_INCOMPLETE" packages            # 某个错误码从哪来
grep -n "D-89" -A 20 docs/DECISIONS.md             # 某个决策为什么这么定
sed -n '1,80p' packages/core/src/config-store/defaults.ts   # 默认配置项
node scripts/check-layering.mjs                     # 有没有偷偷 import node 内建
```

**冷启动**：跑 §1 三条自证 → 读 §4 分诊表 → 读 §3 找到被指派功能的文件 →
跑 `handoff-check.mjs` → 需要真机时按 §7 第 6 步打包。不要通读全仓，也不要通读历史报告。

### 代码仓库与上传

- 公开仓库：`https://github.com/yechenliao0820/YTVDLT.git`；默认分支 `main`；remote 名 `origin`。
- **不要主动推送**（铁律 12）。维护做完先本地交付并等指令；业主说「上传仓库」后再执行。
- 上传方法：

  ```bash
  git remote -v                                  # 先确认 origin 指向上面的地址
  git status --short                             # 看清楚本次要提交什么
  git add -A && git commit -m "<改动摘要>"
  git push origin main                           # 首次需 GitHub 授权，之后凭据由 Git Credential Manager 缓存
  ```

- 推送前体检：确认没有大文件（单文件 > 50 MB 会被拒）、密钥 / token 误入、以及
  `.gitignore` 是否仍覆盖 `node_modules/`、`dist-*`、`_to-delete/`、随包 exe、`reports/`。
- 上传后把**仓库地址、分支、本次提交号**写进回复交给业主／下一位；
  发布二进制 Release 同样等业主明确指令，产物在 `dist-<version>/`。

---

## 12. 本手册的维护规则（防止它变成屎山）

**可以写进来**：路径、命令、文件名、分层与依赖方向、IPC 契约、永久规则、分诊顺序、稳定坑的原理。

**不要写进来**：
- 版本号、当前交付状态、日期、「最后核对日期」；
- 测试数、覆盖率、PASS 数、基线张数——**写成「跑某某命令看输出」，不写具体值**；
- 「某版本实测」「某某版已做」「当日新增」这类带时间戳的叙述；
- 已完成事项（直接删掉对应行，不要留着加「已做」标注）；
- 事故经过的复述（去 `DECISIONS.md` 看原文）。

**每轮维护做一次减法**：接手时先扫一遍，把已完成、已失效、带日期的条目**删掉**，
而不是继续往上加说明。新增内容先问一句「这条一年后还成立吗」，不成立就放 `CHANGELOG.md` 或 `DECISIONS.md`。

**改动后**：同步外层阅读副本 `C:/Users/leolee/Desktop/YTVDLT/docs/`，并跑一次 `handoff-check.mjs`。
