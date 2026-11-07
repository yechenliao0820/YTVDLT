# 许可证合规说明（LICENSE COMPLIANCE）

> 对应决策 **D-08**（M1 定稿：FFmpeg 按实际许可登记）与 **D-63**（本文件口径）。
> 随包组件清单与 SHA-256 见 `docs/THIRD_PARTY_NOTICES.md`。
> **LGPL 是弱 copyleft**：动态链接 + DLL 可替换 + 履行官方清单，即可在自有许可下分发桌面应用，**不要求 YTVDLT 自身开源**。

---

## 1. 为什么是 LGPL-3.0（而不是旧文案里的 LGPLv2.1）

- 随包 `resources/runtime/FFMPEG-LICENSE.txt` 的正文是 **GNU Lesser General Public License Version 3, 29 June 2007** 全文。
- 构建来源 `BtbN/FFmpeg-Builds` 的 `lgpl-shared` 产物即 LGPL-3.0。
- 原始任务书 §6.7 / §12.5 里的「LGPL-2.1+」与「LGPLv2.1」是**旧版文案**，与实测不符。按 D-08「以随包许可证原文为准」的原则，全部文档、README 与「关于」框统一写 **LGPL-3.0**。旧文案的差异已在 `THIRD_PARTY_NOTICES.md` §6 与 D-63 登记，**不改写历史文档**。

## 2. 动态链接与可替换性（清单第 2、9 条）

- FFmpeg 以 **shared** 形式随包：`ffmpeg.exe` / `ffprobe.exe` 通过 `avcodec-63.dll`、`avformat-63.dll`、`avutil-61.dll`、`swresample-7.dll`、`swscale-10.dll`、`avfilter-12.dll`、`avdevice-63.dll` 动态链接。
- 所有 DLL 与 exe **同目录**、**保持原名**，未做任何混淆或版本号重写。
- 用户可直接用自编译的同版本 DLL 覆盖这些文件（文件名保持不变即可）。YTVDLT **不校验 FFmpeg DLL 的签名**，也不阻止替换；程序启动时的自检只检查 `ffmpeg.exe` / `ffprobe.exe` 是否存在与可执行。
- 覆盖方式（给用户的操作说明）：关闭 YTVDLT → 进入安装目录 `resources\runtime\ffmpeg\` → 用自编译 `av*.dll` / `sw*.dll` 覆盖同名文件 → 重新启动。便携版同理（解包目录下 `resources\runtime\ffmpeg\`）。

## 3. 源码获取（清单第 3、4 条）

| 项 | 值 |
|---|---|
| 精确版本串 | `n9.0.2-47-gb204e94e90-20261104`（manifest 的 `version` 字段） |
| 对应 FFmpeg 提交 | `b204e94e90`，tag `n9.0.2-47-gb204e94e90` |
| 在线浏览 | `https://github.com/FFmpeg/FFmpeg/tree/n9.0.2-47-gb204e94e90` |
| 源码归档 | `https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n9.0.2-47-gb204e94e90.tar.gz` |
| 构建工程 | `https://github.com/BtbN/FFmpeg-Builds`（含 `build.sh` 与 release 产物） |
| 随包二进制来源 | `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip` |

> **未入库说明**：源码归档**不随安装包分发**，以稳定链接形式提供；若甲方要求「必须随包附源码 zip」，需在 `extraResources` 增加一个约 15 MB 的条目，属配置变更，须单独确认。

## 4. 编译方式（清单第 5 条）

BtbN 的 `lgpl-shared` 构建使用（摘录自其 `build.sh` / workflow）：

```
./configure --prefix=... --enable-shared --disable-static \
            --disable-autodetect --enable-ffnvcodec \
            --disable-gpl --disable-nonfree ...
make -j$(nproc) && make install
```

关键点：**无** `--enable-gpl`、**无** `--enable-nonfree`，因此不含 x264 / x265 / libvpx 等 GPL/专利组件。完整参数以 BtbN 仓库该 release 对应的 `build.sh` 为准。

## 5. 「关于」框声明（清单第 7 条）

已落地（**本轮未改任何 UI 文件**，文案本就正确）：

- 中文：`FFmpeg 采用 LGPL-3.0，源码与许可全文见 THIRD_PARTY_NOTICES。` → `packages/ui/src/i18n/messages.js:153`
- 英文：`FFmpeg is LGPL-3.0; see THIRD_PARTY_NOTICES for sources and the full licence.` → `packages/ui/src/i18n/messages.js:304`

配套：`M5Host.aboutInfo()` 提供 `appVersion` / `runtimeDir` / `dataDir` / `runtime: ['yt-dlp','node','ffmpeg']` / `license: 'LGPL-3.0'`，供「关于」面板展示运行时三件套与数据目录。

## 6. EULA 条款模板（清单第 8 条）

以下条款须原样进入最终 EULA（中英版本语义一致）：

1. 本软件包含 FFmpeg 项目的库，依 **LGPL-3.0** 授权，与本软件自有部分分离。
2. 用户有权修改随包的 FFmpeg 库并以同名文件替换，本软件不阻止该行为，也不因此拒绝提供服务。
3. 本 EULA **不禁止**对 FFmpeg 组件进行反向工程（自有代码部分的反向工程限制另列，且不扩展至 FFmpeg）。
4. 甲方**不主张**对 FFmpeg 代码的任何著作权；FFmpeg 版权归其作者所有。
5. FFmpeg 源码获取方式见 §3；本软件不因分发 FFmpeg 而承担源码开放义务（动态链接 + 可替换）。

## 7. 自有代码与 Seal 的关系（干净室）

YTVDLT 不复制 Seal 的源码；按任务书 §3.6 以干净室方式重写，与 Seal 的 GPL-3.0 无衍生关系。改名原因与依据见 `docs/DECISIONS.md`。本软件**不启用** GPL 构建的 FFmpeg，故自有代码不因 FFmpeg 被迫 GPL。

## 8. 待办（须甲方决定，乙方不代签）

| 项 | 说明 |
|---|---|
| 自有许可 | 仓库当前 `private: true`，未声明对外许可。开源/分发前须由甲方选定（MIT / Apache-2.0 / 闭源 EULA 均可与 LGPL-3.0 动态链接共存） |
| 是否随包附 FFmpeg 源码 zip | 见 §3 末注；会增加约 15 MB 体积 |
| 代码签名证书 | 与合规无关但影响 SmartScreen 体验，属采购项（U5） |

## 9. aria2c（GPL-2.0-or-later，独立进程）

- **性质**：独立可执行程序（`resources/runtime/aria2c.exe`），YTVDLT 通过 `spawn` 以 `yt-dlp --downloader aria2c` 调用，**不链接、不静态合并、不作为库加载** → 属聚合分发，GPL 不覆盖自有代码。
- **随包义务**：`ARIA2-COPYING.txt`（GPL-2 全文）与 exe 同目录；源码 `https://github.com/aria2/aria2/tree/release-1.35.0`。
- **可替换**：不校验签名、不做完整性绑定，用户可覆盖为自编译版本；删除后下载回落 yt-dlp 原生分段。
- **EULA 增补条款**：本软件随包分发 aria2（GPL-2.0-or-later）的未修改二进制，其源码可由上述地址获取；甲方不主张对 aria2 代码的任何著作权，亦不限制用户替换该程序。
- **版本差异**：二进制自报 1.35.0，取得渠道的包名写 1.36.0 —— 以二进制为准，已在 `THIRD_PARTY_NOTICES.md` §1.1 登记。
