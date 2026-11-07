# YTVDLT

Windows 桌面视频下载器。**双击即用，零外部依赖**：安装包自带 yt-dlp、Node.js 运行时与 FFmpeg（LGPL shared），不需要用户预装 Python / Node / FFmpeg。

- 平台：Windows 10（1809+）/ Windows 11，x64
- 版本：0.1.0（基准线：2026-11-07 重建仓库后首次发版）
- 形态：NSIS 安装版 + 便携版（免安装）

> **接手维护（人或 AI）先看 [`docs/AI-MAINTENANCE.md`](docs/AI-MAINTENANCE.md)**：
> 目录地图、功能→文件对照表、IPC 契约、构建顺序、五个必踩的坑、已知未完成项。
> 版本产出与淘汰记录见 [`docs/BUILD-HISTORY.md`](docs/BUILD-HISTORY.md)。

> ⚠️ **仓库历史说明**：本项目原有 `.git`（2026-11-05 至 11-07 的开发历史）在 2026-11-07 的一次
> 目录迁移事故中丢失，且无远端副本可恢复。当前仓库为事故后重建，提交哈希与原始历史**不一致**；
> 代码与文档内容完整。原始提交线索（8 个 hash 与各阶段说明）见
> [`docs/GIT-HISTORY-RECOVERED.md`](docs/GIT-HISTORY-RECOVERED.md)，`history` 分支为按文件时间戳
> 重构的可读时间线（非原始 diff）。

---

## 功能

- **粘贴即下**：队列页粘贴链接 → 「粘贴并解析」直接入队，实时进度、取消、重试、打开文件夹
- **格式与质量**：分辨率/编码/音轨选择，纯音频抽取（mp3 / m4a）
- **字幕**：自动字幕、语言过滤、格式转换
- **批量**：播放列表多选导入
- **产物校验**：下载后逐项校验（字节哈希 / ffprobe / 全解码 / 时长容差 / 流完整性），不合格判失败而不是「假装完成」
- **离线友好**：引擎与运行时随包，组件（yt-dlp / aria2c）可在线增量更新并校验 SHA-256
- **应用自更新**：electron-updater + NSIS 静默更新，失败静默降级，不打断使用

## 使用

1. 安装版双击 `YTVDLT Setup 0.1.6.exe`；便携版直接运行 `YTVDLT-Portable-0.1.6.exe`
2. 未签名，首次运行 SmartScreen 会提示一次 —— 点「更多信息 → 仍要运行」
3. 默认下载到 `%USERPROFILE%\Downloads\YTVDLT`，可在设置里改

## 开发

```bash
pnpm install            # 依赖
pnpm typecheck          # 5 个包类型检查
npm test                # vitest（718 例，覆盖率门限 70%）
node scripts/run-e2e.mjs    # 30 张截图基线 + 5 个反例
node scripts/handoff-check.mjs  # 文档数字与仓库现状对账

# 打包（顺序不能反）
node scripts/build-desktop.mjs
npx electron-builder --win --publish never
```

## 目录

```
apps/desktop      Electron 外壳（主进程 / preload / 打包配置）
packages/shared   类型与 IPC 契约
packages/core     纯逻辑（禁 node:*）
packages/engine-ytdlp  yt-dlp 适配层
packages/ui       零依赖静态前端
scripts/          构建、测试、验收、烟测
docs/             设计、决策（D-01…）、里程碑报告、维护手册
```

## 文档

| 想了解 | 看哪份 |
|---|---|
| 怎么改、改哪里、怎么验 | [`docs/AI-MAINTENANCE.md`](docs/AI-MAINTENANCE.md) |
| 每个版本的产出与取舍 | [`docs/BUILD-HISTORY.md`](docs/BUILD-HISTORY.md) |
| 所有技术决策 | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| 构建环境 | [`docs/BUILD.md`](docs/BUILD.md) |
| 验收口径 | [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) |

## 许可

见 `LICENSE`。随包第三方组件许可见 `THIRD_PARTY_NOTICES.md`。
