# apps/desktop/src/main — M1 boundary notes

M1 只做「骨架与引擎契约」，本目录的约束如下（违反即返工）：

## 空桩（不得实现）
- `index.ts`：Electron 主进程入口，**不 createWindow**、不 `app.whenReady()`、不建任何窗口。
- `app-host.ts`：单实例锁 / 托盘 / 菜单 / 快捷键（M4/M5）。
- `ipc-gateway.ts`：IPC 白名单 + zod 校验（M3/M4）。
- `../preload/bridge.ts`：`contextBridge` 白名单（M3）。
- `packages/ui/**` 整包在 M1 **不存在**；不产出任何 `.tsx` / `.css`。

## 唯一 I/O 实现点
- `adapters/node-ports.ts`（B2）：全仓库**唯一**允许 `import fs from 'node:fs/promises'` /
  `node:crypto` / `node:child_process` 的文件。`createNodePorts()` 实现 `CorePorts`。

## 唯一 electron import 点
- `runtime-resolver.ts`（B2）：唯一 `import { app } from 'electron'`，只读 `app.isPackaged`
  后组装端口并调用纯 TS Core 的 `checkRuntime()`。
- `runtime-paths.ts`（B2）：纯函数 `resolveRuntimeDir(env)`，开发态/打包态双路径切换。

## 分层铁律
`packages/shared` / `packages/core` / `packages/engine-ytdlp` 的 import 图里
**不得出现** `electron` / `node:fs` / `fs` / `child_process` / `crypto` / `os`。
由 `node scripts/check-layering.mjs` 静态扫描 + `tests/unit/layering.test.ts` 复跑守卫。

## 运行时绝不入 asar
`electron-builder.yml` 的 `extraResources` 把 `resources/runtime/win-x64` 平铺到
`resources/runtime`；`files` 不含 runtime；spawn 全部使用绝对路径 + `argv[]` +
`shell: false` + `windowsHide: true`。
