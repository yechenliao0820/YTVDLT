# M5-0 报告 · 生产 IPC 表面 + 主进程装配

> 日期 2026-11-06 ／ 决策 D-57 / D-59 ／ 对应断言 **A-M5-00**（新增）

## 1. 补齐的三处缺口

M5 开工前，M4 的能力只有「库 + 测试」，渲染层点不到：

| 缺口 | 现状 |
|---|---|
| 模板 CRUD / 任务列表 / 任务详情无 IPC 通道 | **已补 8 条通道** |
| 入口未调用 `createM4Host`、无窗口、无托盘 | **已补 `createM5Host` + `bootstrap` + `electron-entry`** |
| `runner` 之外没有统一注册点 | `mergeGateways()` 合并 M3 fixture 网关与 M5 服务网关，`registerAll()` 一次注册 16 条 |

## 2. 交付物

| 文件 | 说明 |
|---|---|
| `packages/shared/src/ipc.ts` | 仅追加 8 个常量：`TASK_LIST/TASK_DETAIL/TASK_ACTION/TEMPLATE_LIST/TEMPLATE_SAVE/TEMPLATE_DELETE/SETTINGS_GET/SETTINGS_SET` |
| `apps/desktop/src/main/m5-channels.ts` | 8 个 handler + 严格载荷白名单 + DTO 投影（列表无 `url`，详情 URL 掩码） |
| `apps/desktop/src/main/m5-host.ts` | `createM5Host()`：M4 host + M5 通道 + 合并网关 + `appearance()` |
| `apps/desktop/src/main/bootstrap.ts` | 单实例锁、`ipcMain.handle` 注册、加固窗口、托盘菜单、关窗最小化、`--url` → `?prefill=`、系统主题监听 |
| `apps/desktop/src/main/electron-entry.ts` | 唯一 import `electron` 的装配点：ports / logger / mapper / verifier / engine → `createM5Host` → `bootstrap`。**只做类型检查，未运行**（B1） |
| `apps/desktop/src/main/index.ts` | 追加导出 `bootstrap` / `createM5Host` / `M5_CHANNELS` |

## 3. 安全与边界

- 列表 DTO 字段：`id/state/kind/title/uploader/duration/percent/errorCode/artifactCount` —— **没有 `url`**。
- 详情 URL 走 `maskUrlSecrets()`，与错误报告同一套规则（D-32）。
- 模板写入仍经 `validateTemplateArgs()` 正向白名单；`--exec` 一类选项在 IPC 层就被拒。
- 窗口 `webPreferences`：`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`webSecurity:true`。
- 托盘「退出」沿用 `canQuit()`：有活动任务时不退。

## 4. 验证

| 项 | 证据 | 结果 |
|---|---|---|
| 通道契约 | `tests/unit/m5-channels.test.ts` | **14/14 PASS** |
| 组合装配 | `tests/unit/m5-host.test.ts` | **7/7 PASS**（16 通道、重复通道抛错、真实队列/模板/设置贯通） |
| 窗口/托盘/生命周期 | `tests/unit/bootstrap.test.ts` | **7/7 PASS**（假 electron：锁、注册、加固、托盘、二次启动聚焦、dispose） |
| 类型检查 | `pnpm turbo run typecheck` | 5/5（含 desktop 包，`electron-entry.ts` 通过） |

## 5. 未完成（全部指向 N1）

1. `electron-entry.ts` 从未执行：`node_modules/electron/dist` 无二进制。
2. 真实窗口 / 托盘图标 / 系统通知点击聚焦未验证。
3. `systemAppearance.accent()` 目前返回 `null`（未读注册表），需在 N1 后接 `DwmGetColorizationColor`。
4. M3 的 `PROBE` 仍走录制 fixture（D-31），未换成 `engine.probe()`。

## 6. 结论

IPC 表面与装配层在**可离线验证范围内完成**：通道、白名单、脱敏、合并、窗口选项、托盘菜单、深链全部有测试；真实窗口与打包仍被 N1 阻塞，不计入已完成。
