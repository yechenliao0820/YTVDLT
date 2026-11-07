# 第三方组件与许可证清单（THIRD PARTY NOTICES）

> 适用范围：YTVDLT 0.1.0（Windows x64）安装版与便携版。
> 生成依据：`resources/runtime/win-x64/runtime-manifest.json`（含每项 SHA-256）+ `pnpm-lock.yaml` + `package.json`。
> **口径说明**：FFmpeg 的实际许可为 **LGPL-3.0**（随包二进制附带的 `FFMPEG-LICENSE.txt` 即 LGPL v3 全文）。原始任务书 §6.7 / §12.5 中「LGPL-2.1+ / LGPLv2.1」为**过时文案**，与 D-08 实测不一致，本文件按实测登记，不照抄旧文案。

---

## 1. 随包运行时（`extraResources` → `resources/runtime/`，**不在 asar 内**）

| 组件 | 版本 | 许可 | 来源 | SHA-256 |
|---|---|---|---|---|
| yt-dlp | 2026.10.26 | **Unlicense**（公有领域） | `https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe` | `f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d` |
| Node.js | v24.22.2 | **MIT** | `https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip` | `1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9` |
| FFmpeg / ffprobe / ffplay + 共享 DLL | `n9.0.2-47-gb204e94e90-20261104` | **LGPL-3.0**（动态链接 shared 构建） | `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip` | 见 `runtime-manifest.json` 该组 10 个文件逐条 |
| **aria2c** | 1.35.0（二进制自报） | **GPL-2.0-or-later** | 官方 `aria2-1.35.0-win-64bit-build1.zip`；本机经 npm 镜像 `@x-cmd-pkg/aria2` 取得（同一份官方构建的转发，含 `COPYING` / `AUTHORS` / `README.html`） | `b151764ecbb164f25f8aeca3b93e0a18b63d108bbb1f33982fe4eea46b8ecab9` |

FFmpeg 相关文件（全部在 `resources/runtime/ffmpeg/`，与 exe 同目录，**未改名、未混淆**）：

| 文件 | SHA-256 |
|---|---|
| `ffmpeg.exe` | `ef9f302512b2332b078b73f078a2239b285d476242eeb71b3efc2db8399d701d` |
| `ffprobe.exe` | `6019d1fbb5b12fa338c2082e617307ffd273af63ba118164b1dc7b857c09f193` |
| `ffplay.exe` | `9512a126f8940a6ac6aa60d140c9cc7db53e6a1aa863ae1536b9b3341de86740` |
| `avcodec-63.dll` | `46365f99769c7755fbe24b4cb2a8604bec0d05d6b878fa22e1e36352a86b3f69` |
| `avdevice-63.dll` | `fec51710950b8a216aeb851c243360120aa53e419901de2c646728f80ea8c5fe` |
| `avfilter-12.dll` | `98ee6e6c10166850bc4a7c54dc7b7201ba0a71c5946f2cc3abc6f3f9ade137e8` |
| `avformat-63.dll` | `95d0200076d44fbf09d50a56b7a04526d3b8619982e89813c02aaa7434883712` |
| `avutil-61.dll` | `a6470b21ecb553df47bb7e44d3068babd877e13fc04b95288518c228fe1c5e27` |
| `swresample-7.dll` | `3528b6a963fafc28a9271c753ab35bfc3d0f022b05babe356cd5509332ee6197` |
| `swscale-10.dll` | `67f42d2f0577f19ad69657e3e46965e72964f09b65e5f1b7c6e6407b9cc3e1d9` |

许可证全文随二进制同目录分发：`resources/runtime/FFMPEG-LICENSE.txt`（LGPL v3 全文）。

## 1.1 aria2c（GPL-2.0-or-later，独立进程）

| 项 | 值 |
|---|---|
| 文件 | `resources/runtime/aria2c.exe`（5,117,952 B） |
| 版本 | **1.35.0**（以 `aria2c --version` 自报为准；npm 包名下写的是 1.36.0，与二进制不符，此处以二进制为准并登记该差异） |
| 许可 | **GPL-2.0-or-later**，全文随包：`resources/runtime/ARIA2-COPYING.txt` |
| 源码 | `https://github.com/aria2/aria2/tree/release-1.35.0`（归档：`https://github.com/aria2/aria2/archive/refs/tags/release-1.35.0.tar.gz`） |
| 上游发布 | `https://github.com/aria2/aria2/releases/tag/release-1.35.0` |

**为什么 GPL 组件可以与闭源主程序一起分发**：aria2c 是**独立可执行程序**，YTVDLT 通过 `spawn` 调用它（`yt-dlp --downloader aria2c`），既不链接其代码、也不把它作为库加载，属于「聚合分发（mere aggregation）」。因此 GPL 的传染性不覆盖 YTVDLT 自有代码。义务仅限：随包附许可证全文（已做）、提供对应源码（上方链接）、不阻止用户替换该 exe（未做任何完整性绑定）。

**可替换性**：用户可直接用自编译的 `aria2c.exe` 覆盖同名文件；程序启动时只检查是否存在，不校验签名。若删除它，下载自动回落到 yt-dlp 原生分段（功能不缺失，只是并发连接数变少）。

## 2. 应用运行时（打进 `app.asar`）

| 组件 | 版本 | 许可 |
|---|---|---|
| Electron | 45.2.2 | MIT |
| 应用自身代码（`@ytvdlt/{shared,core,engine-ytdlp,desktop,ui}`） | 0.1.0 | 见 §4 |

> 说明：`app.asar` 内**只有** `apps/desktop/dist/**`（已 bundle 的自有代码）+ `package.json`，**不含任何 `node_modules`**。因此不存在「随包分发了未声明 npm 依赖」的情况。

## 3. 开发期依赖（不随包分发）

`electron-builder@26.18.0`（MIT）、`electron-updater@6.8.11`（MIT）、`vitest@3.2.4`（MIT）、`@vitest/coverage-v8@3.2.4`（MIT）、`typescript@5.8.3`（Apache-2.0）、`turbo@2.x`（MIT）、`tsx@4.x`（MIT）、`@types/node@22.x`（MIT）、`esbuild@0.28.2`（MIT，经 vite 传递引入）。

这些工具**不进入安装包**，仅在构建机上使用。

## 4. 自有代码的许可与「干净室」声明

- YTVDLT 自有代码**不复制** Seal / yt-dlp 的源码，按原始任务书 §3.6 以干净室方式重写；与 Seal 的 GPL-3.0 无衍生关系。改名原因见 `docs/DECISIONS.md`。
- 本项目**不启用** `--enable-gpl` / `--enable-nonfree` 编译的 FFmpeg，也不随包分发 x264 / x265 等 GPL 组件。因此自有代码**不因 FFmpeg 而被迫 GPL**。
- 本仓库当前**未声明对外许可**（`private: true`）。若后续开源或对外分发，须由甲方确定自有许可后再补 `LICENSE` 文件；本文件不代替该决定。

## 5. FFmpeg LGPL 合规清单（§12.5 十二条逐条给证据）

| # | 官方要求 | 落地情况 | 证据路径 |
|---|---|---|---|
| 1 | 不含 `--enable-gpl` / `--enable-nonfree` | 使用 BtbN `*-win64-lgpl-shared*.zip`，**不是** yt-dlp/FFmpeg-Builds（后者只有 GPL 构建） | `runtime-manifest.json` 的 `sourceUrl` / `releaseTag` 字段 |
| 2 | 动态链接，用户可替换 DLL | shared 构建；`avcodec-63.dll` 等与 exe 同目录原样分发，未静态合并 | `resources/runtime/ffmpeg/*.dll`（10 个） |
| 3 | 分发 FFmpeg 源码 | 提供与二进制**精确对应**版本的源码下载：`https://github.com/FFmpeg/FFmpeg/tree/n9.0.2-47-gb204e94e90`；归档：`https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n9.0.2-47-gb204e94e90.tar.gz` | 本节 + `LICENSE-COMPLIANCE.md` §3 |
| 4 | 源码与二进制精确对应 | manifest 记录 BtbN 构建串 `n9.0.2-47-gb204e94e90-20261104` 与 release tag | `runtime-manifest.json::version` / `releaseTag` |
| 5 | 说明编译方式 | BtbN 构建工作流与配置脚本公开：`https://github.com/BtbN/FFmpeg-Builds/blob/master/build.sh`；构建参数为 `--enable-shared --disable-static`（无 gpl） | `LICENSE-COMPLIANCE.md` §4 |
| 6 | 下载页声明 | `README.md` 固定文案：「本软件使用 FFmpeg 的库，按 LGPL-3.0 分发，源码可在此下载」 | `README.md` §「第三方组件」 |
| 7 | 「关于」框声明 | 设置 → 关于：`FFmpeg 采用 LGPL-3.0，源码与许可全文见 THIRD_PARTY_NOTICES。`（中/英双语） | `packages/ui/src/i18n/messages.js:153`（中文）、`:304`（英文） |
| 8 | EULA 提及 LGPL、不禁止反向工程、不宣称拥有 FFmpeg 代码 | 见 `LICENSE-COMPLIANCE.md` §6 的 EULA 条款模板 | `LICENSE-COMPLIANCE.md` §6 |
| 9 | DLL 不得混淆改名 | 保持 `avcodec-63.dll` / `avformat-63.dll` / `avutil-61.dll` / `swresample-7.dll` / `swscale-10.dll` / `avfilter-12.dll` / `avdevice-63.dll` 原名 | `resources/runtime/ffmpeg/` 目录列表 |
| 10 | 检查内嵌其它 LGPL 库 | 随包二进制**不含** LAME / x264 / x265 / libvpx 等第三方编解码库；BtbN lgpl-shared 构建仅含 FFmpeg 自身与系统库 | `runtime-manifest.json` 全 13 项（除 aria2c 外无其它独立程序） |
| 11 | 不含 libx264 等 GPL 库 | 同上；产品只做 remux / 合并 / 转音频，不重编码视频，功能不受影响 | M2 U4 实测（`docs/M2-REPORT.md`） |
| 12 | 随包完整许可证文本 | `FFMPEG-LICENSE.txt` 与二进制**同目录**（`resources/runtime/`，`extraResources` 复制后仍在 `resources/runtime/`） | `resources/runtime/win-x64/FFMPEG-LICENSE.txt` |

## 6. 已知文案差异（登记，不改历史文档）

| 位置 | 原文 | 实测 | 处理 |
|---|---|---|---|
| 原始任务书 §6.7 依赖表 | FFmpeg「LGPL-2.1+」 | 随包 `FFMPEG-LICENSE.txt` 为 **LGPL v3** 全文；BtbN `lgpl-shared` 构建即 LGPL-3.0 | 本文件与 `LICENSE-COMPLIANCE.md` 按 **LGPL-3.0** 写；旧文案仅在 D-63 登记为过时 |
| 原始任务书 §12.5 第 6/7 条 | 固定英文文案含「LGPLv2.1」 | 同上 | README 与「关于」框统一改为 LGPL-3.0，**不照抄** LGPLv2.1 措辞 |
| `docs/M5-SUMMARY.md` | 写于 gate 关闭期的阻塞登记 | 现状已变（N1 已放行、打包已出） | 按 A7 **不改**该文件；新状态写在 `M5-4/5/6-REPORT.md` |
