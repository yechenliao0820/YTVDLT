# AGENTS.md

**动手改代码前，先读 [`docs/AI-MAINTENANCE.md`](docs/AI-MAINTENANCE.md)。**

那是唯一的维护手册：目录地图、功能 → 文件对照、IPC 契约、故障分诊表、改动流程、验证命令、稳定坑的原理。
**本文件只是入口，不承载规则**——规则以手册为准，两处都写会制造两种真相。

## 三条最容易踩的（细节都在手册里）

1. **拆分出来的模块不许回填**（手册 §0 铁律 15 + §3.0 落点表）：新 IPC handler 进 `m5-{task,download,site,settings}-handlers.ts`；通道名/白名单/DTO 进 `m5-contracts.ts`；队列页纯显示逻辑进 `queue-model.js`；yt-dlp 输出分类进 `precheck-classify.ts`；task-queue 纯函数进 `concurrency` / `snapshot-projection` / `history-entry` / `app-error`。**不要为了省事写回 `m5-channels.ts` / `queue.js` / `yt-dlp-engine.ts` / `task-queue.ts`。**
2. **改完在回复末尾输出「修改文件清单」表**（文件 / 改动 / 影响），业主据此提交。**不主动 commit、push、打包、发布**（铁律 12）。
3. **改行为要留决策记录**（铁律 5）：`docs/DECISIONS.md` 追加 `## D-<下一编号>`，写「现象 / 根因 / 决策 / 验证 / 未覆盖」。绝不把 `SKIPPED` 改判成 `PASS`。

## 环境与验证

- 构建与测试命令见手册 §7；构建指南 `docs/BUILD.md`。**构建会递归清空 `dist/`**，执行前必须取得授权。
- 测试/验收会用随包二进制（`resources/runtime/win-x64/`），无需联网；`test:online` 例外。
- 删除文件只能进回收站（手册 §0.1），禁止 `rm -rf` / `Remove-Item -Force`。
