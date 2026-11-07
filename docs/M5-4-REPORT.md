# M5-4 · 打包块报告（国内网 N1 已放行后实测）

> 日期 **2026-11-07** ／ 对应 commit **C1** ／ 决策 **D-61**
> 环境：Windows 10 22631 ／ Node 22.22.2 ／ pnpm 9.15.9 ／ Electron **45.2.2**（二进制已就位）／ electron-builder **26.18.0** ／ electron-updater **6.8.11**
> 口径：本报告分两栏。**栏①只写实测过的**（附命令、路径、层级）；**栏②只写代码就绪 / 待 gate / SKIPPED**，绝不用「已完成」「通过」描述未实测项。

---

## 栏① · 已实测（附证据）

### 1. N1 依赖与 Electron 二进制

| 实测项 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 打包依赖安装 | `pnpm install`（复用 store，44 s） | `electron-builder@26.18.0`、`electron-updater@6.8.11` 进入根 `devDependencies`，锁文件新增 203 个包、**0 个包消失** | `pnpm-lock.yaml`；`scripts/frozen-gate.mjs` 判定 `removed=[]` |
| Electron 预编译二进制 | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js` | 357 MB 解压完成，`dist/version` = `45.2.2` | `node_modules/electron/dist/electron.exe`（249,469,440 B） |
| 类型检查 | `pnpm turbo run typecheck` | **5/5 successful** | 终端输出 |

> 说明：官方 `github.com` 拉取在本机 `fetch failed`（国际网未放行），改用 **npmmirror 国内镜像**，属 N1/N2 范围内的换源，不是访问 GitHub。

### 2. 构建链（新增，零新增直接依赖）

| 实测项 | 命令 | 结果 |
|---|---|---|
| 主进程 bundle | `node scripts/build-desktop.mjs` | `apps/desktop/dist/main/main.cjs` **178.6 KB**（ESM→CJS，`electron` 外部化） |
| preload bundle | 同上 | `apps/desktop/dist/preload/bridge.cjs` **2.3 KB**（CJS，sandbox 兼容） |
| 渲染层 | 同上 | `packages/ui/src/**` 整树复制到 `dist/`（页面引用 `../../styles/…`，`../../i18n/…`） |
| 图标 | `node scripts/make-icon.mjs` | `apps/desktop/build/icon.ico` **279 KB**，16/32/48/256 四尺寸 BMP-in-ICO |

> 构建用的是 vite 已带来的 `esbuild@0.28.2`（`node_modules/.pnpm/`），**没有向 `package.json` 新增任何 bundler** —— 否则会撞 D-61 R2 白名单。

### 3. 打包产物（真实产物，非纸面）

| 产物 | 体积 | SHA-256 |
|---|---|---|
| `dist/YTVDLT Setup 0.1.0.exe`（NSIS 安装版） | 215.7 MB | `ba2d43e240352aa6cb146e5d963bbc13c25e5b6bfc72f1ebd9e96c6e96f5d1aa` |
| `dist/YTVDLT-Portable-0.1.0.exe`（便携版） | 192.5 MB | `e36ce86d4c763c3ae309478685d7aa7fa4fb29909c6865a43cd6d108bcfab221` |
| `dist/win-unpacked/YTVDLT.exe` | 238.1 MB | `040ee7db5c30b3453a4fb056ce7dc9bc4defd223d2149d1ea1c590c752efdfb1` |
| `dist/win-unpacked/resources/app.asar` | 0.6 MB | `98e03d0614d6515259cf19c99a290690f61c8c51e8b7016f75b773d0a14fd7c0` |

- **图标已嵌入**：`YTVDLT.exe` 由 249,469,440 B 增至 249,717,760 B（**+248,320 B**），与四尺寸 ICO 资源增量一致；`electron-builder` 不再输出 `default Electron icon is used`。
- **`app.asar` 内容实测**（`@electron/asar.listPackage`，46 个条目）：含 `\apps\desktop\dist\main\main.cjs`、`\apps\desktop\dist\preload\bridge.cjs`、`\apps\desktop\dist\pages\queue\index.html`、`\package.json` —— 与 `files` 白名单一致，**`runtime/**` 不在 asar 内**（走 `extraResources`）。

### 4. 真实启动（不是「能打包」而是「能跑」）

| 实测项 | 命令 | 结果 |
|---|---|---|
| 开发态启动 | `electron apps/desktop/dist/main/main.cjs` | 主进程 + 渲染 + GPU 共 4 个进程存活，页面加载到 `file://…/pages/queue/index.html` |
| 打包态启动 | `dist/win-unpacked/YTVDLT.exe --enable-logging` | 4 个 `YTVDLT.exe` 进程存活，无崩溃日志 |
| 便携数据目录探针 | 同上，检查 exe 同目录 | `dist/win-unpacked/config/` 被创建 → 探针判定「exe 目录可写 → 便携模式」生效 |
| 界面渲染 | `electron scripts/capture-ui.cjs`（`capturePage()`） | `reports/ui-shot.png`：4 个 Tab（全部 6 / 下载中 3 / 已完成 1 / 已取消 2）、6 张任务卡、深浅色主题正常 |

> `reports/ui-shot.png` 是 Electron 自己 `capturePage()` 出来的 PNG，不是手绘，也不是设计师画稿。

### 5. 打包块单测

| 文件 | 用例数 | 覆盖点 |
|---|---|---|
| `tests/unit/frozen-gate.test.ts` | 14 | R1/R2/R3 全分支 + lockfile 解析（scoped 名、peer 后缀） |
| `tests/unit/data-dir.test.ts` | 7 | 可写→portable / 不可写→appdata / 仅 unlink 失败仍 portable / 自定义探针名 / dev 分支 / 真 fs 往返 |
| `tests/unit/runtime-paths.test.ts` | 4 | dev 与 packaged 两态、`resourcesPath` 拼接、packaged 分支不含 `cwd` |

### 6. §0.4 差异留痕

v2.1 交接书记 `151a56e`；本轮实测起点为 `e3c0d84` + `f39320d`（v2.2 交接包）。不影响任何施工步骤，已在 **D-61 ⑥** 登记，**未改写甲方文档**。

### 7. `electron-builder.yml` 核对结果（§6.2-⑥）

| 项 | 核对结果 |
|---|---|
| `files` | **仅** `apps/desktop/dist/**/*` + `package.json`，**未**包含 `resources/runtime/**`（asar 内无法 spawn 外部 exe）→ 保持不变 |
| `extraResources` | `resources/runtime/win-x64` → `resources/runtime`（flatten `win-x64/`）→ 保持不变；实测 `resources/runtime/{yt-dlp.exe,node.exe,ffmpeg/}` 就位 |
| `nsis` / `portable` / `appId` / `productName` | 一字未动 |
| **唯一改动** | `win.signingHashAlgorithms` → `win.signtoolOptions.signingHashAlgorithms`（electron-builder 26 schema 变更；不改则 `configuration.win should be one of these: null`，打包 0 产物）→ 见 **D-61 ④** |

### 8. 环境边界（不许略过）

- `resources/runtime/win-x64/` 下的 `yt-dlp.exe` / `node.exe` / `ffmpeg/**` **被 `.gitignore` 第 16–20 行忽略、未入库**，仅本机工作区磁盘就位。`clone` 之后或干净 VM **没有这些文件**，打包会产出 `extraResources` 为空的包。本报告所有产物结论**只对本机成立**。
- 安装包**未做代码签名**（`CSC_IDENTITY_AUTO_DISCOVERY=false`，electron-builder 明确输出 `no code signing certificate configured, signing is skipped`）。首次运行会触发 SmartScreen「Windows 已保护你的电脑」，需点「更多信息 → 仍要运行」。这是**签名限制，不是功能缺陷**，已在 `README.md` 与 `M5-6-REPORT.md` 登记。

---

## 栏② · 代码就绪 / 待 gate / SKIPPED

| 项 | 状态 | 原因 / 依赖 |
|---|---|---|
| 干净机安装（C13）、便携版（C14） | **待 gate** | 需干净 Win10/11 x64 虚拟机。本机已有 Node / Python / 开发工具链，**不能**用它冒充「干净机」 |
| 运行时完整性（C15：删任一 exe → `ENGINE_MISSING` 等提示） | **待 gate** | 逻辑已在 `check-runtime` / `RuntimeResolver` 落地并被 M1–M4 覆盖，但「删文件后仍不崩」需真机演练 |
| 系统污染（C16：PATH / 卸载残留） | **待 gate** | 需真机安装 → 卸载流程 |
| 四件套 + SHA-256 全量校验 | **部分实测** | `runtime-manifest.json` 13 项（M5-0 核过 12 项 + 本轮新增 aria2c）；**打包后**（`resources/runtime/`）的逐一校验未跑，列为待 N2 的补充动作 |
| 应用自更新 v1→v2 真机实测 | **待 gate** | 必须先有可用的 generic 更新源与第二版产物（N2/N3） |
| 便携版 `userData` 跟随 | **未做（登记）** | Electron 的 Chromium 缓存仍在 `%APPDATA%\YTVDLT`；本轮不改 `app.setPath('userData')`，避免影响单实例锁与缓存语义 → D-61 ⑤ 遗留 |
| 代码签名 | **不做** | 需证书（U5），属甲方采购项，乙方不代签 |

---

## 附 · 2026-11-07 追加：aria2c 随包（D-65）

甲方要求把 aria2c 一并捆进安装包（原口径是「用户自备、可选」）。本轮已完成：

| 项 | 结果 |
|---|---|
| 二进制 | `resources/runtime/win-x64/aria2c.exe` 5,117,952 B，`aria2c --version` 自报 **1.35.0**（GPL-2.0-or-later） |
| 清单 | `runtime-manifest.json` 追加 `kind/group = aria2c` 条目（`required:false` —— 它是加速器，不是硬依赖；缺失时下载回落 yt-dlp 原生分段） |
| 是否被真正调用 | **是**。本地直链实测：`[debug] Invoking aria2c downloader`，命令行含 `-x16 -j16 -s16`，1 MiB 文件下载成功（本地 HTTP、非在线站点） |
| 装配 | `network.aria2cPath` 三态：`null/未设` → 用随包 exe；非空字符串 → 用用户指定的；`''` → 显式关闭 |
| 顺带修的 BUG | 原实现把 exe 路径塞进 `--downloader-args aria2c:<path>`，而该参数会被 yt-dlp 原样拼进 aria2c 命令行 → 路径被当成额外下载目标。改为只发 `--downloader aria2c`，由引擎把所在目录注入子进程 `PATH` |
| 体积影响 | 便携版 190.9 → **192.5 MB**（+1.6 MB 压缩后；裸 exe 5.1 MB）；安装版 214.1 → **215.7 MB** |
| 合规 | `THIRD_PARTY_NOTICES.md` §1.1 与 `LICENSE-COMPLIANCE.md` §9 登记 GPL-2.0-or-later、源码地址、可替换性、聚合分发论证 |
