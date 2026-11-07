# Git 历史归档（2026-11-07 事故后重建）

> **这是归档记录，不是 git log。** 原始 `.git`（含全部对象）于 2026-11-07 晚间事故中丢失，
> 仓库未配置远端，无法克隆回来；回收站逐条检索未命中。本仓库为之后 `git init` 重建的新仓库，
> **commit hash 与原始历史不一致**。原始提交清单如下，供追溯与参考。

## 一、2026-11-05 ~ 11-06 的原始提交（hash 为事故前真实值，已失效但语义可查）

| # | 原始 hash | 标题 | 大致时间 |
|---|---|---|---|
| 1 | `119bc44` | feat(m5): 主题三态/快捷键/i18n/队列页/IPC 表面 + 87 例测试 + 30 例截图基线 | 2026-11-06 上午 |
| 2 | `94cb240` | docs(m5): 6 条决策 + 4 份块报告 + 收尾报告 + 交接包状态更新 | 2026-11-06 上午 |
| 3 | `151a56e` | fix(m5): 收尾排雷 9 项（i18n 覆盖子树/占位符、深链脱敏、托盘兜底、accent 校验） | 2026-11-06 上午 |
| 4 | `ee79f1b` | docs(m5): 新增 v2 交接包（施工单 + 网络放行清单 + 17 条排雷）+ D-60 排雷决策 | 2026-11-06 |
| 5 | `0f39698` | docs(m5): 交接包升 v2.1（网络放行前置 + 发送清单 + 术语表 + 过期自查）+ 新增 VM 实测清单 | 2026-11-06 |
| 6 | `ab2ff43` | docs(m5): 交接包自查表改用「最后一次代码提交」判定，避免文档提交导致误判过期 | 2026-11-06 |
| 7 | `40fd63d` | feat(m5): 新增 scripts/handoff-check.mjs —— 交接文档过期自查（六项现状 + STALE 判定） | 2026-11-06 |
| 8 | `e3c0d84` | fix(m5): handoff-check 误报 STALE（提交标题含 STALE 字样被当成证据过期） | 2026-11-06 23:xx |

> 更早（M1–M4 阶段，2026-11-05 ~ 11-06）的提交 hash 未逐条留存；行为记录见
> `docs/DECISIONS.md`（D-01…）与各 `docs/M*-REPORT.md` / `M*-QA-VERIFICATION.md`。

## 二、2026-11-07 的提交线索（hash 未留存，仅从 DECISIONS.md / BUILD-HISTORY.md 反推）

| 线索 | 内容 | 出处 |
|---|---|---|
| `f39320d` | docs(m5): v2.2 交接包 | `DECISIONS.md` §D-64 邻近行 |
| D-64 独立 commit | `chore(m5): N1 依赖声明与 Electron 二进制补齐`（`electron-builder@^26.0.0` + `electron-updater@^6.8.0` 进根 devDependencies，lock 新增 203 包 / 0 删除；Electron 45.2.2 经 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 补齐约 357 MB） | `docs/DECISIONS.md` D-64 |
| C1 / C2 / C3 | M5-4 门控改造与打包 / M5-5 双通道更新 / M5-6 合规文档三块，每块一 commit + `M5-x-REPORT.md` + 决策续号 | `docs/DECISIONS.md` D-61… |
| 11-07 白天多轮打包与修复 | 0.1.0 → 0.1.6（D-75 v1→v2 自更新真机成功、D-77 IPC 常量名、D-78 preventDefault 顺序、D-79 `%USERPROFILE%` 展开、D-80 点击直连），版本号规则见 `docs/BUILD-HISTORY.md` | `docs/BUILD-HISTORY.md`、`docs/DECISIONS.md` |

## 三、重建说明

- 重建时间：2026-11-07（本文件随首次 commit 入库）。
- 重建方式：`git init` → 全量快照一次 commit。**不伪造多段历史**——分段伪造会让 hash、作者时间、diff 都与事实不符，不如一次说清。
- 事故前工作区状态（可参考 `_to-delete-ytvdlt/` 内打包产物与 `reports/` 证据）已并入当前快照。
- 若日后找到 `.git` 残留（回收站之外的备份、其他磁盘、远端），可用 `git fetch <backup> && git reset --soft <原hash>` 把真实历史接回来。
