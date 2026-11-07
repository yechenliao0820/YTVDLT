# M5-6 · 合规与收尾报告（文档 / L3 口径 / 产物）

> 日期 **2026-11-07** ／ 对应 commit **C3** ／ 决策 **D-63**
> 口径：本轮放行的是**国内网（N1/N2）**——能装依赖、能拉 Electron 预编译包、能打包；**不能**访问 GitHub Releases 与真实站点。因此「能打包」不等于「能发布」。

---

## 栏① · 已实测（附证据）

### 1. 六份文档产出

| 文档 | 内容要点 |
|---|---|
| `docs/THIRD_PARTY_NOTICES.md` | 随包 13 项运行时逐个 SHA-256（含 aria2c）+ 开发期依赖分离 + §12.5 **十二条逐条证据** + 旧文案差异登记 |
| `docs/LICENSE-COMPLIANCE.md` | LGPL-3.0 判定依据、DLL 可替换操作说明、源码 tag 与归档链接、编译参数、EULA 五条模板 |
| `docs/BUILD.md` | 前置条件、国内镜像命令、`node-linker=hoisted` **条件项**说明、三件套就位、build/package 全命令、**五个常见坑** |
| `README.md` | 下载页固定声明（LGPL-3.0）、SmartScreen / 未签名说明、功能表、**已知边界表**、数据与隐私 |
| `docs/ACCEPTANCE.md` | 只指路不抄数，五套串行跑法，M5 门控表，8 PASS + 2 SKIPPED 口径，L4 打包层待办 |
| `docs/SHORTCUTS.md` | 14 条绑定 + `editingSafe` 分流规则 + 冲突检测 |

### 2. 「关于」框 LGPL-3.0 声明（R-5.3-3，已满足、无需订正）

| 语言 | 文案 | 行号 |
|---|---|---|
| 中文 | `FFmpeg 采用 LGPL-3.0，源码与许可全文见 THIRD_PARTY_NOTICES。` | `packages/ui/src/i18n/messages.js:153` |
| 英文 | `FFmpeg is LGPL-3.0; see THIRD_PARTY_NOTICES for sources and the full licence.` | `packages/ui/src/i18n/messages.js:304` |

**本轮 `packages/ui/**` 零改动**（`git diff` 可证）。理由是文案本就正确：触发条件「如含 LGPLv2.1 措辞须订正」不成立，而改 UI 会牵动 DOM 基线 + `i18n.test.ts` + `settings-*` e2e 基线，收益为零。

配套的运行时数据已就绪：`M5Host.aboutInfo()` 返回 `appVersion` / `runtimeDir` / `dataDir` / `runtime: ['yt-dlp','node','ffmpeg']` / `license: 'LGPL-3.0'`，在 `tests/unit/m5-host.test.ts` 的 3 个用例中被逐字段断言。

### 3. 打包产物 SHA-256（**不是「待 gate」，已实际产出**）

设计方案把这段写成「待 gate（须 N1）」。N1 已放行并已完成打包，故此处给**真实哈希**：

| 产物 | 体积 | SHA-256 |
|---|---|---|
| `dist/YTVDLT Setup 0.1.0.exe` | 215.7 MB | `ba2d43e240352aa6cb146e5d963bbc13c25e5b6bfc72f1ebd9e96c6e96f5d1aa` |
| `dist/YTVDLT-Portable-0.1.0.exe` | 192.5 MB | `e36ce86d4c763c3ae309478685d7aa7fa4fb29909c6865a43cd6d108bcfab221` |
| `dist/win-unpacked/resources/app.asar` | 0.6 MB | `98e03d0614d6515259cf19c99a290690f61c8c51e8b7016f75b773d0a14fd7c0` |

校验方式：

```bash
sha256sum "dist/YTVDLT Setup 0.1.0.exe" "dist/YTVDLT-Portable-0.1.0.exe"
```

> 这些产物**不入库**（`dist/` 与 `*.exe` 被 `.gitignore` 忽略）。哈希只对本机这一次构建有效；重新打包会变（NSIS 时间戳）。

### 4. 体积与「零依赖」的对应关系

| 组成 | 实测 |
|---|---|
| 安装包（NSIS，压缩后） | 214.1 MB |
| 便携版（单 exe） | 190.9 MB |
| 解包后目录 | 636 MB |

与任务书 §12.6 的估算（安装包 250–350 MB、安装后 500–700 MB）相比，**实际更小**：Electron 45 + yt-dlp 23 MB + node 94 MB + FFmpeg lgpl-shared 约 154 MB。原因是未打包 `node_modules`，且 FFmpeg 只留 shared 构建。

---

## 栏② · 待 gate / SKIPPED（如实标注）

### 1. L3（在线实测）

**国际网未放行，L3 先记 SKIPPED，等我另行通知。**

具体涉及：真实站点下载、`A-4.4-28` 引擎在线更新、`A-4.4-29` 应用更新 v1→v2。三条都不以本地 L2 / L0 的结果改判。

### 2. 打包层（L4-packaging）

| 用例 | 状态 | 原因 |
|---|---|---|
| C13 干净机 · 安装版 | **待 gate** | 需无 Node / Python / FFmpeg / Chrome、未装 VC++ 运行库的全新 Win10/11 x64 虚拟机。本机是开发机，**不能**冒充干净机 |
| C14 干净机 · 便携版 | **待 gate** | 同上；另需验证注册表无安装项、PATH 前后无变化 |
| C15 运行时完整性 | **待 gate** | 「删掉任一 exe 后仍给出 `ENGINE_MISSING` / `JS_RUNTIME_MISSING` / `FFMPEG_MISSING` 且不崩」需真机演练；自检逻辑本身已被 M1–M4 覆盖 |
| C16 不污染系统 | **待 gate** | 需真机安装 → 使用 → 卸载全流程；「用户下载目录中的成品文件不被删除」须实测 |
| U7 干净机 UCRT 实测 | **待 gate** | 同上环境要求 |

### 3. 签名与分发

| 项 | 状态 |
|---|---|
| 代码签名证书 | **无**（`CSC_IDENTITY_AUTO_DISCOVERY=false`，electron-builder 输出 `signing is skipped`）。SmartScreen 首次运行会拦一次，需点「更多信息 → 仍要运行」。**签名限制，非功能缺陷** |
| 自有许可（`LICENSE`） | **未声明**（`private: true`）。开源/分发前须甲方选定，乙方不代签 |
| 更新源托管 | **未做**。需 generic feed + `latest.yml` + 第二版产物；且 `files` 不含 `node_modules`，`electron-updater` 目前不进 asar（D-62 ③ 遗留） |

### 4. `releaseReady`

**`releaseReady = false` 不改写。** 理由：C13–C16 一项未做，L3 未做，无签名，无自有许可。产出一个「能装能跑」的包 ≠ 可以对外发布，两者之间还差一整轮干净机验收。
