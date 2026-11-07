# M5 开工前预检报告

> 生成时间：2026-11-06 15:5x ／ 基线：`bdd8ce6` 之后的工作区（`docs/PROJECT-HANDOFF.md` 为用户本地改动，未入库）
> 目的：在进入 M5（最终成品）前，用**真实命令**确认 M1–M4 四层没有互相破坏，并列出 M5 的硬阻塞。
> 结论先行：**代码层四套验收全绿；M5 的阻塞不在代码，而在「依赖缺失 + 生产装配缺失」。**

## 1. 验收矩阵（同一工作区，串行执行）

| 里程碑 | 断言 | 门控 | 原始验收 | allGreen | 证据 |
|---|---|---|---|---|---|
| M1 | **17/17** | — | **5/5** | ✅ | `reports/acceptance-report-m1.json` |
| M2 | **37/37** | **5/5** | — | ✅ | `reports/acceptance-report-m2.json` |
| M3 | **48/48** + 3/3 复验 | **12/12** | **4/4** | ✅ | `reports/acceptance-report-m3.json` |
| M4 | **9/9** | **10/10** | **4/4** | ✅ | `reports/acceptance-report-m4.json` |

执行方式：`for m in M1 M2 M3 M4; do node scripts/acceptance.mjs --milestone $m; done`（**串行**，并行会互相覆盖 `reports/vitest-results.json`、`coverage/`、端口与临时目录）。

> 说明：M1–M3 在 15:52–15:58 的串行批次中完成（日志 `reports/m5-preflight-run.log`）；该批次在 M4 启动后被手动中止，M4 随后单独补跑，结果如上。**四套均为当前 HEAD 实测，不是历史快照。**

## 2. 公共门控（四套共享）

| 检查 | 命令 | 结果 |
|---|---|---|
| 全量单测（unit+contract） | `npm test` | **44 files / 583 passed / 0 failed**，覆盖率四维门控通过 |
| 类型检查 | `pnpm turbo run typecheck` | **5/5 successful** |
| 分层铁律 | `node scripts/check-layering.mjs --json` | **violationsCount = 0** |
| 待办标记 | `grep TODO/FIXME/XXX packages apps` | **0 处** |
| 冻结文件（相对 M3 基线 `bb22ab9`） | `git diff --stat bb22ab9..HEAD -- package.json pnpm-lock.yaml packages/shared/src/request.ts` | 仅 `request.ts` **+6 行**（可选字段 `advanced.playlistItems?`，D-50）；`package.json` / `pnpm-lock.yaml` **0 行 diff** |

## 3. 各里程碑独有覆盖（不能用 M4 代替）

| 里程碑 | 只有它覆盖的内容 |
|---|---|
| M1 | U3 本地直链实测；`check-runtime` 4 项（yt-dlp / node / ffmpeg / aria2c） |
| M2 | 5 个 L2 离线用例（真实 spawn yt-dlp + 本地 HTTP 服务）：probe / download / cancel / retry / artifact |
| M3 | 14 个截图用例 + 5 个反例；guard 5 条反例；`--no-collect` 下仍校验 DOM/像素基线 |
| M4 | 并发上限与补位、强杀恢复、批量入队、命令白名单、通知/详情/报告、冻结 argv |

## 4. M5 硬阻塞（按优先级）

| # | 阻塞 | 现状 | 影响 | 可否离线解决 |
|---|---|---|---|---|
| B1 | Electron 二进制缺失 | `node_modules/electron/dist/electron.exe` **不存在** | 无法创建窗口、托盘、系统通知；M5-4 打包与 M5-5 升级全部卡住 | ❌ 需 **N1**（包管理器；可用国内镜像 + `ELECTRON_MIRROR`） |
| B2 | 打包工具缺失 | `node_modules/electron-builder` **不存在**；`apps/desktop/dist` **不存在** | 没有可安装产物，M5“最终成品”无法交付 | ❌ 需 **N1**（+ 可能 **N2** 下预编译包） |
| B3 | UI 技术栈未落地 | `react` / `vite` **不存在**；现有 UI 是零依赖静态 HTML/CSS/JS | M5-1 主题、M5-3 三态若要求 React/MUI，需先补依赖；否则沿用静态载体 | ⚠️ 部分可离线（静态方案），React 方案需联网 |
| B4 | 生产装配未完成 | **已补 host 层**：`createM4Host()` 装配队列/恢复/批量回调/通知订阅/模板/详情（12 例测试）；**仍缺**：入口调用、模板/详情/列表 IPC、真实窗口/托盘 | M5 体验验收仍会点不出来 | ⚠️ 部分已解决，剩余可离线 |
| B5 | 真实 GUI 未跑过 | 从未创建 BrowserWindow；D-28/D-39 仍 SKIPPED | M5-4 前无法声称“可运行成品” | ❌ 依赖 B1 |

## 5. 建议的 M5 执行顺序（先解 B4，再等 B1/B2）

1. **离线可做**：B4 生产装配（`createTaskHost` 接入口、命令模板 IPC、通知订阅、批量回调注入）→ 补主进程链路测试。
2. **离线可做**：M5-1 主题三态、M5-2 快捷键 + i18n（core 已预留 `stateLabelKey` / `titleKey` / `bodyKey`）。
3. **离线可做**：M5-3 三态统一 + 把 3 个新页面纳入截图基线。
4. **需联网**：B1/B2/B3（electron、electron-builder、可选 React/Vite）→ M5-4 打包、M5-5 更新与干净 VM。
5. **需真机**：真实托盘/通知/默认播放器/双流 ffmpeg 孤儿压测（D-28 / D-39 / D-52）。

## 6. 明确未验证（不得在 M5 汇报中声称已完成）

- 真实窗口启动、托盘图标、系统通知点击聚焦
- 安装包生成、自动更新、签名
- 干净 Windows VM 首次运行
- 真实站点批量下载（当前 probe/批量均为录制 fixture + 注入进程端口）
- **从未访问过 YouTube**；需要 **N3 国际网络出口**才能做 L3 烟测
- 真实进程强杀（当前为进程内两会话模拟）

## 6.1 网络需求三类（别混）

| 类型 | 用途 | 是否必须国际出口 | 替代方案 |
|---|---|---|---|
| **N1 包管理器** | electron / electron-builder / react | 否 | npmmirror、`ELECTRON_MIRROR` |
| **N2 代码托管** | yt-dlp.exe、Electron 预编译包、更新源 | 通常否 | 代理 / 镜像 / 本地更新源 |
| **N3 国际站点** | L3 真实访问 YouTube | **是** | 无；不可达就 SKIPPED |

## 7. 交接文档

- 下一阶段完整交接：`docs/M5-HANDOFF.md`（M5 拆块、装配现状、铁律、陷阱、第一小时清单、待确认项）。

## 8. 复现命令

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt
for m in M1 M2 M3 M4; do node scripts/acceptance.mjs --milestone $m; done   # 串行
npm test
pnpm turbo run typecheck
node scripts/check-layering.mjs --json
```
