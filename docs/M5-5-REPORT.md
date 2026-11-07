# M5-5 · 更新内核报告（引擎自更新 + 应用自更新）

> 日期 **2026-11-07** ／ 对应 commit **C2** ／ 决策 **D-62**
> 口径：**离线 L2 / 须 N1 / 须 N2（国际网）三层分开写**；②③ 未做不阻塞 ①。本报告分两栏，栏①只写实测，栏②只写就绪/SKIPPED。

---

## 栏① · 已实测（附证据与层级）

### 0. 三层状态总表

| 层 | 内容 | 状态 | 依赖 |
|---|---|---|---|
| **① 离线 L2** | 本地静态目录 + 真 `yt-dlp.exe` 副本 + 真 SHA-256 + 真 `rename()`：校验 / 原子替换 / 回滚 / 暂停队列 / 坏值拒绝 | **已实测（L2-local）** | 无（不联网） |
| **② 须 N1** | 应用更新 v1→v2 真机：`latest.yml` + 二次安装 | **未做** | 需托管 generic 更新源 + 第二版产物 |
| **③ 须 N2/N3** | 从官方 GitHub Releases 拉新引擎二进制 | **未做** | 国际网未放行 |

### 1. 引擎自更新 · 逻辑层（L0，`tests/unit/self-updater.test.ts`，12 例）

| 用例 | 断言要点 |
|---|---|
| 正常链路 | 备份 → 写 `.new` → `rename` → 复验 → 删 `.bak`；`.new`/`.bak` 均不残留；`intakeGate` 调用序列恰为 `pause → resume` |
| 无已装二进制 | 不产生 `.bak` 也能完成替换（首装场景） |
| 校验值不符 | **一个字节都不写**：原文件不变、无 `.new`、无 `.bak`；且**不暂停队列**（没有交换动作就不必打扰队列） |
| 清单缺 `yt-dlp.exe` 行 | 拒绝，原文件不变 |
| 清单拉取抛错 | 拒绝，原文件不变，日志 `error` 带 `source` |
| `rename(.new → 目标)` 失败 | 用 `.bak` 回滚，`rolledBack:true`，原文件恢复 |
| 换后哈希不符 | 回滚，`rolledBack:true` |
| 写盘抛错 | `finally` 仍 `resume`，队列不会永久停摆 |
| `parseChecksums` | 三形态：正常行 / `*` 前缀 + 大小写无关 / 畸形与空输入拒绝 |

### 2. 引擎自更新 · 真文件系统（**L2-local**，`tests/unit/engine-update-local.test.ts`，5 例）

**L2 四要素（缺一不可，逐条给）：**

1. **层级声明**：本地 L2 实测，**非真机、非在线拉取**（不触网，源目录是本机静态文件夹）。
2. **入库边界**：`resources/runtime/win-x64/**` 被 `.gitignore` 第 16–20 行忽略、**未入库**，仅本机工作区磁盘就位；`clone` 后或干净 VM **没有**这些文件，本结论**只对本机成立**。
3. **只读证明**：替换对象是 `os.tmpdir()` 下的**副本**；`resources/runtime/win-x64/` 全程只读，测试末尾再次比对随包 `yt-dlp.exe` 的 SHA-256 未变。
4. **副本路径 + 前后 SHA-256**（`reports/engine-update-l2.json`，本地生成、不入库）：

| 项 | 值 |
|---|---|
| 副本路径 | `C:\Users\leolee\AppData\Local\Temp\ytvdlt-install-WuzweF\yt-dlp.exe` |
| 替换前 SHA-256 | `4f667d3a6e0aee94aa51b4fa16d1ba9a67bfff74245941b5c63d89c03478d742` |
| 替换后 SHA-256 | `91c531a2890d773a7d4f7fc73c043eadebe806cd864a00e4c90c29004fc14cba` |
| 期望 SHA-256（清单值） | `91c531a2890d773a7d4f7fc73c043eadebe806cd864a00e4c90c29004fc14cba`（全等） |
| 残留 scratch | `[]`（`.bak` / `.new` / `.tmp` 全部清净） |
| 随包 `yt-dlp.exe` SHA-256（前后一致） | `f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d`（与 `runtime-manifest.json` 一致） |

其余 4 例：坏值后原文件 SHA-256 逐字节不变；源目录无 `SHA2-256SUMS` 则拒绝；**真 `TaskQueue`** 暂停-恢复后 `intakePaused === false`；`createQueueIntakeGate(() => null)` 在无队列时不抛。

### 3. 暂停队列 = 标志位（L0，`tests/unit/task-queue-intake.test.ts`，6 例）

| 验收点 | 实测 |
|---|---|
| 暂停期间新入队 | `started` 为空、`pendingCount=2`、`activeTaskIds=[]` —— 只入队不启动 |
| 运行中任务 | 不受影响，继续持有 slot；新任务保持 `Idle` |
| 状态终态 | 事件序列中**不出现 `Canceled`**，任务以 `Completed` 收尾 |
| `resume` 补位 | 并发 1 时严格按 `a → b → c` FIFO 顺序逐个启动 |
| 幂等 | 连续两次 `pause` / 连续两次 `resume` 均无副作用 |
| record 不丢 | 暂停期间 `list()` 仍返回该任务 |

> 实现只有三处：`intakePausedFlag` 字段、`pump()` 首行判位、`resumeIntake()` 清位后 `pump()`。**没有** `cancel()`、**没有**写 `Canceled`、**没有**删 record。

### 4. 应用自更新协调器（L0，`tests/unit/app-updater.test.ts`，13 例）

| 场景 | 实测行为 |
|---|---|
| 未配置更新源 | `degraded`，**零网络调用**（`updater.calls` 为空），不打扰用户 |
| 更新源不是 http(s) | `degraded`，不交给 `electron-updater` |
| `{channel}` 占位 | `https://upd.example.org/{channel}` → `…/stable`；配置 `nightly` → `…/nightly` |
| 有更新 | 调用序列严格 `configure → check → download → install`，提示一次 |
| 无更新 | `up-to-date`，**不下载** |
| 检查抛错 | `degraded`，`reason` 含原始错误，**不安装** |
| 下载抛错 | `degraded`，**不安装** |
| 反复失败 | 用户只被提示**一次**（`notifiedOnce` 第二次为 false） |
| 间隔纯函数 | `never` 永不、`daily/weekly` 按窗口、时间戳不可解析视为「该检查」 |

> 全程**没有** `dialog.showErrorBox`，也没有把降级写成 `error` 后弹框。

### 5. 装配（`apps/desktop/src/main/electron-entry.ts`）

- 引擎更新源：仅当 `YTVDLT_ENGINE_SOURCE_DIR` 指向「含 `yt-dlp.exe` + `SHA2-256SUMS` 的目录」时启用（内网/离线部署的真实形态）；未设置则 `selfUpdate()` 返回 `changed:false`，**不假装更新**。
- 队列闸门：`createQueueIntakeGate(() => hostRef?.m4.task.queue)` 惰性取队列，解开「engine 先建、queue 在 host 内」的装配环。
- 应用更新：`advanced.updateFeedUrl` 为空时**整段跳过**；非空才懒加载适配器，模块缺失也只是 `WARNING`。

---

## 栏② · 代码就绪 / 待 gate / SKIPPED

| 项 | 状态 | 原因 / 依赖 |
|---|---|---|
| `A-4.4-28`（yt-dlp 引擎更新 L3） | **SKIPPED（维持）** | 2026-11-07 国际网实测已完成**组件在线更新**：官方 HTTPS 拉取后 `up-to-date`、篡改清单 `checksum-mismatch` 不写盘、正确清单真实覆盖并复验，证据 `reports/l3-component-update.json` / D-71。但 `acceptance.mjs` 状态**不改判**：T4 应用自更新与 C13–C16 未做，且 §11 禁止把 SKIPPED 改 PASS |
| `A-4.4-29`（应用自更新 L3） | **SKIPPED（维持）** | 2026-11-07 T4 端到端已打通（D-75）：`electron-updater` 打进 asar（796,685 B / `NsisUpdater`×15）、`publish` 块产出 `latest.yml` + blockmap + `app-update.yml`、本地 generic 源上真机 v1→v2（0.1.0→0.1.1）全自动完成，断网降级与差分回退均如实实测，证据 `reports/app-update/app-update-smoke.json`。但 `acceptance.mjs` 状态**不改判**：C13–C16（干净机）仍被「需要提升权限」阻塞，§11 禁止把 SKIPPED 改 PASS |
| 应用更新 v1→v2 真机 | **已完成（本地 generic 源）** | 见 D-75 与 `reports/app-update/app-update-smoke.json`。附带发现一个真缺陷：NSIS 更新安装会清空 `$INSTDIR`，便携模式（数据在 exe 同目录）的 config/logs 会被重置——已登记，后续项为数据目录迁出 `$INSTDIR` 或自定义 NSIS 脚本保留数据 |
| 引擎更新在线拉取 | **已完成（N3 已放行）** | 官方 release 资产真实 HTTPS 拉取成功，`reports/l3-component-update.json` 三步全 pass。注意官方 `SHA2-256SUMS` 无 `aria2c.exe` 行，该组件返回明确 `no-checksum-line`，不是静默跳过 |
| `deferred` 文案订正 | **未做（有意）** | `acceptance.mjs` 中 `A-4.4-28/29` 的 `deferred` 仍写「未实现」「未安装」，**已过时**；本轮按 §11 与 D-71 不改验收状态、也不改文案，留痕于本报告 / D-71 / `docs/BLOCKED-2026-11-07.md`。订正仍列为下一轮首项（需串行重跑五套验收） |

### 签名限制说明（§6.2-⑬）

安装包未签名（无证书）。SmartScreen 会拦一次，用户点「更多信息 → 仍要运行」即可。**这是签名限制，不是功能缺陷**，不掩饰、不写「无需理会安全提示」。

### 网络分类口径留痕

分类以原始任务书 §0.1 + 甲方原话为准：**N1 = 包管理器 / N2 = 发布包与预编译二进制 / N3 = 国际站点**。`scripts/acceptance.mjs` 里 `A-4.4-28` 的 `deferred` 把取 `yt-dlp.exe` 写成「N3」属**遗留笔误**（按 §0.1 应归 N2）—— 本轮**不让脚本反向定义分类**，也不改脚本，仅在此与 D-62 ⑤ 留痕。

---

## 附 · 2026-11-07 追加：组件独立更新（D-67）

甲方要求「yt-dlp / aria2c 能单独更新，不用等软件本体」。已落地：

| 项 | 结果 |
|---|---|
| 更新源 | 一个静态 HTTPS 目录：`SHA2-256SUMS` + 各组件二进制。换 `baseUrl` 就能指向 GitHub release 资产 / 对象存储 / 内网共享，**协议不改** |
| 配置 | `YTVDLT_COMPONENT_FEED`（环境变量，部署级）或 `advanced.componentFeedUrl`（用户级）；只接受 http(s)。未配置 → 按钮置灰、**不发任何请求** |
| 界面 | 设置 → 更新 → 「组件更新 yt-dlp/aria2c」+「检查并更新」；状态行显示当前版本 / 未配置源 / 更新中 / 已更新需重启 / 失败原因 |
| 覆盖方式 | 仍是「写 `.new` → rename 覆盖 → 复验 → 留/删 `.bak`」，**不是删了重装**；已最新时直接短路（`reason: 'up-to-date'`），不写盘 |
| 失败语义 | 每个组件独立结算：一个失败不影响另一个；`UpdateResult.reason` 区分 `up-to-date` / `checksum-mismatch` / `download-failed` / `swap-failed` / `manifest-unavailable` / `no-checksum-line` |
| 不更新的 | `ffmpeg/` 与 `node.exe`：与应用版本耦合（ABI / 共享库），只随安装包整体升级 —— 见 D-67 |
| 验证 | L0 13 例（component-updater 8 + http-update-source 5）；e2e 30/30 + 5/5，仅 2 个 settings 基线变动（已核对为新增状态行） |
| 未实测 | **真实 HTTPS 源未跑**（国际网未放行，也还没有你自己的发布目录）。L0 用假 `HttpPort` 覆盖协议与错误路径，真实拉取属 L3 |
