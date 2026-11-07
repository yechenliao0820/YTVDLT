# YTVDLT · M5 联网 gate 表（待甲方逐条确认后才执行）

> 状态：**LOCKED**。甲方本轮只给「国内网类别级放行」，并明确要求「任何联网前先说明类别/命令/耗时并等我确认」。
> 类别级放行 ≠ 任一命令已获执行许可。未获逐条确认，一条联网命令都不执行；不静默重试、不擅自换代理。
> 国际网（N3）本轮不做：报告中记「国际网未放行，L3 先记 SKIPPED，等我另行通知。」，`SKIPPED` 不得写 `PASS`。

## 1. N1 · 国内网（装依赖 / 打包工具链）

| 序 | 命令 / 地址 | 体量·耗时 | 失败后果 | 逐条确认 |
|---|---|---|---|---|
| N1-1 | `pnpm install`（补 `electron@45.2.2`；验 `require('electron')` 与 `node_modules/electron/dist/electron.exe`） | 100–120 MB ／ 5–20 min | 无二进制 → 不能编译主进程、打包、开窗；改 `pnpm-lock.yaml` 触发 frozen 门控（须先完成 D-61 方案 A） | 是 |
| N1-2 | `pnpm add -D electron-builder@^26 electron-updater@^6.8 -w` | 150–250 MB ／ 5–20 min（建议与 N1-1 合并一次） | 无打包/更新库 → 无 exe 与 `latest.yml`；必改 `package.json` + lock → **执行后立刻串行跑 M3、M4 验收**验证方案 A 白名单生效 | 是 |
| N1-3 | `tsc -p tsconfig.json` → `pnpm --filter @ytvdlt/desktop exec electron-builder --win --x64`（首次自动下 NSIS / winCodeSign） | 数十 MB ／ 数分钟 | 工具链未下 → 打包失败；符号链接权限可能报 `EBUSY`（需开「开发人员模式」或以管理员跑一次，属本地设置非联网） | 是（含下游下载） |
| N1-4 | 仅当报 `cannot find module electron`：改 `.npmrc` 为 `node-linker=hoisted` / `shamefully-hoist=true` 后重跑 N1-1 | 等同 N1-1 | 不改则找不到模块；只改配置、**不动业务代码** | 是（改配置 + 重装均报备） |

## 2. N2 · 国内网（下发布包）

| 序 | 命令 / 地址 | 体量·耗时 | 失败后果 | 逐条确认 |
|---|---|---|---|---|
| N2-1 | `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe` | 17–20 MB ／ 秒级 | 仅影响「从官方源拉新版本」的完整实测；**本地 L2 实测不受影响** | 是 |
| N2-2 | `https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS` | KB 级 ／ 秒级 | 同上；本地已有同名清单 | 是 |
| N2-3 | Electron 预编译包（约 100 MB） | ~100 MB ／ 分钟级 | 二进制不全 → 产物无法运行 | 是（多由 N1-1 的 postinstall 触发，与 N1 可能重叠；以真实触发命令报备，不重复放行） |

> 已核实：`resources/runtime/win-x64/` 的 `yt-dlp.exe`(23.5 MB) / `SHA2-256SUMS` / `node.exe`(93.9 MB) / `ffmpeg/`(7 个 LGPL DLL + 3 个 exe) / `FFMPEG-LICENSE.txt` / `runtime-manifest.json` 是**本机磁盘已就位、被 `.gitignore` 忽略、未入库**。引擎更新的「校验 / 写 `.new` 再 rename / 失败回滚 / 暂停队列 / 坏值拒绝」可用**复制到 `os.tmpdir()` 的副本**做离线 L2 实测，不联网；测试绝不写原目录。
> **红线：本地 L2 实测 ≠ L3 真机/在线实测 ≠ 断言转 PASS。** `A-4.4-28` / `A-4.4-29` 维持 `SKIPPED`。

## 3. N3 · 国际网（本轮不做）

| 项 | 状态 |
|---|---|
| 访问 YouTube 做 L3 在线烟测 + C1–C12（3–10 min） | **不在本轮 · 国际网未放行 · L3 在线烟测不做** |
| 报告要求 | 原样落「国际网未放行，L3 先记 SKIPPED，等我另行通知。」；不得写 PASS，不得对外说「YouTube 能下」 |

## 4. 需要甲方拍板

| # | 问题 | 不拍板的后果 |
|---|---|---|
| Q1 | 逐条确认机制与**首批授权范围**（建议首批只授权 N1-1 + N1-2 合并一次）；N2-1/2 是否纳入首批 | 全部停在离线代码 + L2 + 报告 |
| Q2 | GitHub 不通时允许用哪个**国内镜像 / 代理地址**（条件项，仅当甲方要求补做「拉新版本」实测时才需要） | 不能擅自换代理；`A-4.4-28` 维持 SKIPPED |
| Q3 | 是否提供**代码签名证书**；若不提供，是否接受「未签名安装包 + 手动下载覆盖安装 + 报告写明签名限制」降级口径（§6.2-⑬） | 应用自更新 v1→v2 自动安装链路只能按降级口径记录，**不得写 PASS** |

## 5. 放行后的执行顺序（本轮不执行）

0. 前置（非联网）：`node scripts/handoff-check.mjs` + 串行 M1–M5 复验，要求全绿、D-54…D-63 连续、`git status --short` 仅 `M docs/PROJECT-HANDOFF.md`。
1. N1-1 → 2. N1-2 → **立刻串行 M3 / M4 验收**（验证 frozen 方案 A）→ 3. N1-3 出包 → 3.5 `certutil -hashfile <file> SHA256` ×2 + `latest.yml` + 双击自检 4 项 → 4. N1-4（条件）→ 5. N2-3（若独立触发）→ 6/7. N2-1/2（若纳入首批）→ 8. 应用更新 v1→本地 v2 静态目录实测、引擎更新官方源全链路 → 9. Q3 签名口径结论。
2. 产物（`dist/` 下两个 exe 与 `latest.yml`）**不入库**；gate 后产生的证据**另起增量 commit**，如需改约定从 **D-64** 起连续续号，**不 amend** C1/C2/C3。

## 6. 本轮禁止执行清单

`pnpm install` / `pnpm add ...` / `electron-builder ...` / 任何 `curl|wget|Invoke-WebRequest` / 任何访问 `github.com` 或 `youtube.com` / 改 `.npmrc` 后重装。
