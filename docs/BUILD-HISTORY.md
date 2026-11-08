# 构建产物版本报告（清理前留档）

> 目的：把历史上每一次打包产出的来龙去脉记下来，磁盘上的旧目录随后删除，只保留最终版。
> 所有被删目录都是**生成物**（`electron-builder` 输出、临时验证副本、覆盖率缓存），源码、`node_modules`、`.git`、`docs/`、`reports/` 内的证据 JSON 与日志一律未动。

## 时间线（2026-11-07）

| 版本 | 目录 | 内容 / 为什么被淘汰 |
|---|---|---|
| 0.1.0（首批） | `dist/`（含 `-v1` 备份） | 无自更新能力，`electron-updater` 未进 asar；L3 六场景就是用它跑的。后被带 updater 的构建取代 |
| 0.1.0（T4 的 v1） | `dist-update-v1/` | 首次把 `electron-updater` 打进 `main.cjs`，加 `publish` 块产出 `latest.yml` + blockmap。作为自更新测试的「旧版」安装源 |
| 0.1.1（T4 的 v2） | `dist-update-v2/` | 自更新测试的「新版」目标，只改版本号。v1→v2 真机更新成功（D-75） |
| 0.1.2 | `dist-fix-0.1.2/` | 首次把队列页接真实 IPC。**但渲染层传的是常量名、preload 校验线缆字符串**，所有调用被拒 → 按钮全废（D-77） |
| 0.1.3 | `dist-fix-0.1.3/` | 修了通道名映射。**但 `preventDefault()` 排在 live 判断之前，吃掉了表单原生提交** → 真鼠标点「粘贴并解析」仍无反应（D-78） |
| 0.1.4 | `dist-fix-0.1.4/` | 修了 preventDefault 顺序 + 新增可见状态行。**但 `%USERPROFILE%` 从未展开** → 新装必报 `ARTIFACT_INCOMPLETE`（D-79） |
| 0.1.5 | `dist-fix-0.1.5/` | D-79 路径展开修复，打包被中断（只有 `win-unpacked`，无安装包） |
| 0.1.6（临） | `dist-fix-0.1.6/` | 漏跑 `build-desktop.mjs`，打进 asar 的是旧渲染层（不自洽），作废 |
| **0.1.6（最终）** | **`dist-0.1.6/`** | D-79 路径展开 + D-80 点击直连 + 详情返回，出厂默认配置下全流程实测通过 |
| **0.1.0（发版基准）** | **`dist-0.1.0/`** | 与 0.1.6 代码完全相同，仅版本号归零：仓库重建后以本版作为对外第一版（v0.1.0 标签） |
| **0.1.7** | **`dist-0.1.7/`** | 中文应用菜单（D-82）+ 粘贴区「视频/音频 + 清晰度 + 音频格式」与音频修复（D-83）。typecheck 5/5、vitest 778 全过、e2e 31/31 + 反例 5/5；CDP 实测打包产物队列页控件与音频态切换正常 |
| **0.1.8** | **`dist-0.1.8/`** | 修 D-84：音频任务的产物校验（C8 改哈希音频流、C6 排除内嵌封面），此前音频任务必然被 ARTIFACT_INCOMPLETE 误杀。vitest 783 全过、e2e 31/31。交付状态：**Setup + blockmap 已产出**（业主 VM 复测用）；便携版 / `latest.yml` 未产出——业主已定新规：**默认只打安装版，便携版点名才做** |
| **0.1.9（当前）** | **`dist-0.1.9/`** | D-85…D-88 纯 UI / 任务管理版：中英文切换入口 + 持久化 + 菜单跟随、品牌徽标与响应式自适应布局、多选/排序/右键删除/删除时区分「历史 vs 本地文件（回收站）」/清空历史/无痕下载。**未改任何下载功能**。Setup 226,338,769 B + blockmap + `latest.yml`（便携版按新规未产）。vitest 789 全过、typecheck 5/5、e2e 31/31 + 反例 5/5（仅重建 7 张 `queue-*` 基线，其余 24 张 0 像素差）、handoff-check 通过；打包产物 CDP 真机验证：新控件齐全、点 EN 整页英文无缺键/溢出、语言写入 config、重启自动保持 |
| **0.1.10（当前）** | **`dist-0.1.10/`** | D-89 修「装到 `C:\Program Files` 后 PERMISSION_DENIED」：yt-dlp 子进程的 cwd / TEMP 钉到可写输出目录，**不需要管理员权限**；D-90 原创「播放三角 + 下载箭头」品牌图标并显式绑定 app exe / NSIS 安装包 / 桌面快捷方式；D-91 版本号常驻前端 + 「设置」菜单 + 关于弹窗（版本 / 作者 Yechen Liao / 开源声明，中英双语）。Setup 226,356,479 B + blockmap + `latest.yml`；vitest 792 全过、typecheck 5/5、e2e 31/31 + 反例 5/5（重建 9 张基线）、handoff-check 通过；打包产物 CDP 验证 `?v=0.1.10`、关于弹窗开关、设置页版本与作者 |

## 最终版本 0.1.6 实测结论

出厂默认配置（无预置 `config.json`）、真实国际网，真实鼠标输入：

1. 空队列启动，无演示卡；
2. 点「粘贴并解析」→ 状态行「已加入队列：1 个任务，开始下载」；
3. One Day 下载完成（17,670,574 B），落盘 `C:\Users\<用户>\Downloads\YTVDLT`（`%USERPROFILE%` 已正确展开，不再生成字面量目录）；
4. 「打开文件夹」→ 已执行；
5. 第二次入队 → 「取消」→ 已执行，卡片转「已取消」；
6. 「详情」→ 进入详情页并显示真实任务；
7. 「← 返回队列」→ 回到队列，卡片仍在。

证据：`reports/ui-drive-016.log`、`reports/ui-fix-queue.png`。

## 清理结果（2026-11-07 实际执行）

| 动作 | 说明 |
|---|---|
| 已删除 | 12 个旧安装包（Setup / Portable，约 3.2 G）、各构建目录里的 `*.nsis.7z` 中间包、以及旧包内的 `YTVDLT.exe` / `node.exe` / `ffmpeg*.exe` 等大二进制 |
| 已归档 | 其余旧构建目录、`coverage/`、自更新测试用的本地安装副本统一收进 **`_to-delete/`**（约 6.4 G），根目录不再凌乱 |
| 工作区体积 | **17 G → 8.7 G**（其中 `_to-delete/` 占 6.4 G，手动删掉后约 2.3 G） |
| 保留 | `dist-0.1.6/`（唯一可用交付：Setup + Portable + blockmap + latest.yml）、`reports/`（证据）、源码全量、`node_modules/`、`.git/` |

**为什么没有一次性删干净**：本机 `safe-delete` 守卫禁止递归批量删除（单轮 >50 个文件直接拒绝），
只允许逐个文件删除与改名。所以采用「删大件 + 其余归档到一个文件夹」的策略，剩下一步需要人工：
在资源管理器里删除 `_to-delete/` 整个文件夹即可。

> 版本取舍说明：`0.1.5` 的打包被中断，从未产出安装包；`0.1.4` 存在 `%USERPROFILE%` 未展开的致命
> 缺陷（D-79）。两者都已被 `0.1.6` 取代，故不再保留安装包。需要复现旧版本时，按 `docs/AI-MAINTENANCE.md`
> §1 的顺序重新打包即可（源码历史在 git 里）。

## 版本号规则（下次发版照做）

1. 改 `package.json` 与 `apps/desktop/package.json` 的 `version`（两处必须一致）。
2. `node scripts/build-desktop.mjs` → `npx electron-builder --win --publish never`。
3. **打包后立刻** `git checkout -- package.json apps/desktop/package.json` 还原源文件。
4. 产物目录建议命名 `dist-<version>/`，只保留最近一个可用版本，旧的移入 `_to-delete/`。

