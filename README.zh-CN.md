# YTVDLT

[English](README.md) · **简体中文**

[![最新版本](https://img.shields.io/github/v/release/yechenliao0820/YTVDLT?style=flat-square&color=1d63b8)](https://github.com/yechenliao0820/YTVDLT/releases)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-45-47848F?style=flat-square&logo=electron&logoColor=white)
![Renderer](https://img.shields.io/badge/renderer-zero--dependency-eef2f6?style=flat-square)
![License](https://img.shields.io/badge/license-Non--Commercial-orange?style=flat-square)

Windows 桌面视频 / 音频下载器。**装上就能用**：`yt-dlp`、FFmpeg 与 Node.js
运行时全部随包，不需要预装 Python / Node / FFmpeg，不用配 PATH，也不会在首次
启动时弹「找不到引擎」。

- 平台：Windows 10（1809+）/ Windows 11，x64
- 外壳：Electron 45 + TypeScript；渲染层是纯 HTML/CSS/JS，**零运行时依赖**
- 下载引擎：随包 `yt-dlp`，可校验、可在运行时替换

## 截图

| 下载队列 | 深色主题 |
|---|---|
| ![队列](docs/assets/queue.png) | ![队列·深色](docs/assets/queue-dark.png) |

| 设置 —— 分区目录跟随滚动 | 更新弹窗 —— 说明来自 GitHub Release |
|---|---|
| ![设置](docs/assets/settings.png) | ![更新弹窗](docs/assets/update-dialog.png) |

## 它是什么

一个只做三件事的 Electron 外壳：编排队列、渲染静态界面、把 `yt-dlp` 当子进程
管起来。真正有意思的是分层边界：

- `packages/core` 是纯 TypeScript，**禁止** import `node:fs`、
  `node:child_process`、`electron`；所有外部能力都通过注入的 port 进来。
- `packages/engine-ytdlp` 负责拼 argv、解析进度行、校验产物；网络与磁盘仍然
  来自 port。
- `packages/ui` 是一组零依赖静态页面，只通过一个白名单 `contextBridge` 与主
  进程通信。

也正因为这条边界，队列逻辑、进度解析、更新判定和错误映射都能用内存文件系统
离线测试——不需要真的下一条视频。

## 功能

### 下载

- 粘贴链接，选**视频**或**音频**，再选分辨率档位（best / 2160p / 1440p /
  1080p / 720p / 480p / 360p / lowest）或音频码率（192 / 128 / 64 / 32 kbps，
  可转 MP3 / M4A）。
- 进度不只是百分比：已下载 / 总大小、实时速度、剩余时间；引擎报不出来的字段
  单独隐藏，不拿 0 冒充。
- 取消、重试、打开文件夹、多选、排序、批量删除（文件进**回收站**，绝不
  `rm -rf`）、清空历史。
- 播放列表按条目勾选导入——200 条的列表是批量任务，不是惊吓。

### 产物可信

- 字幕选择、嵌入、语言过滤、容器转换。
- 每次下载后逐个校验产物：字节级检查、`ffprobe`、全解码、时长容差、流完整性。
  截断的文件会被判**失败**，而不是「已完成」。
- 任务详情页与日志页；错误报告可一键复制，其中的链接已脱敏。

### 使用体验

- 视频封面缩略图，缓存在本地（渲染层永远拿不到远端媒体 URL）。
- 浅色 / 深色 / 跟随系统，强调色可调，支持「减少动态效果」。
- 中英文界面，运行时切换。
- 无痕模式：关闭窗口时清空任务历史，**不动本地文件**。
- 下载位置可选：视频与音频可分别存放；选完先探测目录是否可写，不可写就不保存。
- 设置页按分区组织，左侧目录跟着滚动高亮，点一下就跳过去。

### 保持最新

更新刻意分成两条独立路径——引擎过旧会让所有下载失效，而软件本体可能完全正常。

| | 应用本体 | yt-dlp 引擎 |
|---|---|---|
| 来源 | 本仓库的 GitHub Releases | yt-dlp 官方发布源 |
| 检查 | 启动时（可关）、6 小时节流、或手动 | 启动时（可关）、24 小时节流、或手动 |
| 校验 | 大小 + SHA-256（有则比）+ `MZ` 头 | `SHA2-256SUMS` |
| 应用 | 下载安装包，**由你**确认 NSIS 向导 | `.new` 原子替换，校验不过回滚 `.bak` |
| 忽略 | 「以后不再提示此版本」 | — |

软件本体从不静默安装，也不会在校验通过之前替换掉一个能用的二进制文件。

## 环境要求

- Windows 10 1809+ 或 Windows 11，x64
- 无需 Python / Node.js / FFmpeg，也不用配 `PATH`——运行时随包

## 安装

1. 打开 [Releases](https://github.com/yechenliao0820/YTVDLT/releases)，下载
   `YTVDLT Setup <版本>.exe`。
2. 安装包**未签名**，SmartScreen 会拦一次：点「更多信息 → 仍要运行」。
3. 启动后粘贴链接，点「粘贴并解析」。文件默认落在
   `%USERPROFILE%\Downloads\YTVDLT`，可在设置里改。

## 数据落在哪

| 内容 | 路径 |
|---|---|
| 默认下载目录 | `%USERPROFILE%\Downloads\YTVDLT` 与 `…\YTVDLT\Audio` |
| 配置 / 日志（安装目录可写） | `<exe 所在目录>\config\config.json`、`\logs\app-YYYYMMDD.jsonl` |
| 配置 / 日志（装到只读目录，如 `C:\Program Files`） | `%APPDATA%\YTVDLT\config\…` |
| 封面缓存 / 下载好的更新包 | `%APPDATA%\YTVDLT\thumbs\…`、`%APPDATA%\YTVDLT\updates\…` |

## 从源码构建

需要 Node.js 22 与 pnpm 9。

```bash
pnpm install
pnpm typecheck                 # 5 个工作区包
npm test                       # vitest + v8 覆盖率（门限 70%）
node scripts/run-e2e.mjs       # 截图/DOM 基线 + 必须失败的反例
node scripts/handoff-check.mjs # 文档数字与仓库现状对账

node scripts/build-desktop.mjs # 打包主进程 + preload，拷贝渲染层
CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder \
  --config apps/desktop/electron-builder.yml \
  --config.directories.buildResources=apps/desktop/build \
  --config.directories.output=dist-<版本> \
  -c.extraMetadata.main=apps/desktop/dist/main/main.cjs \
  -c.electronDist=node_modules/electron/dist \
  --win nsis
```

其中四个参数不是装饰：

| 参数 | 为什么必须 |
|---|---|
| `--config apps/desktop/electron-builder.yml` | 配置文件不在仓库根 |
| `--config.directories.buildResources=apps/desktop/build` | 否则 electron-builder 会退回 Electron 默认图标 |
| `-c.extraMetadata.main=apps/desktop/dist/main/main.cjs` | 根 `package.json` 没有 `main`（它同时是工作区根） |
| `-c.electronDist=node_modules/electron/dist` | 复用已解压的 Electron，CDN 抖动不会弄坏构建 |

**顺序不能反**：`build-desktop.mjs` 必须先于 `electron-builder`，否则 asar 里
装的是上一版前端。另外 `electron-builder` 会就地改写根 `package.json`，打包后
要还原。

## 目录结构

```
apps/desktop/          Electron 外壳：主进程、preload、打包配置
packages/shared/       纯类型 + IPC 契约（禁 node:*、禁 electron）
packages/core/         纯逻辑：队列、校验、配置、错误映射
packages/engine-ytdlp/ yt-dlp 适配：argv、进度解析、产物清单
packages/ui/           零依赖静态渲染层（pages/styles/i18n）
scripts/               构建、测试、验收、烟测驱动
docs/                  决策、维护手册、各里程碑报告
```

依赖方向单向，由 `scripts/check-layering.mjs` 强制：

```
ui  ←  preload  ←  apps/desktop
        ↑
   shared  ←  core  ←  engine-ytdlp
```

## 文档

| 想了解 | 看哪份 |
|---|---|
| 怎么改、改哪里、改完怎么验 | [`docs/AI-MAINTENANCE.md`](docs/AI-MAINTENANCE.md) |
| 每个版本改了什么 | [`docs/CHANGELOG.md`](docs/CHANGELOG.md) |
| 某个决定为什么这么定（编号 D-xx 的决策记录） | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| 构建环境与打包的坑 | [`docs/BUILD.md`](docs/BUILD.md) |
| 验收口径与证据 | [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) |
| 产物考据与被淘汰的版本 | [`docs/BUILD-HISTORY.md`](docs/BUILD-HISTORY.md) |

## 第三方组件

| 组件 | 许可 | 使用方式 |
|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | 独立进程，可替换 |
| FFmpeg / ffprobe | LGPL-3.0 | 动态链接的 shared 构建 |
| aria2c | GPL-2.0-or-later | 独立进程，可选的分段下载器 |
| Electron / Node.js | MIT | 应用外壳与运行时 |

全文与合规说明见 [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md)。
本项目的许可**不改变**上述组件的授权条件。

## 许可

**YTVDLT 非商业许可 1.0** —— 见 [`LICENSE`](LICENSE)。

- **非商业**用途免费：个人学习、研究、教学、公益。
- 可阅读、修改、分发代码，但必须保留许可与署名，修改版要显著标注。
- 商业使用需事先取得作者书面授权。
- 属于 **source-available（源码可得）**，不是 OSI 意义的开源，**不是 MIT**。

## 免责声明

YTVDLT 只是 `yt-dlp` 的前端。下载什么、是否遵守所用网站的服务条款与著作权法，
由你负责。本项目不绕过 DRM，不分发也不托管任何媒体内容。

<details>
<summary>仓库历史</summary>

原始 `.git`（2026-11-05 至 11-07 的开发历史）在 2026-11-07 的一次目录迁移事故中
丢失，且无远端副本可恢复。当前仓库为事故后重建：代码与文档完整，但提交哈希与
原始历史不一致。找回的提交线索见
[`docs/GIT-HISTORY-RECOVERED.md`](docs/GIT-HISTORY-RECOVERED.md)。

</details>
