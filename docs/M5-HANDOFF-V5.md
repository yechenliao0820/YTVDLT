# YTVDLT · 交接书 v5（国际网实测收尾 / 下一棒开工版）

> 更新 **2026-11-07 13:30 GMT+8**（`2026-11-07T05:30Z`）／**本文是当前状态唯一入口**，取代 `M5-HANDOFF-V4.md`；v4 保留为国内网阶段历史状态，其 §6 清单已执行完毕，不要再照着做。
> 权威优先级同 v4：原始任务书 `C:/Users/leolee/WorkBuddy/2026-11-05-07-24-49/YTVDLT_HANDOFF.md`（933 行）＞ `docs/PROJECT-HANDOFF.md`（甲方副本，**有本地改动，永不提交/覆盖**）＞ PRD / ARCHITECTURE ＞ `docs/DECISIONS.md`（D-01…**D-71**）＞ 本文。
> 环境：Windows 10 22631 ／ Node 22.22.2 ／ pnpm 9.15.9 ／ Electron 45.2.2 ／ 分支 `master` ／ 项目根 `C:\Users\leolee\WorkBuddy\2026-11-05-08-16-08\ytvdlt`。

---

## §0 开工前必做（三条命令，逐字对照）

```bash
cd C:/Users/leolee/WorkBuddy/2026-11-05-08-16-08/ytvdlt
git log --oneline -12           # 应能看到本轮 5 个提交（见 §5），且 1521675 仍在链上
git status --short              # 期望：只有 docs/PROJECT-HANDOFF.md (M) 与 _tmp_2992_... (??)
node scripts/handoff-check.mjs  # 唯一数字准绳；与 §5 不符 → 以脚本为准并订正本文
```

三条纪律沿用 v4 §0.2：**先看后改**、**改完必跑**（typecheck + 相关单测；只改文档也要跑 handoff-check）、**不重做已验证项**。

---

## §1 本轮（国际网 N3）完成了什么

| 任务 | 结论 | 证据 |
|---|---|---|
| T1 网络放行验证 | **通过**：api.github.com / github.com / www.youtube.com 均 200 | 本文 §2；`scripts/l3-smoke.mjs` 的逐场景 8 s 守卫 |
| T2.0 命令行先验 | **通过**：随包 yt-dlp `2026.10.26` == 官方 latest；`--simulate` 拿到标题、`-F` 列全格式、`--download-sections "*0-30"` 落盘 1.92 MiB 且 ffmpeg 合并 AV1 480p + Opus | `reports/l3-probe/` 原始输出；`docs/BLOCKED-2026-11-07.md` §二 |
| T2.1 应用内站点矩阵 | **部分通过**：6 场景中 2 `pass` / 3 `fail` / 1 `expected-fail`。`yt-single` 在打包 exe 内完整下载 11,145,518 字节、`state=Completed`、12 项产物校验通过（aria2c 默认启用）；非 YouTube 直链由随包引擎命令行完成 788,493 字节；Vimeo 登录墙返回明确错误不崩 | `reports/l3-smoke.json`（逐行 `result` / `errorCode` / `diagnosis` / `stderrHead`）、`scripts/l3-smoke.mjs` |
| T2.2 失败处理 | 按顺序走完 ① 升级引擎（已是最新版，无需）→ ② cookies（公开内容，不适用）→ ③ 不加 extractor 参数绕过 → ④ **停**、存 stderr、写 BLOCKED、不改应用代码 | `docs/BLOCKED-2026-11-07.md`、`reports/l3-probe/yt-*-simulate.stderr` |
| T3 组件在线更新 | **通过（3/3）**：官方 HTTPS 拉取 → `up-to-date` 且哈希全等；篡改清单 → `checksum-mismatch`、一个字节不写、无 `.bak/.new`；正确清单 + 故意损坏本地二进制 → `changed:true`、原子覆盖 + 复验、哈希恢复官方值、exe 可运行 | `reports/l3-component-update.json` |
| T6 收尾门控 | `pnpm turbo run typecheck` 5/5；`npm test` 0 failed；五套验收串行 `allGreen=true`（M5 = 8 PASS + 2 SKIPPED，`releaseReady=false`） | `reports/acceptance-report-m{1..5}.json`、`reports/vitest-guard.json` |
| T7 改 SKIPPED → PASS | **未做（有意）**：T4 / C13–C16 未完成，且 v4 §11 禁止把 SKIPPED 改 PASS | D-71、`docs/M5-5-REPORT.md` 栏② |
| T4 应用自更新 / T5 干净机 | **未做**：T4 等甲方 GitHub 仓库；T5 需干净 VM | v4 §5.3 / §6 T4、T5 |

---

## §2 证据文件（都在本机 `reports/`，按项目惯例**不入库**）

| 文件 | 内容 |
|---|---|
| `reports/l3-smoke.json` | 6 场景矩阵；含 `postRunCorrections`（首版脚本两个记录 bug 的修正说明）、`environmentNotes`、`verdict` |
| `reports/l3-component-update.json` | T3 三步：`up-to-date` / `checksum-mismatch` / 真实覆盖复验，含每次前后 SHA-256 |
| `reports/l3-probe/yt-long-simulate.stderr`、`yt-shorts-simulate.stderr` | 失败场景的 `yt-dlp -v --simulate` 完整 stderr |
| `reports/l3-downloads/` | 真实成品：`Matisyahu_-_One_Day...webm`（11 MB，Completed）、`l3-non-youtube-mov_bbb.mp4`（771 KB）、播放列表两条产物（校验判不完整，保留作证据）、两轮失败尝试 |
| `reports/l3-feed/` | 官方 2026.10.26 的 `yt-dlp.exe` + `SHA2-256SUMS`（哈希 `f5389d36…a7d`）、篡改清单留档、打包运行时原始二进制备份 |
| `reports/l3-temp/` | 各任务的 artifact 清单（D-68 的显式 tempDir 落点） |
| `docs/BLOCKED-2026-11-07.md` | 四段式阻塞说明：目标 / 命令原文 / 报错原文 / 判断 + 一句话需求 |

**L3 口径**：**部分通过**，不宣称 L3 通过，`releaseReady` 保持 `false`。核心结论 —— 国际网、yt-dlp 版本、aria2c、ffmpeg 合并、产物校验、组件在线更新都没问题；**问题在应用内批量下载入口的设计**（D-69）。

---

## §3 两个本轮发现的真缺陷（未修代码）

| 编号 | 缺陷 | 现状 / 下一棒动作 |
|---|---|---|
| **D-68** | 出厂默认 `paths.tempDir = ""` → artifact 清单路径 `/ytvdlt-artifacts-*.txt` 落到盘符根目录 → `PERMISSION_DENIED`，媒体文件已落盘但任务判 Error | 本轮用显式 `paths.tempDir = reports/l3-temp` 规避；**测完已把 `dist/win-unpacked/config/config.json` 恢复出厂默认**，测试配置另存 `config.json.l3-test`。修法：空 tempDir 回退输出目录 / 系统 temp + 启动写探针 |
| **D-69** | `PROBE` 是 fixture、`DOWNLOAD_START` 未注册，唯一真实入口 `PLAYLIST_ENQUEUE` 只吃播放列表；批量用 `--playlist-items <position>`，而 `engine.probe --no-playlist` 只解析首条，且 `RD` 混播列表位置会漂移 → 非首条必触发 C5 `ARTIFACT_INCOMPLETE` | 不改 IPC 冻结面；建议下一棒注册单视频入口、批量改用条目 URL 而非位置；改动会牵动 `bootstrap` / `ipc-gateway` / `m4-host` 与单测、e2e 基线 |

环境约束见 **D-70**：WorkBuddy 注入的 `NODE_OPTIONS` 会破坏随包 node.exe 的 JS challenge 求解，所有 CLI 与 exe 启动必须 `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE`；Shorts 场景遇到一次上游代理 502（非断网）。

---

## §4 未验证 / 待甲方（一项都不许写成「通过」）

| 项 | 依赖 |
|---|---|
| 应用自更新 v1→v2、差分下载、失败降级 | 甲方 GitHub 仓库 + 打包配置改 `files` / `publish`（v4 §6 T4） |
| 干净机 C13–C16（安装版 / 便携版 / 删 exe 报错 / 卸载残留） | 一台没装 Node/Python/FFmpeg 的干净 VM |
| aria2c 在线更新 | 官方 `SHA2-256SUMS` 无 `aria2c.exe` 行；需甲方在自建更新源里补该行与二进制 |
| 代码签名、自定义许可外部合法性审查 | 甲方采购 / 律师 |
| 长视频分片并发与断点续传、Shorts、播放列表勾选多条 | 先修 D-69（当前应用内无法稳定复现） |

---

## §5 数字（`node scripts/handoff-check.mjs` 为唯一准绳）

| 项 | 值 |
|---|---|
| 决策编号 | **D-01…D-71**，连续无跳号；下一棒 **D-72** 起 |
| M5 验收 | **8/10 PASS + 2 SKIPPED**，`allGreen=true`，`releaseReady=false` |
| E2E | **30/30 + 反例 5/5** |
| 覆盖率四维最低 | **86.76%**（阈值 70%） |
| vitest | 验收脚本口径 **759 tests / 0 failed**；`npm test` 口径 **753 / 0 failed**（收集范围不同，两者均无失败） |
| 分层违规 | 0；运行时自检 3/3 必需 OK（aria2c 恒 OPTIONAL，v4 §7 第 16 条） |
| 截图基线 | 30 个 |
| 打包产物 | **本轮未重打包**，哈希沿用 v4 §2.3；`win-unpacked/resources/runtime/yt-dlp.exe` 经 T3-C 覆盖后仍为官方字节 `f5389d36…a7d` |
| 工作区 | `docs/PROJECT-HANDOFF.md`（甲方改动，永不提交）、`_tmp_2992_c8a08bf15dca424991930c32439a4a06`（无关文件，不动） |

> 本轮五套验收期间触发了 v4 §7 第 6 条的 safe-delete 守卫（`coverage/.tmp`，count=84 > 50）；`scripts/lib/vitest-run.mjs` 按既定降级复核「证据新鲜、0 失败、覆盖率 86.76%」，并记入 `reports/vitest-guard.json`。**真实测试失败不会被掩盖**，这不是门控变红。

---

## §6 下一棒任务单（按优先级）

1. **先决策**：是否授权修 D-69（单视频入口 + 批量条目 URL）。未授权前，不要重跑 L3 矩阵，也不要改 `acceptance.mjs` 的两条 SKIPPED。
2. **修 D-68**：空 tempDir 回退 + 写探针；补单测，重打包，再跑一次真实下载确认 `PERMISSION_DENIED` 消失。
3. **修 D-69 后重跑 T2.1**：`node scripts/l3-smoke.mjs`（脚本已修两处记录 bug：`stat.size`、按场景时间过滤日志），要求 1–4 + 6 全 `pass` 才更新 `reports/l3-smoke.json` 的 `verdict`。
4. **T4**：甲方仓库就绪后按 v4 §6 T4 改打包配置，验差分下载 / 用户数据不丢 / 断网降级。
5. **T5**：干净 VM 跑 C13–C16，产出 `reports/clean-machine.json`。
6. **T7**：只有 1–5 全做完，才把 `A-4.4-28/29` 的 `deferred` 文案订正并串行重跑五套验收；`releaseReady` 在 C13–C16 全绿前保持 `false`。
7. 每个 commit 单独可回滚；**禁止** `git add -A` / `git add .` / `git add -u`，**禁止**提交 `docs/PROJECT-HANDOFF.md`。

---

## §7 禁止清单

沿用 v4 §11 全部 10 条，不重复抄写。特别提醒本轮新增的两条红线：

- 不要把 `reports/l3-smoke.json` 里的 3 行 `fail` 改写成 `pass`，不要用「L3 已通过」对外表述。
- 不要把 T3 的 `overallOk=false` 当成失败：那是 aria2c 缺清单行的**明确失败隔离**，三步的 `verdict` 均为 `pass`。

---

## §8 一句话口径（对外就这么说）

> **国际网阶段已完成实测：官方 yt-dlp release 可在线拉取并校验，组件更新能覆盖式替换、校验失败一个字节不写；打包后的 Windows 应用能真实下载 YouTube 单视频（完整成品通过 12 项产物校验），非 YouTube 直链也能下。**
> **未完成的是应用内长视频 / Shorts / 播放列表多选：当前批量入口按位置映射且探针只解析首条，实测 3 个场景失败；另有应用自更新、干净机验收、签名与许可审查未做。**
> **L3 为部分通过，`releaseReady` 仍为 `false`。**
