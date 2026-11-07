# M5 收尾报告 · 离线块完成，打包与在线烟测未开工

> 日期 2026-11-06 ／ 基线 `44cab2c` + 本轮改动 ／ 决策 D-54…D-59
> 一句话：**M5 的「可离线验证部分」全部完成且全绿；N1/N2/N3 三个网络前置未放行，打包、自动更新、L3 在线烟测未开工，因此 M5 未交付、也未声称交付。**

## 1. 本轮做了什么

| 块 | 内容 | 状态 |
|---|---|---|
| **M5-0** | 8 条生产 IPC 通道（任务列表/详情/动作、模板 CRUD、设置）；`createM5Host` 合并网关；`bootstrap` 窗口/托盘/单实例/深链；`electron-entry` 装配（仅类型检查） | ✅ 离线完成 |
| **M5-1** | Light/Dark/System + 5 组强调色 + 跟随系统强调色（策略层）+ 减少动效 + 触觉明确省略 | ✅ 离线完成 |
| **M5-2** | §6.8 全部快捷键（含输入框不劫持、全局例外、macOS 映射、冲突检测）+ zh-CN/en 字典与切换 | ✅ 离线完成 |
| **M5-3** | 队列主页面（四 Tab / 搜索 / 卡片）+ 四个页面空/错状态同构 + 16 个新截图用例 | ✅ 离线完成 |
| **M5-4** | NSIS 安装版 + 便携版 + `extraResources` + asar 排除 + LGPL 文案 | ⛔ 阻塞于 **N1**（electron / electron-builder 未安装） |
| **M5-5** | `electron-updater` 双通道 + 引擎更新 SHA2-256SUMS + 干净 VM 实测 | ⛔ 阻塞于 **N1/N2**；VM 段按设计属甲方 |
| **M5-6** | L3 在线烟测 + 产物 SHA256 | ⛔ 阻塞于 **N3**（无国际出口，YouTube 从未访问） |

## 2. 验证结果（真实命令，非估计）

| 项 | 命令 | 结果 |
|---|---|---|
| 全量单测 | `npm test` | **53 files / 670 passed**（M4 收尾时 44 / 583，本轮 +9 文件 / +87 例） |
| 覆盖率四维 | 同上（v8） | lines **95.36%** / branches **86.70%** / functions **95.97%** / statements **95.36%**（门控 70%） |
| 类型检查 | `pnpm turbo run typecheck` | **5/5** |
| 分层铁律 | `node scripts/check-layering.mjs --json` | **violationsCount = 0** |
| 截图套装 | `node scripts/run-e2e.mjs` | **30/30 用例 + 5/5 反例，allPass=true** |
| M5 验收 | `node scripts/acceptance.mjs --milestone M5` | 见 `reports/acceptance-report-m5.json`（10 条断言：8 PASS + 2 SKIPPED） |
| M1–M4 回归 | 四套串行 | 应保持 17/17、37/37、48/48、9/9 全绿（本次改动未触碰 M1–M4 判据） |

### 2.1 新增测试（9 个文件 / 87 例）

`appearance` 17 · `i18n` 11 · `shortcuts` 12 · `task-view` 8 · `m5-channels` 14 · `m5-host` 7 · `bootstrap` 7 · `crash-guard` 6 · `platform-policy` 5

### 2.2 M3 视觉零回归（本轮最硬的一条证据）

六个页面新增 `theme.css` 与 5 个脚本标签后，14 个旧用例的 **28 个基线文件**（PNG + DOM）必然要重建。重建后逐例与 M5 前的副本做 **0 容差** 像素对比：

- **14/14 个 M3 用例 `differPixels = 0`**；
- 14 个旧 DOM 基线各 **+6 行**（1 个 `link` + 5 个 `script`），无其它改动。

结论：M5 只增加了加载点，没有改变 M3 的任何视觉表现。

## 2.3 收尾排雷（9 项，均已修复并复验）

全部为「门控全绿但实际有错」的问题，记录在 D-60：

| # | 问题 | 修法 |
|---|---|---|
| 1 | 英文模式 Tab 计数被 i18n 抹掉（`textContent` 覆盖子树） | 只替换首个文本节点，保留子元素 |
| 2 | 顶栏显示字面量 `Running {active}/{limit}` | 含占位符的模板不由 i18n 覆盖，参数由页面提供 |
| 3 | 深链把完整 URL 写进 DOM（签名泄露） | 只留 `data-prefilled="true"` + `data-prefill-host`，并加反例断言 |
| 4 | 托盘创建失败仍"关窗最小化" → 窗口失联 | `trayReady` 门控，无托盘则正常关窗 |
| 5 | `SETTINGS_SET` 可写入任意字符串作强调色 | 预设 / `system` / 合法 hex 校验，非法抛错 |
| 6 | `m5-host` 硬编码通道名 | 改用 `IPC_CHANNELS.SETTINGS_GET` |
| 7 | e2e 断言假设属性相邻 | 统一 `id="x"[^>]*hidden="true"` |
| 8 | 输入框 focus 导致截图抖 15 px | `?focus=0` |
| 9 | 新页面空 `<pre>` 让写回检查 FAIL | 初始内容 `{}` |

修复后复验：e2e `30/30 + 5/5`（`queue-en` 中 Tab 计数与 `Running 2/3` 均正常）、M5 验收 `8 PASS + 2 SKIPPED`、M1–M4 全绿。

## 3. 阻塞（不是"待优化"，是"做不了"）

| # | 阻塞 | 需要的网络 | 解锁后才能做的事 |
|---|---|---|---|
| **N1** | electron / electron-builder 未安装（`node_modules/electron/dist` 为空） | 包管理器（可用国内镜像 + `ELECTRON_MIRROR`） | 真实窗口/托盘、`electron-entry` 首跑、NSIS 安装版与便携版、`latest.yml` |
| **N2** | 官方 `yt-dlp.exe` 与 Electron 预编译包未下载 | GitHub / 代理 / 镜像 | **A-4.4-28** 引擎更新实测（SHA2-256SUMS 校验、原子替换、回滚） |
| **N3** | 无国际出口，从未访问 YouTube | 国际网络 | L3 在线烟测（A-4.4-28 的在线部分、C13–C16 的真实下载环节） |

按 §0.1 的硬规矩，以上任何一步都必须**先向甲方说明类别、命令、耗时并取得同意**，本环境一次都没有发起。

## 4. M5 完成定义（DoD）逐条对照

| # | DoD 条目 | 状态 |
|---|---|---|
| 1 | `npm test` + typecheck + layering 全绿 | ✅ 完成（670/670、5/5、0 违规） |
| 2 | `acceptance --milestone M5` 9 条全 PASS | ⚠️ **8 PASS + 2 SKIPPED**（`A-4.4-28`、`A-4.4-29` 为 L3/N1 阻塞，按规矩记 SKIPPED，不写成 PASS） |
| 3 | 安装版 + 便携版产物 + SHA256 | ⛔ 未产出（N1） |
| 4 | 干净 VM：安装/便携/卸载 C13–C16 | ⛔ 未开始（N1 + 甲方实测） |
| 5 | 主题三态 + 快捷键 + 中英切换实测 | ✅ 静态面完成（e2e 30 例）；真实窗口未跑（N1） |
| 6 | NOTICE 覆盖 §6.7 + LGPL-3.0 12 条 | ⛔ 属 M5-4 打包块，未开始 |
| 7 | L3：PASS 或明确 SKIPPED | ⚠️ **SKIPPED**（无 N3）——已如实登记，未声称「YouTube 能下载」 |

**结论：M5 未完成交付**，7 条 DoD 中 2 条完全满足、2 条部分满足、3 条被 N1/N3 阻塞。

## 5. 未验证清单（不得在后续汇报中当成已完成）

- 真实 BrowserWindow 启动、托盘图标、系统通知点击聚焦
- 系统强调色读取（注册表 / DWM），当前 OS 侧返回 `null`
- 安装包生成、自动更新、代码签名、SmartScreen 文案
- 干净 Windows 10/11 VM 首次运行、卸载残留
- 真实站点下载与 C1–C12 实跑（L3）
- 弹窗 i18n 的动态拼接串（见 M5-2 报告 §4）

## 6. 下一步（按依赖排序）

1. **甲方放行 N1** → 装 electron / electron-builder → `electron-entry` 首跑 → 修真实窗口问题；
2. **甲方放行 N2** → 下 `yt-dlp.exe` + `SHA2-256SUMS` → 实现并实测 `A-4.4-28`；
3. **打包块（M5-4）** → NSIS + 便携版 + `extraResources` + 冒烟；
4. **M5-5 更新块** → `electron-updater` + `latest.yml` + 回滚；VM 段交甲方按 8 步清单执行；
5. **甲方放行 N3** → L3 烟测 + 产物 SHA256 + 归档。

## 6.1 下一棒从哪里开始

完整施工单见 **`docs/M5-HANDOFF-V2.md`**（v2.2）：剩余三块的逐步命令、网络放行清单（国内 N1/N2 vs 国际 N3）、17 条排雷、第一小时清单。本文件只回答"现在到哪了"，v2 回答"接下来怎么干"。

## 7. 停止声明

**M5 只完成了离线块；打包、自动更新与在线烟测未开工。未获甲方放行，不进入 M5-4/M5-5/M5-6，也不对外声称「成品可安装、可下载」。**
