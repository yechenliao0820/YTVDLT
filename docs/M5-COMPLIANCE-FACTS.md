# YTVDLT · M5-6 合规事实核查表（QA 只读产出）

> 产出人：严过关（Yan）／QA 工程师 · 任务 #5 第一阶段
> 日期：2026-11-06 · 状态：**纯只读事实核查**
> 用途：供工程师撰写 `docs/THIRD_PARTY_NOTICES.md`、`docs/LICENSE-COMPLIANCE.md`、`docs/ACCEPTANCE.md`、`README.md` 时**逐条引用真实路径/字段**，避免把「缺失」写成「具备」。
> 约束遵守情况：未修改项目内任何文件；未执行任何联网命令；未运行任何会写 `reports/` / `coverage/` 的命令。仅执行了 `ls` / `sed -n`（只读显示）/ `grep` / `git ls-files` / `git check-ignore` / `git status --short` 等只读命令。本文件写在**项目外** `m5-staging/`。

## 0. 核查范围与证据等级定义

**已读输入**：原始任务书 `YTVDLT_HANDOFF.md`（§3.6 / §5.2 F1–F18 / §5.3 / §6.7 / §12.4 / §12.5 / §12.7 / §12.8 / §12.9）、`docs/M5-HANDOFF-V2.md`（§5.3 / §6.2）、`docs/DECISIONS.md`（D-05 / D-06 / D-08 / D-09 / D-60 + U3 实测结论段）、仓库实物、`m5-staging/M5-DELTA-PRD.md` v1.1、`M5-DELTA-DESIGN.md`、`M5-NETWORK-GATE.md`（仅用于查冲突）。

**证据状态取值**（任务书要求的三档之外，为不把缺失写成具备，增设「部分存在」一档）：

| 状态 | 含义 |
|---|---|
| **存在** | 仓库内或本机磁盘上有**可直接复核的文件/字段**，路径已给出 |
| **部分存在** | 有元数据或间接叙述证据，但**官方要求的直接实证缺失或字段不闭环**；合规文档必须写明缺口 |
| **缺失** | 仓库内**没有**对应文件或字段；文档须写「缺失 / 待补」，不得写成已履行 |
| **需 gate 后才有** | 证据的成立依赖 N1（装依赖/打包）、N2（取发布包）、N3（国际网）或真机/干净 VM 实测 |

**贯穿全表的两条硬事实**：

1. `git ls-files resources/runtime/win-x64/` 只返回 **5 个文本文件**：`FFMPEG-LICENSE.txt` / `README.md` / `SHA2-256SUMS` / `runtime-manifest.json` / `runtime-manifest.schema.json`。
2. `git check-ignore -v` 实测：`yt-dlp.exe`（`.gitignore:16`）、`node.exe`（`:17`）、`ffmpeg/` 整个目录（`:18`）、`reports/**/*.json`（`:8`）**全部被忽略、未入库**。所以下表凡涉及二进制，一律是「**本机磁盘已就位**」，**不是**「随仓库自带 / 已随包分发」；打包产物（`extraResources` 平铺）在 N1 gate 之前并不存在。

---

## 1. 许可证事实结论

### 1.1 结论：随包 FFmpeg 为 **LGPL-3.0**（GNU LGPL Version 3, 29 June 2007）

| 证据 | 真实内容 | 位置 |
|---|---|---|
| 随包许可证全文 | 首行 `GNU LESSER GENERAL PUBLIC LICENSE`，第 2 行 `Version 3, 29 June 2007`；全文 166 行 / **7651 B**，为 LGPLv3 全文 | `resources/runtime/win-x64/FFMPEG-LICENSE.txt`（**已入库**，`git ls-files` 确认） |
| manifest 逐项 `license` 字段 | 10 个 ffmpeg 条目**全部** `"license": "LGPL-3.0"`；`node.exe` = `"MIT"`；`yt-dlp.exe` = `"Unlicense"` | `resources/runtime/win-x64/runtime-manifest.json` |
| 决策留痕 | D-08：「实际随包 `LICENSE.txt`（zip 内 7651 B）与 `ffmpeg.exe -L` 均为 GNU LESSER GENERAL PUBLIC LICENSE Version 3, 29 June 2007」「`runtime-manifest.json` 的 `license` 字段据实记为 `LGPL-3.0`」「**M5 需按 §12.5 逐条复核文案**」 | `docs/DECISIONS.md` D-08 |
| 运行时 README | 「zip 内 `LICENSE.txt` 为 LGPLv3 文本，见 `FFMPEG-LICENSE.txt` 与 DECISIONS D-08」「LGPLv3 全文」 | `resources/runtime/win-x64/README.md:14-15` |
| 施工单 | 「FFmpeg 是 **LGPL-3.0**（不是 2.1+，D-08），12 条逐条给证据」 | `docs/M5-HANDOFF-V2.md §5.3` |

> QA 注：D-08 中「`ffmpeg.exe -L` 为 LGPLv3」属 M1 实测叙述，本轮 QA 为纯只读核查**未复跑该二进制**；可复核的实物证据是 `FFMPEG-LICENSE.txt` 文本 + manifest `license` 字段 + D-08 留痕三者一致。合规文档引用时写「依据 D-08 与随包许可证全文」，不要写成「本轮已复跑 `ffmpeg.exe -L`」。

### 1.2 原始任务书中的**过时文案**（必须显式标出差异并留痕）

| 位置 | 过时原文 | 正确写法 |
|---|---|---|
| §6.7 依赖表（:537） | `LGPL-2.1+` | **LGPL-3.0** |
| §6.7 NOTICE 必含段（:541） | 「本软件使用 **LGPLv2.1** 下 FFmpeg」文案 | 「本软件使用 **LGPL-3.0** 下的 FFmpeg」 |
| §12.5 第 6 条（:867） | `"This software uses code of FFmpeg licensed under the LGPLv2.1 ..."` | `LGPL-3.0`（且源码链接目前缺失，见 §2 #6） |
| §12.5 第 7 条（:868） | 「本软件使用来自 **LGPLv2.1** 下的 FFmpeg 项目的库」 | **LGPL-3.0**（实物 `messages.js` 已正确，见 §4） |
| §5.2 F5（:328） | 「FFmpeg 本体 **LGPL-2.1+**」 | 指上游 FFmpeg 项目默认许可；**本随包 BtbN 9.0 构建的实际文本是 LGPLv3**（D-08） |
| §5.3 补充事实（:347） | 「在下载页与"关于"框注明『本软件使用 **LGPLv2.1** 下的 FFmpeg』」 | 同上 |

**留痕要求**：按 `M5-HANDOFF-V2.md` 开头的权威优先级（原始任务书 ＞ … ＞ DECISIONS），D-08 是**实测事实核查**且原文已要求「M5 需按 §12.5 逐条复核文案」；合规文档须：
① 全文按 **LGPL-3.0** 写；② 在 12 条表里**逐条显式登记**「任务书写 LGPL-2.1+ / LGPLv2.1 → 实物为 LGPL-3.0」的差异并引用 **D-08**；③ 按 `M5-DELTA-DESIGN.md §6.1/A6` 与 PRD v1.1 §4 备注，**不为该差异另立新决策编号**（保持 D-61/62/63 连续），差异并入 D-63 与 `M5-6-REPORT.md`。

### 1.3 代码中残留的过时文案（**新发现，需工程师修正**）

`scripts/fetch-runtime.mjs:203-209` 的**兜底分支**在 zip 内找不到 `LICENSE|COPYING|COPYING.LESSER` 且 `FFMPEG-LICENSE.txt` 缺失/为空时，会写出一份**自造**的许可证说明，其中含：

```
'FFmpeg is licensed under the GNU Lesser General Public License (LGPL) version 2.1 or later.'
'License text: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt'
```

- 当前实物 `FFMPEG-LICENSE.txt` 是 7651 B 的**真 LGPLv3 全文**，说明该兜底**本次未触发**（zip 内 `LICENSE.txt` 被 `:193-198` 命中并原样复制，见 `:199-201`）。
- 但这是**潜在合规回退风险**：一旦上游 zip 改文件名，重建出的 `FFMPEG-LICENSE.txt` 会变回 LGPL-2.1 措辞、自相矛盾于 D-08 与 manifest。
- 建议：把该兜底四行改为 LGPL-3.0 措辞与 `https://www.gnu.org/licenses/lgpl-3.0.txt`，或**改为直接报错**（缺 LICENSE 即拒绝 `--finalize`），不要静默生成错误许可证文本。QA 本轮只读，未修改。

---

## 2. §12.5 十二条逐条核查表

> 「官方要求」列逐字取自原始任务书 §12.5（:856-873）。证据列**只写真实存在的路径/字段**；不存在的写「无」。

| # | 官方要求 | 本仓库真实证据路径 / 字段 | 证据状态 | 备注（不夸大、须如实写入文档） |
|---|---|---|---|---|
| **1** | 不含 `--enable-gpl` / `--enable-nonfree`；用 BtbN `*-win64-lgpl-shared*.zip`；`runtime-manifest.json` 记录来源 | `runtime-manifest.json::items[0..9].sourceUrl` = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip`（10 项一致）；`resources/runtime/win-x64/README.md:14` 来源表；`docs/DECISIONS.md` D-08 叙述「configure 实测 `--disable-libx264 --disable-libx265`」、D-09 / U3 段（:81）「`-encoders` 不含 `libx264`，含 `libopenh264`，符合 LGPL 构建 O-02」 | **部分存在** | 有**选型证据**（asset 名含 `lgpl-shared`）与 DECISIONS 里的实测叙述；但**没有 `ffmpeg.exe -buildconf` / configure 输出落盘**（`reports/` 下无此产物，全仓库 grep `configure` 在 runtime 目录 0 命中）。文档只能写「采用 BtbN LGPL shared 构建」，**不得**写「已实测 configure 无 `--enable-gpl`」；该实证可**离线本地补**（不需联网），但补证前须标「待补」。 |
| **2** | 动态链接（Windows 即链接 DLL），**用户可替换 DLL**；shared 构建、DLL 与 exe 同目录原样分发 | `resources/runtime/win-x64/ffmpeg/` **实际目录清单（10 个文件，7 个 DLL + 3 个 exe）**：<br>`avcodec-63.dll` (91,810,816 B)、`avdevice-63.dll` (5,008,384)、`avfilter-12.dll` (31,876,096)、`avformat-63.dll` (19,888,128)、`avutil-61.dll` (3,025,408)、`swresample-7.dll` (747,008)、`swscale-10.dll` (2,343,936)；`ffmpeg.exe` (551,424)、`ffplay.exe` (19,210,240)、`ffprobe.exe` (269,824)。<br>`runtime-manifest.json::items[0..9].path` 全部以 `ffmpeg/` 开头且逐文件记 `sha256` / `sizeBytes`；`README.md:41`「DLL 与 ffmpeg.exe / ffprobe.exe 同目录」；`apps/desktop/electron-builder.yml:12-16` `extraResources from: resources/runtime/win-x64 → to: runtime, filter: "**/*"`；`scripts/fetch-runtime.mjs:186-188,212` 原样 rename zip `bin/` 条目、不改名 | **部分存在**（文件存在／可替换性未验证） | ① 上述**全部为 `.gitignore:18` 忽略、未入库**的本机磁盘文件，是「已就位」不是「已随包」；打包平铺证据只是**配置**，实际安装包待 N1 gate。② **「用户可替换成自编译 DLL」从未实测**，无任何 relink/替换验证产物 → 属 **需 gate 后才有**（且按 D-08 引述邮件列表，这是随包自带 DLL 时 LGPL 6b 不适用后的核心义务）。文档必须写「shared 构建、DLL 同目录、理论可替换，**替换实测待补**」，**严禁**写「DLL 可替换已验证」。③ 上游 delta 文档写「8 个 LGPL DLL」，**实测为 7 个**（见 §6 冲突 C-2）。④ 实物比 §12.4 目录树多 `ffplay.exe`，NOTICE 组件清单须如实收录。 |
| **3** | 分发 FFmpeg 源码（无论是否修改）；交付物 = `docs/LICENSE-COMPLIANCE.md` 内链接 + 可选随包 `ffmpeg-src.zip` | **无**。`docs/LICENSE-COMPLIANCE.md` 当前 **ABSENT**（`docs/` 目录清单无此文件）；`resources/runtime/win-x64/ffmpeg-src.zip` **ABSENT**（runtime 目录只有 5 个文本文件 + `node.exe` / `yt-dlp.exe` / `ffmpeg/`）；仓库内**没有任何 FFmpeg 源码链接或源码包**。`runtime-manifest.json::items[*].sourceUrl` 指向的是**二进制 zip**，不是源码 | **缺失** | 这是 LGPL 最硬的一条（D-08 引述：「安装包自己提供 DLL 时 LGPL 6b 不适用，**必须准备提供对应源码**」）。`resources/runtime/win-x64/README.md:19-20` 给的 `autobuild-2026-11-04-12-51/...` 仍是**二进制** asset。`scripts/fetch-runtime.mjs:206` 兜底里那句 `Source and build scripts: https://github.com/BtbN/FFmpeg-Builds` 属**未触发的兜底分支**，不是随包证据。文档须写「**待补**：在 LICENSE-COMPLIANCE 内给出与 `n9.0.2-47-gb204e94e90` 精确对应的 FFmpeg 源码获取方式（稳定链接或源码归档）」，**不得**写「源码已随包提供」，**不得**把 `sourceUrl`（二进制）当源码链接引用。 |
| **4** | 源码与二进制精确对应；manifest 记录 BtbN **release tag** 与**对应 FFmpeg commit** | `runtime-manifest.json` 每个 ffmpeg 条目有 `releaseTag` = `"latest/ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip/published:2026-11-04T13:18:35Z"`；`version` = `"n9.0.2-47-gb204e94e90-20261104"`；`sourceUrl` 为 `.../releases/download/latest/...`；`runtime-manifest.schema.json:28,35` 把 `releaseTag` 列为必填；`scripts/fetch-runtime.mjs:82,134-161,280-288,364-365` 解析 `tag_name` / `published_at` 并写 manifest 与 `resources/.cache/ffmpeg-release-tag.txt` | **部分存在** | **releaseTag 字段确实存在**（不是「没有」，请勿误写「缺失」），但：① 值是**滚动 `latest` tag + published 时间戳**，不是固定 autobuild tag；`README.md:18-20` 明确「BtbN `latest` 是滚动 tag；如需完全可复现，改用 `autobuild-2026-11-04-12-51/...`」，而 manifest **实际记录的是 latest 滚动 URL**，D-06 的固定备选**未被采用**；② **没有独立 `commit` 字段**，`version` 里的 `gb204e94e90` 只是 git describe 短哈希线索；`runtime-manifest.schema.json:6,27` 为 `additionalProperties:false`，新增 `commit` 字段须先改 schema；`fetch-runtime.mjs:82` 的 GitHub API 查询**不取 commit sha**。结论：**源码↔二进制精确对应关系未闭环**。文档须写「当前为滚动 latest + published_at，固定 tag 与 commit 精确对应**待补**（可引用 README.md:19 的固定备选）」，**不得**写「已精确对应」。 |
| **5** | 说明编译方式（configure 行 / 构建脚本）；附 BtbN 构建 workflow 与配置链接；交付物 `docs/LICENSE-COMPLIANCE.md` | **无**。对 `resources/runtime/win-x64/` 全目录 grep `configure\|workflow\|buildScript\|commit\|sourceZip\|ffmpeg-src` → **0 命中**；`runtime-manifest.json` 无 configure / workflow 字段；`runtime-manifest.schema.json` properties（`path/sha256/sizeBytes/version/sourceUrl/releaseTag/license/required/kind/group`）**无 configure 字段**且 `additionalProperties:false`；`scripts/fetch-runtime.mjs` 无 configure 行（`:208` 仅写 `Asset: <zip 名>` 到 cache）；`docs/LICENSE-COMPLIANCE.md` **ABSENT** | **缺失** | 唯一相关的是 `DECISIONS.md` D-08/D-09 与 U3 段（:81）的**叙述文字**（`--disable-libx264 --disable-libx265`、含 `libopenh264`），**既不是完整 configure 行，也不是 workflow 链接**。文档须如实写「**缺失，需注明待补**」；可引用 D-08/D-09 的两条部分事实，但**不得**声称「已附完整 configure 行与构建 workflow」。注意 `M5-DELTA-DESIGN.md:139` 要求 LICENSE-COMPLIANCE 含「编译方式」，工程师须以「引用官方 workflow 外部链接 + 标注本仓库未留存 configure 行」的方式写，不能编造仓库内已有证据。 |
| **6** | 下载页声明：README / 下载页固定文案 `"This software uses code of FFmpeg licensed under the LGPLv2.1 and its source can be downloaded here"` | **无**。项目根 `README.md` **ABSENT**（根与 `docs/` 均无）；发布页不存在（未打包）。`resources/runtime/win-x64/README.md` 是**运行时目录说明**（不是下载页），`:14-15` 只写「LGPL（zip 内 LICENSE.txt 为 LGPLv3 文本）」「LGPLv3 全文」，**没有**该英文固定文案，也**没有** `its source can be downloaded here` 的源码下载链接 | **缺失** | 双重问题：① 载体（README / 发布页）不存在；② 原文案本身含**过时版本号 `LGPLv2.1`**，且承诺的「its source can be downloaded here」正是 #3 缺失的源码链接。落地时必须**改用 LGPL-3.0 措辞**；在源码链接补齐前，也不能照抄那句含「source can be downloaded here」的承诺。`M5-DELTA-DESIGN.md:141` 已把根 `README.md` 列为 M5-6 新增项并写明「LGPL-3.0 措辞，不照抄 LGPLv2.1」，与本表一致。 |
| **7** | 「关于」框声明：「本软件使用来自 LGPLv2.1 下的 FFmpeg 项目的库」；UI + 截图验收 | `packages/ui/src/i18n/messages.js:153`（zh）`'about.license': 'FFmpeg 采用 LGPL-3.0，源码与许可全文见 THIRD_PARTY_NOTICES。'`；`:304`（en）`'FFmpeg is LGPL-3.0; see THIRD_PARTY_NOTICES for sources and the full licence.'`。DOM 基线 `tests/e2e/baselines/settings-appearance.dom.html` 与 `settings-en-dark.dom.html` 中**已含这两句 LGPL-3.0 原文**（grep `LGPL` 全 baselines 仅命中这 2 个文件） | **存在** | **已是 LGPL-3.0 → 结论「无需订正」**（详见 §4）。两个必须如实说明的点：① 文案指向的 `THIRD_PARTY_NOTICES.md` **当前 ABSENT**（M5-6 才产出），所以「源码与许可全文见 THIRD_PARTY_NOTICES」在文档落地前是**指向未产出文件**，须写「引用待 M5-6 闭环」；② 措辞与任务书字面不同（「FFmpeg 采用 LGPL-3.0」vs「本软件使用来自 LGPLv2.1 下的 FFmpeg 项目的库」），语义等价且版本正确，**不改**。 |
| **8** | EULA 提及 LGPL；不得禁止反向工程；不宣称拥有 FFmpeg 代码；EULA 模板统一处理，所有译文一致 | **无**。`docs/LICENSE-COMPLIANCE.md` **ABSENT**；项目根与 `docs/` 下 `LICENSE` / `EULA.md` / EULA 模板**均 ABSENT**（逐一核查：根 `README.md`、`LICENSE`、`THIRD_PARTY_LICENSES.txt`、`EULA.md` 全部不存在）；仓库内无任何 EULA 文本 | **缺失** | 文档须写「缺失 / 待补：EULA 条款与译文一致性尚未形成文本」。**不得**写「EULA 已统一处理」「已声明不禁止反向工程」。 |
| **9** | DLL 不得混淆改名（可加前后缀）；保持 `avcodec-*.dll` 等原名 | `resources/runtime/win-x64/ffmpeg/` 实际 7 个 DLL 全部为 upstream 原名（清单见 #2）；`runtime-manifest.json::items[*].path` 与之一一对应；`scripts/fetch-runtime.mjs:186-188,212` 原样 rename、`binNames` 取自 zip 不改写；`README.md:14`「整个 `bin/` 原样放入」；`apps/desktop/electron-builder.yml:15-16` `filter: "**/*"` 无改名规则 | **存在**（本机磁盘 + manifest 记录） | 文件名原样保留可证；但同样**未入库**（`.gitignore:18`），「随包不改名」的最终证据仍待 N1 打包后复核。另注意 `runtime-manifest.json` 的 `kind` 枚举（schema `:38`）把 `ffprobe.exe` 标为 `"kind":"ffprobe"`，其余 ffmpeg 项为 `"ffmpeg"`，属元数据分类，非改名。 |
| **10** | 检查内嵌其它 LGPL 库（如 LAME）；逐一列入 NOTICE | **无**。`THIRD_PARTY_NOTICES.md` **ABSENT**；项目根 `THIRD_PARTY_LICENSES.txt` **ABSENT**（F13 要求收录 yt-dlp standalone exe 内的 PyInstaller 第三方组件）；仓库内无任何「逐一列入」的清单产物 | **缺失** | 两个子项都缺：① FFmpeg 内嵌 LGPL 库（LAME 等）核查清单；② F13 要求的 `THIRD_PARTY_LICENSES.txt`。**注意别混用**：`resources/runtime/win-x64/SHA2-256SUMS` 是 yt-dlp 官方 **20 行二进制哈希清单**（其中 `yt-dlp.exe` 行 = `f5389d36…d177a7d`，与 manifest `:145` 的 sha256 **完全一致**），它**不是**许可证清单、不是 FFmpeg 源码清单。 |
| **11** | 不含 libx264 等 GPL 库；LGPL 构建天然不含；本产品只 remux/合并/转音频；交付物 = M2 实测 mp3 编码可用性（U4） | `docs/DECISIONS.md` D-08「configure 实测 `--disable-libx264 --disable-libx265`」、D-09「实测 `-encoders` 含 `libopenh264`、不含 `libx264`」、U3 实测结论段（`:81`）「编码器实测：`ffmpeg.exe -hide_banner -encoders` 输出含 `libopenh264`（**不含 `libx264`**，符合 LGPL 构建 O-02）；含 `mpeg4` 与 `aac`」；`runtime-manifest.json` 的 `lgpl-shared` asset 名 | **部分存在** | 有**叙述性实测结论**，但：① `reports/` 与仓库内**没有 `-encoders` / `-buildconf` 输出产物**可复核（D-09 指向 `tests/fixtures/manifest.json`，本轮未逐字复核其内容，故只记为 DECISIONS 叙述证据）；② **U4（mp3 / `libmp3lame` 编码器可用性）在任务书 §5.4:358 标为「M2 音频转码验收时实测」，我在 `docs/DECISIONS.md` 全文 grep `U4|libmp3lame|mp3lame` 得到 0 命中**，未见 U4 结论留痕 → 该子项**待补/未留痕**，不得写「mp3 编码可用性已实测通过」。可离线本地补 `-encoders` 输出，不需联网。 |
| **12** | 随包完整许可证文本；`FFMPEG-LICENSE.txt` 与二进制同目录；交付物 `resources/runtime/win-x64/` | `resources/runtime/win-x64/FFMPEG-LICENSE.txt`，**7651 B / 166 行**，LGPLv3 全文，**已入库**（`git ls-files` 确认）；`README.md:15` 记为「LGPLv3 全文」；`scripts/fetch-runtime.mjs:190-201` 从 zip 内 `LICENSE|COPYING|COPYING.LESSER` 原样复制（本次命中，未走兜底） | **存在** | 12 条中**证据最完整、可复核、已入库**的一条，工程师可直接引用。两点如实说明：① 任务书 §12.5 说「与二进制同目录」，而 §12.4 目录树把 `FFMPEG-LICENSE.txt` 画在 runtime **根**、`ffmpeg/` 是子目录 —— **任务书自身不一致，实物按 §12.4**：LICENSE 在 `resources/runtime/win-x64/`，DLL/exe 在 `resources/runtime/win-x64/ffmpeg/`，打包后分别平铺到 `process.resourcesPath/runtime/` 与 `.../runtime/ffmpeg/`，属「同一 runtime 根的相邻目录」，**不是同一个目录**。文档按实物写，别照抄「同目录」。② 实物只随了 **LGPLv3 一份**文本，runtime 目录内**未见 GNU GPLv3 全文副本**（LGPLv3 §3/§4 措辞通常要求随附 GPL 与 LGPL 两份）。此点登记为**待核风险**（本轮 QA 不作法律判定）：工程师需核实 BtbN zip 是否另附 `COPYING` 类文件；在核实前**不要**写「许可证文本已完整齐备、无遗漏」。 |

### 2.1 汇总（给工程师的一句话口径）

- **证据存在（可直接引用）**：**#7、#9、#12**（其中 #9 限于本机磁盘文件名、#12 已入库）。
- **部分存在 / 有缺口**：**#1、#2、#4、#11** —— 有元数据或 DECISIONS 叙述，但缺直接实证或字段不闭环；文档必须逐条写明缺口。
- **完全缺失**：**#3、#5、#6、#8、#10** —— 对应交付物（`LICENSE-COMPLIANCE.md` / `THIRD_PARTY_NOTICES.md` / 根 `README.md` / EULA / 源码链接 / `THIRD_PARTY_LICENSES.txt`）**当前均不存在**，一律写「缺失 / 待补」。
- **需 gate 后才有**：**#2 的「DLL 可替换」实测**、**#12 的「随包后与二进制同目录/相邻目录」打包态复核**、以及 §3 中 Electron 与全部二进制的「已随包」结论（N1 打包后）。

> **红线**：12 条里**只有 3 条**能给出「仓库内可直接复核」的证据。合规文档的正确写法是「逐条列出证据路径 + 对缺失项标待补」，**不是**「12 条均已履行」。施工单 §5.3 的「12 条逐条给证据」应理解为「逐条给**证据或缺失说明**」。

---

## 3. §6.7 组件清单核查

| 组件 | 任务书 §6.7 写的许可证 | **实物/应写许可证** | 是否随包 | 本地是否存在 | 证据路径 |
|---|---|---|---|---|---|
| Electron | MIT（45.2.2 / Node 24.22.2 / Chromium 156） | MIT（F10 / §6.7） | 计划随包 | **声明已入库、二进制缺失**：`package.json:26` `"electron": "45.2.2"` 在 devDependencies；`node_modules/electron/dist/electron.exe` 实测 **MISSING**（B1 / D-39） | `package.json:23-31`、`docs/M5-HANDOFF-V2.md:10`「无 Electron 二进制」、`docs/DECISIONS.md` D-39 / D-31、`apps/desktop/electron-builder.yml` |
| `yt-dlp.exe` | 源码 Unlicense；**standalone exe 另含第三方组件，见 `THIRD_PARTY_LICENSES.txt`（F13）** | manifest 记 `"Unlicense"`；**F13 的第三方组件清单当前 ABSENT** | 计划随包 + `SHA2-256SUMS` 校验 | **本机磁盘已就位、未入库**：23,575,744 B，`.gitignore:16` 忽略 | `resources/runtime/win-x64/yt-dlp.exe`；`runtime-manifest.json::items[11]`（`"path":"yt-dlp.exe"`, `"version":"2026.10.26"`, `"releaseTag":"2026.10.26"`, `"license":"Unlicense"`, sha256 `f5389d36…`）；`resources/runtime/win-x64/SHA2-256SUMS:2`（20 行官方哈希清单，`yt-dlp.exe` 行与 manifest sha256 **逐字一致 ✓**）；`README.md:11-12`；`docs/DECISIONS.md` F13 |
| `node.exe`（EJS 的 JS runtime） | MIT（24.x） | MIT（manifest 记 `"MIT"`） | 计划随包，注入 `--no-js-runtimes --js-runtimes node:<path>` | **本机磁盘已就位、未入库**：93,922,624 B，`.gitignore:17` 忽略 | `resources/runtime/win-x64/node.exe`；`runtime-manifest.json::items[10]`（`"version":"v24.22.2"`, `"releaseTag":"v24.22.2"`, `sourceUrl` = nodejs.org zip, `"license":"MIT"`）；`README.md:13`；`docs/DECISIONS.md` F2/F4、U3 实测段（`:87` 注入参数） |
| `ffmpeg.exe` / `ffprobe.exe` + LGPL DLL | **LGPL-2.1+（过时）** | **LGPL-3.0**（D-08 + `FFMPEG-LICENSE.txt` + manifest 10 项 `"license":"LGPL-3.0"`） | 计划随包（`extraResources`，**不在 asar 内**） | **本机磁盘已就位、未入库**：`ffmpeg/` 共 **10 个文件 = 7 DLL + 3 exe**（完整清单见 §2 #2），`.gitignore:18` 忽略整个目录 | `resources/runtime/win-x64/ffmpeg/`；`runtime-manifest.json::items[0..9]`；`resources/runtime/win-x64/FFMPEG-LICENSE.txt`（唯一已入库的许可证证据）；`apps/desktop/electron-builder.yml:7-16`（`files` 不含 `resources/runtime/**`，`extraResources` 平铺）；`README.md:14-15,35-43`；`docs/DECISIONS.md` D-07 / D-08 |
| `aria2c.exe`（可选） | **GPL-2.0-or-later** | GPL-2.0-or-later（F6） | **不捆绑**：用户自备 + 路径配置 | **不存在**（符合设计，实测 `aria2c.exe MISSING`） | `resources/runtime/win-x64/README.md:16`「**不捆绑**，用户自备」；`docs/DECISIONS.md`「4 项运行时版本」表（:138）`OPTIONAL`，缺失不判 FAIL；F6；`runtime-manifest.schema.json:38-39` 枚举保留 `aria2c` / `group:"aria2c"` 但 `runtime-manifest.json` **无 aria2c 条目** |
| `yt-dlp-ejs` | 官方 exe 内置 / **待确认（F14）** | 待确认（F14：`https://github.com/yt-dlp/yt-dlp-ejs` 返回 **404**） | **不单独获取** | 无独立文件（内置于 exe），仓库内无该组件实物 | `docs/DECISIONS.md` F2 / F14（:325, :337）、F4；`resources/runtime/win-x64/README.md` 来源表未列；NOTICE 应写「官方 exe 内置、未单独分发、F14 待确认」 |
| npm 依赖 | React / Vite / TS / Vitest / Playwright / Zustand「MIT 等 · 开发依赖」 | 实际 devDependencies 仅 **7 个**：`@types/node` / `@vitest/coverage-v8` / `electron` / `tsx` / `turbo` / `typescript` / `vitest`；**React / MUI / Playwright / Zustand / zod / vite 未安装**（只在 `ytvdltPlannedDependencies` 登记） | 开发依赖，不随包 | `pnpm-lock.yaml` 存在；`node_modules/electron/dist` 无二进制 | `package.json:23-42`；`docs/DECISIONS.md` **D-31**（B4 改为零新增依赖静态 HTML/CSS + 原生 JS + 已缓存 `chrome-headless-shell.exe`）、D-40（`test:e2e` 不进 vitest 链）；`docs/M5-HANDOFF-V2.md §5.1` 待装 `electron-builder@^26` / `electron-updater@^6.8`（N1） |

**§6.7 三条易错点**：

1. **NOTICE 不能照抄 §6.7 组件表当「已随包清单」**：React/MUI/Playwright/Zustand **根本没装**（D-31 已改静态 HTML/CSS 载体），Electron 二进制 MISSING，其余运行时二进制被 `.gitignore` 忽略。正确写法是「版本基线 / 许可证 / 分发策略（计划） / 本地证据状态」分列。
2. **各 npm 依赖的逐项许可证清单仓库内无产物**（`THIRD_PARTY_NOTICES.md` ABSENT），须在 M5-6 新建时补齐。
3. `ffmpeg/` 实物含 **`ffplay.exe`**（§12.4 目录树只画了 `ffmpeg.exe` / `ffprobe.exe`），NOTICE 组件清单要如实收录，不要漏也不要声称「已裁剪」。

---

## 4. 「关于」框文案核查（`messages.js → about.*`）

| 键 | 中文（`packages/ui/src/i18n/messages.js:150-155`） | 英文（`:301-306`） |
|---|---|---|
| `about.title` | 关于 YTVDLT | About YTVDLT |
| `about.version` | 版本 | Version |
| `about.runtime` | 运行时：yt-dlp / node / ffmpeg（随包，不入 asar） | Runtime: yt-dlp / node / ffmpeg (bundled, never inside asar) |
| **`about.license`** | **`FFmpeg 采用 LGPL-3.0，源码与许可全文见 THIRD_PARTY_NOTICES。`** | **`FFmpeg is LGPL-3.0; see THIRD_PARTY_NOTICES for sources and the full licence.`** |
| `about.haptics` | 触觉反馈：桌面端无等价硬件，明确省略。 | Haptics: no equivalent hardware on desktop, explicitly omitted. |
| `about.transitions` | 转场动效仅用于状态切换与弹窗，遵循「减少动态效果」。 | Transitions are limited to state changes and dialogs, and respect reduce-motion. |

### 结论：**已是 LGPL-3.0 → 无需订正**

- 任务书 §12.5 第 7 条要求的字面文案含「LGPLv2.1」，**已过时**；现值版本正确、语义等价，**不要改**。
- **改它会触发截图 DOM 基线重建**：实测 `grep -rl "LGPL" tests/e2e/baselines/` 只命中 `settings-appearance.dom.html` 与 `settings-en-dark.dom.html` 两个 DOM 基线，且这两份文件里**字面包含上述中英 `about.license` 原句**。改动 `messages.js` 会连带触发 `i18n.test.ts`（D-55：两语言键集合/占位符一致）与 §6.2-④ 的 DOM 基线 0 容差重建，等于把 M5-2/M5-3 的回归证据作废。`M5-DELTA-DESIGN.md` **A6** 已裁决「无需改文件」，`M5-DELTA-DESIGN.md:154,701` 把 `packages/ui/src/**` 列为红线禁改，与本核查一致。
- **但有两个必须如实写进合规文档的点**：
  1. `about.license` 指向的 `THIRD_PARTY_NOTICES.md` **当前 ABSENT**（M5-6 才产出）→ 该引用在文档落地前是**指向未产出文件**；写「引用待 M5-6 闭环」，**不要**因此改文案。
  2. `about.runtime` 的「随包，不入 asar」是**文案声明**，不是打包实证（M5-4 未做）；不得据此声称「已随包分发」。

---

## 5. 给工程师的注意事项

### 5.1 会构成「夸大 / 想当然」的表述黑名单

| 禁止写法 | 事实 |
|---|---|
| 「FFmpeg 源码链接 / `ffmpeg-src.zip` 已随包提供」 | #3 缺失：无源码包、无源码链接、无 `LICENSE-COMPLIANCE.md`；`sourceUrl` 是**二进制** zip |
| 「clone 后即可复现 / 开箱即用」 | 二进制被 `.gitignore:16-18` 忽略、**未入库**；`scripts/fetch-runtime.mjs` 的 `--verify-only`（`:314-346`）只**校验已存在的本地文件**，不下载；clone 后需**联网**（N2）执行 `--only=<key>` 下载并用 `--finalize` 重建（README.md:22-33、D-05）。且 manifest 记的是**滚动 `latest`** tag（#4），完全可复现性待补固定 autobuild |
| 「DLL 可替换已验证 / 用户可自行编译替换 DLL 已实测」 | #2 无任何 relink / 替换实测产物；只有 shared 构建 + 同目录的**结构性**证据，属 LGPL 4d1 的理论满足 |
| 「已实测 configure 无 `--enable-gpl` / 已附完整 configure 行与构建 workflow」 | #1 / #5：runtime 目录 grep `configure|workflow` **0 命中**，schema 无该字段；只有 D-08/D-09 的叙述片段 |
| 「release tag 与 FFmpeg commit 已精确对应」 | #4：`releaseTag` 是 `latest/...published:...` 滚动值，无独立 `commit` 字段；`version` 里的 `gb204e94e90` 只是 git describe 短哈希 |
| 「EULA 已统一处理、不禁止反向工程已落实、各译文一致」 | #8：无 EULA / LICENSE 文本 |
| 「下载页固定声明已上线」 | #6：根 `README.md` ABSENT、发布页不存在（未打包）；且原文案含过时 `LGPLv2.1` |
| 「内嵌 LGPL 库（LAME 等）已逐一核查并列入 NOTICE」/「`THIRD_PARTY_LICENSES.txt` 已收录」 | #10：`THIRD_PARTY_NOTICES.md` 与 `THIRD_PARTY_LICENSES.txt` 均 ABSENT；`SHA2-256SUMS` 是 yt-dlp 二进制哈希清单，**不是**许可证清单 |
| 「mp3 / `libmp3lame` 编码可用性已实测通过（U4 已闭环）」 | #11：`DECISIONS.md` 全文 grep `U4|libmp3lame|mp3lame` 0 命中，未见 U4 结论留痕；任务书 §5.4:358 把它列为「M2 实测」项 |
| 「许可证文本已完整齐备」 | #12：只随了 LGPLv3 **一份**全文，runtime 目录内未见 GPLv3 副本（待核风险，见 #12 备注） |
| 「本机磁盘已有二进制 ⇒ 已随包 / 已入库 / 已分发」 | `git ls-files` + `git check-ignore` 实测：只有 5 个文本文件入库，全部二进制未入库 |
| 「8 个 LGPL DLL」 | 实测 **7 个 DLL + 3 个 exe = 10 个文件**（见 §2 #2）；上游 delta PRD/NG 文档写 8 个，不符 |

### 5.2 `ACCEPTANCE.md` 与 `reports/`（施工单 §5.3 / §6.2-⑰）

- **必须直接引用** `reports/acceptance-report-m5.json` 与 `reports/e2e-summary.json` 的**字段**（如 `allGreen` / `skipped` / `releaseReady` / `allPass`），**不要手抄数字**（`670 passed`、`30/30`、`8 PASS + 2 SKIPPED` 等）。施工单 §5.3、`M5-DELTA-PRD.md` R-5.3-2 / §8-8、`M5-DELTA-DESIGN.md:142,928` 口径一致。手抄数字会被 `scripts/handoff-check.mjs` 判 **STALE**（施工单 §0.4），且 670 与验收内部 676 是两套口径（§1 提醒），更易抄错。
- 实测三份 JSON **本机存在**：`reports/acceptance-report-m5.json`、`reports/e2e-summary.json`、`reports/layering.json`。
- 但 `git ls-files reports/` 只返回 `reports/.gitkeep`；`git check-ignore -v` 确认 `reports/acceptance-report-m5.json` 与 `reports/e2e-summary.json` 命中 `.gitignore:8`（`reports/**/*.json`）→ **`reports/` 不入库**（施工单 §6.2-⑰、§0.3「不要发」、D-29/D-27）。
- 因此 `ACCEPTANCE.md` 必须同时写明：**「以下字段读自本地生成的 `reports/*.json`，该文件被 `.gitignore` 忽略、不随仓库分发；clone 后需重跑 `node scripts/acceptance.mjs --milestone M5` / `node scripts/run-e2e.mjs` 生成」**。
- 注意不要混淆施工单 §0.3（交接包**不要发** `reports/*.json`）与 §5.3（ACCEPTANCE.md **引用**它们）：前者是交付包内容，后者是仓库内文档引用，二者不矛盾。
- `reports/` 下另有大量 `_qa-*.log` / `_m5-*.log` 本地文件（同样被忽略），不要当成已入库证据引用。

### 5.3 其它落地提醒

- 12 条表的「交付物」列里，`THIRD_PARTY_NOTICES.md` / `LICENSE-COMPLIANCE.md` / 根 `README.md` / `ACCEPTANCE.md` / `BUILD.md` / `SHORTCUTS.md` / EULA 当前**全部 ABSENT**，都是 M5-6 待产出文件；引用它们时写「本文件由 M5-6 新建，见 <路径>」，不要写成「已有文件」。
- 差异留痕按 `M5-DELTA-DESIGN.md §6.1 / A6` 与 PRD v1.1 §4：**不另立 D-64**，并入 D-63 + `M5-6-REPORT.md`；决策编号必须 D-61/62/63 **连续不跳号**（施工单 §6.2-⑩ `M5-GATE-docs`）。
- `docs/PROJECT-HANDOFF.md` 当前 `M` 状态（甲方本地改动），**不提交、不覆盖、不 add**（施工单 §4-3 / §6.2、设计 §6.2 统一排除）。
- 打包前 `resources/runtime/**` 必须走 `extraResources`、绝不进 `files`（`electron-builder.yml:7-16` 已配好，勿「顺手」加 glob，§6.2-⑥）。

---

## 6. 与施工单 / PRD / 上游 delta 文档的冲突与不一致（须回传主理人）

| # | 冲突点 | 事实 | 建议 |
|---|---|---|---|
| **C-1** | 原始任务书 §6.7 / §12.5 / §5.2 F5 / §5.3 写 `LGPL-2.1+` / `LGPLv2.1` | 实物 = **LGPL-3.0**（D-08 + `FFMPEG-LICENSE.txt` + manifest） | 已在 §1.2 列全；按 D-08 写并**逐条留痕差异**（施工单 §5.3 / PRD R-5.3-1 已认同，无实质冲突，属**过时文案**） |
| **C-2** | `M5-DELTA-PRD.md:64,181` 与 `M5-NETWORK-GATE.md:24` 写「**8 个** LGPL DLL」 | `ls` 与 `runtime-manifest.json` 实测 **7 个 DLL**（`avcodec/avdevice/avfilter/avformat/avutil/swresample/swscale`）+ 3 个 exe = 10 个文件 | 合规文档按 **7 个 DLL** 列清单（§2 #2 已给完整名单与字节数）；请 PM/架构同步订正上游两份文档 |
| **C-3** | `M5-DELTA-PRD.md` §8-9 写「**「关于」框同步订正措辞**」；R-5.3-3 写「如 `messages.js` 现有文案含 LGPLv2.1 措辞，须一并订正」 | `messages.js:153/:304` **已是 LGPL-3.0**，条件**不触发**；改它会挂 2 个 DOM 基线 + `i18n.test.ts` + 触发 §6.2-④ 重建 | 以 `M5-DELTA-DESIGN.md` **A6**（无需改文件）与 §4 本核查为准：结论「**无需订正**」，作为已满足项写进 `M5-6-REPORT.md`，**不动 `messages.js`**。PRD §8-9 的无条件措辞建议改为「确认已合规、无需订正」以免误导工程师 |
| **C-4** | `M5-DELTA-DESIGN.md:139` 要求 `LICENSE-COMPLIANCE.md` 含「源码获取链接 / 编译方式 / EULA / DLL 可替换说明」 | 这四项正是 **#3/#5/#8/#2** 的**证据缺失项**，仓库内无对应文件或字段，且其中「源码链接」「clone 可复现」「DLL 可替换已验证」已列入 §5.1 夸大黑名单 | 文档可以写这四节，但必须写成「**官方外部链接 + 本仓库当前缺失/待补/未实测**」，**不得**包装成「仓库内已有证据」；否则 12 条就变成 12 条都想当然 |
| **C-5** | 原始任务书 §12.5 **第 12 条**说 `FFMPEG-LICENSE.txt`「与二进制**同目录**」，而 §12.4 目录树把它放在 runtime 根、`ffmpeg/` 是子目录 | 实物按 **§12.4**：LICENSE 在 `resources/runtime/win-x64/`，DLL/exe 在 `resources/runtime/win-x64/ffmpeg/`；打包后分别在 `runtime/` 与 `runtime/ffmpeg/` | 任务书**自身不一致**；合规文档按实物写「同一 runtime 根的相邻目录」，别照抄「同目录」 |
| **C-6** | 原始任务书 §12.5 **第 4 条**要求 manifest 记「BtbN release tag 与对应 FFmpeg commit」；D-06 说「若 latest 滚动，自动改用固定 autobuild 并把**实际使用的 URL** 写入 manifest」；`README.md:19` 给了固定备选 `autobuild-2026-11-04-12-51` | 实际 manifest **用的是 `latest` 滚动 URL**（`releaseTag = "latest/...published:2026-11-04T13:18:35Z"`），**未采用**固定 autobuild，且**无独立 commit 字段** | 「源码与二进制精确对应」**未闭环**；文档标「待补（可引用 README.md:19 的固定备选）」，不要写「已精确对应」 |
| **C-7** | `scripts/fetch-runtime.mjs:204-207` 兜底分支含 `LGPL version 2.1 or later` 与 `lgpl-2.1.txt` 链接 | 与 D-08 / manifest `LGPL-3.0` / 实物 `FFMPEG-LICENSE.txt` **矛盾**；本次未触发（zip 内 LICENSE 命中），但上游 zip 改文件名即会生成错误许可证文本 | 工程师修正兜底文案为 LGPL-3.0，或改为缺 LICENSE 直接报错（§1.3）；本轮 QA 只读未改 |
| **C-8** | `M5-HANDOFF-V2.md §5.3` 说「`FFMPEG-LICENSE.txt` 已在仓库，**12 条逐条给证据**」 | 前半句属实（`git ls-files` 确认）；后半句若理解为「12 条都有实物证据」则**不成立** —— 仅 #7/#9/#12 可直接引用，#3/#5/#6/#8/#10 完全缺失 | 「逐条给证据」应落地为「逐条给**证据或缺失说明**」，见 §2.1 |
| **C-9** | 施工单 §3「NOTICE / LICENSE-COMPLIANCE / LGPL 12 条逐条｜未写｜属 M5-6」 | 与实物一致（三份文档均 ABSENT） | 无冲突，仅确认 |
| **C-10** | §6.7 把 React / Vite / Playwright / Zustand 列为「常规 MIT 等 · 开发依赖」 | D-31 已改为零新增依赖静态 HTML/CSS；这些包**未安装**，只在 `package.json:32-42` `ytvdltPlannedDependencies` 登记 | NOTICE 组件表按 §3 实物写，别把「计划依赖」写成「已装 / 已随包」 |

---

## 7. 证据索引（本轮实际读过的路径 / 命令，均可复核）

**只读命令**：`ls -la`（runtime 目录 / `ffmpeg/` / `docs/` / staging）、`sed -n`（`messages.js`）、`grep`（`DECISIONS.md` / `fetch-runtime.mjs` / `tests/e2e/baselines/` / `m5-staging/`）、`git ls-files resources/runtime/win-x64/ reports/`、`git check-ignore -v`、`git status --short`、`test -f`。**未执行**任何二进制、任何联网命令、任何写 `reports/` / `coverage/` 的命令。

**关键路径清单**：

| 路径 | 用途 |
|---|---|
| `resources/runtime/win-x64/FFMPEG-LICENSE.txt` | #12、许可证结论（已入库，7651 B，LGPLv3 全文） |
| `resources/runtime/win-x64/runtime-manifest.json` | #1/#2/#4/#9/#12、§6.7（12 个 items，逐项 sha256/version/sourceUrl/releaseTag/license） |
| `resources/runtime/win-x64/runtime-manifest.schema.json` | #4/#5（`additionalProperties:false`，无 configure/commit 字段） |
| `resources/runtime/win-x64/README.md` | #1/#2/#4/#6、§6.7（来源表、`latest` 滚动说明、重建命令、路径约定） |
| `resources/runtime/win-x64/SHA2-256SUMS` | #10、§6.7（yt-dlp 官方 20 行哈希清单；`yt-dlp.exe` 行与 manifest 一致） |
| `resources/runtime/win-x64/ffmpeg/`（10 文件） | #2/#9 DLL 与 exe 实名清单 |
| `resources/runtime/win-x64/yt-dlp.exe` / `node.exe` | §6.7（本机已就位、未入库） |
| `package.json` / `.gitignore` / `pnpm-lock.yaml` | §6.7、入库与忽略判定 |
| `apps/desktop/electron-builder.yml` | #2、§6.7（extraResources、files 不含 runtime） |
| `packages/ui/src/i18n/messages.js` | §4 `about.*` 中英现值 |
| `tests/e2e/baselines/settings-{appearance,en-dark}.dom.html` | §4（含 LGPL-3.0 原句，改动即挂基线） |
| `scripts/fetch-runtime.mjs` | #3/#4/#5/#12、C-7（stale 兜底文案、releaseTag 生成逻辑） |
| `docs/DECISIONS.md`（D-05/06/08/09/31/39/40/55/60、U3 段、F 表引用） | 许可证结论、过时文案、载体偏离 |
| `docs/M5-HANDOFF-V2.md`（§5.3 / §6.2 / §0.3 / §0.4 / §3 / §8） | 施工单口径 |
| `YTVDLT_HANDOFF.md`（§3.6 / §5.2 / §5.3 / §5.4 / §6.7 / §12.4 / §12.5 / §12.7 / §12.8 / §12.9） | 12 条官方要求原文、过时文案 |
| `m5-staging/M5-DELTA-PRD.md` / `M5-DELTA-DESIGN.md` / `M5-NETWORK-GATE.md` | §6 冲突核对 |

---

**核查结论**：许可证按 **LGPL-3.0** 写；12 条中 **#3/#5/#6/#8/#10 完全缺失**、**#1/#2/#4/#11 部分存在**、仅 **#7/#9/#12 可直接引用**；「关于」框**无需订正**；`ACCEPTANCE.md` 引用 `reports/*.json` 且注明「本地生成、不入库」；二进制「本机磁盘已就位、被 `.gitignore` 忽略、未入库」不得写成「随仓库自带 / 已随包」。任务 #5 按主理人要求**暂不标 completed**，待代码完成后做独立回归验证。
