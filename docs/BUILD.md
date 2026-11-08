# 构建说明（BUILD）

> 目标平台：**Windows 10 1809+ / Windows 11 x64**。Win7/8/8.1 与 32 位系统不支持（Electron 23 起已移除）。
> 本文档描述的是**本机已实测跑通**的路径，不是理论步骤。

---

## 0. 前置条件

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | **22.x**（实测 22.22.2） | Electron 45 与 electron-builder 26 的最低要求 |
| pnpm | **9.15.9** | `packageManager` 字段已锁定；用 npm 会打乱 workspace 解析 |
| 网络 | **N1/N2 放行**（国内镜像即可） | 需要拉 `electron` 预编译二进制与 electron-builder 的 NSIS/7z 资源 |

### 网络与镜像（国内环境必读）

官方 GitHub 在本机不可达（`fetch failed`）。实测可用的做法：

```bash
# Electron 预编译二进制（约 357 MB）
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js

# electron-builder 的 NSIS / 7z / winCodeSign 资源
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

> `pnpm install` 本身走 npm registry，通常无需额外配置。

### `node-linker=hoisted` 是条件项，不是默认

本仓库使用 pnpm 默认的**符号链接**布局，实测打包正常，**不需要** `node-linker=hoisted`。
只有当 `electron-builder` 报「找不到 native 依赖 / 打包后 `node_modules` 为空」时，才在 `.npmrc` 临时加：

```
node-linker=hoisted
```

并在重新 `pnpm install` 后重跑打包。**不要**把它当成常规配置提交。

## 1. 安装依赖

```bash
pnpm install
```

首次会安装 `electron`（含 postinstall）与 `electron-builder` / `electron-updater`。
若 `node_modules/electron/dist/electron.exe` 不存在（postinstall 被跳过），单独补：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

验证：

```bash
cat node_modules/electron/dist/version   # 45.2.2
```

## 2. 运行时资源（`resources/runtime/win-x64/`）

| 文件 | 必需 | 说明 |
|---|---|---|
| `yt-dlp.exe` | ✅ | 被 `.gitignore` 忽略，**未入库**；干净 clone 需自行放入 |
| `node.exe` | ✅ | yt-dlp 的 EJS 运行时 |
| `ffmpeg/`（8 个文件） | ✅ | BtbN `lgpl-shared` 构建，见 `THIRD_PARTY_NOTICES.md` |
| `SHA2-256SUMS` | ✅ | 引擎自更新用的校验清单 |
| `runtime-manifest.json` | ✅ | 自检与合规登记的唯一来源 |

这些文件**不在 asar 内**（asar 里是虚拟路径，`spawn` 不了外部 exe），只能走 `electron-builder.yml` 的 `extraResources`。
`files` 白名单**只**允许 `apps/desktop/dist/**` + `package.json` —— 不要往里加 `resources/**`。

## 3. 构建产物

```bash
node scripts/build-desktop.mjs
```

输出（`apps/desktop/dist/`）：

| 文件 | 说明 |
|---|---|
| `main/main.cjs` | 主进程单文件 bundle（CommonJS，`electron` 外部化） |
| `preload/bridge.cjs` | preload（CommonJS，`sandbox: true` 兼容） |
| `pages/** styles/** i18n/** theme/** shortcuts/** app-shell.js` | 从 `packages/ui/src` 整树复制 |
| `icon.ico` | 由 `scripts/make-icon.mjs` 生成 |

> **为什么主进程是 CJS 而不是 ESM**：Electron 45 的内建模块在 ESM 下不提供具名导出，`import { BrowserWindow } from 'electron'` 会抛 `SyntaxError: does not provide an export named 'BrowserWindow'`。改用 CJS 后 `require('electron')` 正常。

图标（可重复生成，仓库不存二进制素材）：

```bash
node scripts/make-icon.mjs   # → apps/desktop/build/icon.ico（16/32/48/256）
```

## 4. 打包

```bash
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
CSC_IDENTITY_AUTO_DISCOVERY=false \
  ./node_modules/.bin/electron-builder \
    --config apps/desktop/electron-builder.yml \
    --config.directories.buildResources=apps/desktop/build \
    -c.extraMetadata.main=apps/desktop/dist/main/main.cjs \
    --win nsis portable
```

三个关键参数的作用（都不是可选装饰）：

| 参数 | 为什么必须 |
|---|---|
| `--config apps/desktop/electron-builder.yml` | 配置不在仓库根，必须显式指定 |
| `--config.directories.buildResources=apps/desktop/build` | 默认 buildResources 是**根目录** `build/`；不指过去就用 Electron 默认图标 |
| `-c.extraMetadata.main=apps/desktop/dist/main/main.cjs` | 根 `package.json` 没有 `main` 字段（它同时是 workspace 根），打包后启动会找不到入口 |
| `-c.electronDist=node_modules/electron/dist`（**可选但推荐**） | 直接用已解压的 Electron，跳过每次重新下载 zip。npmmirror 的 CDN 偶发 `502 Bad Gateway`，加上这个参数后打包完全不受网络抖动影响 |

产物（`dist/`）：

| 文件 | 体积（实测） |
|---|---|
| `YTVDLT Setup 0.1.0.exe` | 214.1 MB（NSIS 安装版） |
| `YTVDLT-Portable-0.1.0.exe` | 190.9 MB（便携版） |
| `win-unpacked/` | 636 MB（免安装目录，可直接跑） |

## 5. 自检

```bash
# 类型 + 单测（覆盖率四维 >= 70%）
pnpm turbo run typecheck
npm test

# 分层守卫（UI 禁 node:fs / child_process / electron）
node scripts/check-layering.mjs

# 运行时三件套 + manifest 校验
npm run check-runtime

# 五套验收（必须串行，勿并行）
for m in M1 M2 M3 M4 M5; do node scripts/acceptance.mjs --milestone $m; done
```

## 6. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `configuration.win should be one of these: null` | electron-builder 26 把 `signingHashAlgorithms` 移到 `win.signtoolOptions` 下 | 按当前 `electron-builder.yml` 的写法即可（已修正） |
| 打包报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` | 本机 safe-delete 守卫拦截 electron-builder 清空 `dist/win-unpacked` | 先把旧目录 `mv dist/win-unpacked dist/win-unpacked-prev` 再重跑；**不要**用 `rm -rf` |
| 打包中途报 `SAFE_DELETE_BULK_GUARD_ERROR spawnSync node ETIMEDOUT`（0.1.8 实测） | 守卫对 `win-unpacked` 这类上千文件目录的 10 秒检查偶发超时；Setup 可能已产出而便携版 / `latest.yml` 缺失 | **原样重跑同一条 electron-builder 命令**补齐剩余 target，不要 rm -rf、不要删已产出的 Setup |
| 启动后白屏 | `extraMetadata.main` 漏了，或 `main.cjs` 没被 `files` 收进 asar | 用 `@electron/asar listPackage` 检查 `app.asar` 内是否有 `apps/desktop/dist/main/main.cjs` |
| 托盘无图标 / 用 Electron 默认图标 | `buildResources` 指错 | 加 `--config.directories.buildResources=apps/desktop/build` |
| SmartScreen 拦截 | 安装包未签名 | 点「更多信息 → 仍要运行」；正式分发需买证书（U5） |
| `YTVDLT.exe: bad option: --remote-debugging-port=9222`（0.1.9 实测） | 当前 shell 继承了 WorkBuddy 的 `ELECTRON_RUN_AS_NODE=1`，Electron 被当成 Node 启动，把调试参数当 Node 参数解析 | 启动时清掉继承变量：`env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS ./YTVDLT.exe --remote-debugging-port=9222` |
| 改了 `packages/ui/**` 后 e2e 全红 | 队列页 DOM/像素基线是冻结快照，改 UI 必然不匹配 | **不要改结论也不要全量覆盖基线**：先 `node scripts/run-e2e.mjs --negative-checks` 确认只有预期 case 失败且 `dom=true`（结构断言没破），再对每个受影响 case 跑 `node scripts/run-e2e.mjs --case=<id> --update-baselines`，最后全量 31/31 + 反例 5/5 复验（0.1.9 重建 7 张，0.1.10 重建 9 张含 `settings-*`） |
| 装到 `C:\Program Files` 后下载报 `PERMISSION_DENIED`，stderr 有 `C:\Program Files\YTVDLT\tmpXXXX.tmp`（0.1.10 实测） | yt-dlp 子进程继承了安装目录作 CWD，且没有显式 `TEMP`；`Program Files` 对普通用户只读。**不是**用户没用管理员运行 | 所有子进程 spawn 走 `yt-dlp-engine.ts::spawnBase()`，把 `cwd` 与 `TEMP/TMP/TMPDIR` 钉到可写输出目录；不要建议「以管理员身份运行」绕过（D-89） |
| 桌面快捷方式 / 任务栏还是 Electron 默认「原子」图标 | 只依赖 `buildResources/icon.ico` 的隐式查找不够稳 | 先 `node scripts/make-icon.mjs`，再确认 `electron-builder.yml` 里 `win.icon` / `nsis.installerIcon` / `nsis.uninstallerIcon` 都指向 `apps/desktop/build/icon.ico`；**重新打包**后旧快捷方式才会刷新（D-90） |
