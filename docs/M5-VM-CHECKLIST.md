# M5 · 干净 Windows VM 实测清单（甲方执行，AI 不得代签）

> 版本 v1.0 ／ 2026-11-06 ／ 对应 DoD 第 4 条、C13–C16、U7
> 用法：把本文当成一张勾选表。每步填「结果 + 证据路径（截图/日志）」，全部填完再回传。
> 铁律：**C13–C16 只能由甲方实测结果判 PASS**；网络不可达的 L3 记 `SKIPPED`，不判 FAIL，也不得写成 PASS。

## 0. 环境准备

| 项 | 要求 | 实测值（甲方填） |
|---|---|---|
| VM 系统 | Win10 1809+ 或 Win11 x64 | |
| 干净度 | **无** Python / Node / FFmpeg / Chrome / 旧版 YTVDLT | |
| 快照 | 装前打一个快照，命名 `pre-M5-install` | |
| 安装包 | `YTVDLT-Setup-<ver>.exe`（SHA256：______） | |
| 便携版 | `YTVDLT-Portable-<ver>.exe`（SHA256：______） | |

## 1. 安装版安装（C13 前半）

- [ ] 双击安装包；记录是否弹 SmartScreen
- [ ] 若弹出：应能点「更多信息 → 仍要运行」
- [ ] **不需要管理员权限**（per-user 安装）；若索要 UAC，判 FAIL 并记录
- [ ] 安装完成后桌面快捷方式存在

证据：截图 `01-smartscreen.png`、`02-installed.png`

## 2. 首次启动自检（C13 中段）

- [ ] 应用能打开（无白屏、无 "Cannot find module"）
- [ ] 自检 4 项：`yt-dlp` ✅ / `node` ✅ / `ffmpeg` ✅ / `aria2c` OPTIONAL
- [ ] 3 个必需项全绿；`aria2c` 缺失不算失败
- [ ] 版本号显示正确（与安装包一致）

证据：截图 `03-selfcheck.png`；若有失败，附 `%APPDATA%\YTVDLT\logs\` 下最新日志

## 3. 真实下载（C13 后段 / L3）

- [ ] 使用**你有权保存**的公开视频（建议 Blender 开放电影）
- [ ] 下载完成，产物存在于输出目录
- [ ] 应用内可导出 C1–C12 校验报告，**12 项无 FAIL**
- [ ] 记录：产物路径 / 大小 / 时长 / 校验结论

> 网络不可达时：本步记 `SKIPPED`，原因写「无国际出口」，**不要**判 FAIL。

证据：截图 `04-download.png`、`05-c1-c12.png`、产物 `dir /s` 输出

## 4. 便携版（C14）

- [ ] 放到**普通可写文件夹**运行 → 配置写在 exe 同目录（确认有 `config\config.json`）
- [ ] 放到**不可写目录**（如 `C:\Program Files\YTVDLT`）运行 → 回退到 `%APPDATA%\YTVDLT`
- [ ] 两种情况下应用都能启动、能下载
- [ ] 「关于」框或日志里显示的配置路径与实际一致

证据：截图 `06-portable-writable.png`、`07-portable-readonly.png`

## 5. 卸载（C15 / C16）

- [ ] 控制面板 → 卸载，过程无报错
- [ ] 检查残留：
  - [ ] `%APPDATA%\YTVDLT`
  - [ ] `%LOCALAPPDATA%`（如有）
  - [ ] 开始菜单快捷方式
  - [ ] 桌面快捷方式
  - [ ] 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（应**没有** YTVDLT 项）
- [ ] 记录哪些目录被保留（**保留配置属于预期**，需在报告里写明策略）

证据：截图 `08-uninstall.png`、`09-residue.png`

## 6. 应用自更新（U7 / A-4.4-29）

- [ ] 装 v1 → 更新源指向 v2 → 手动「检查更新」
- [ ] 显示当前版本与最新版本
- [ ] 下载 → 安装 → 重启，版本号变化
- [ ] 断开网络再检查更新 → **静默降级**（只写日志 / 非阻塞提示），不弹错误对话框
- [ ] 「更新中断」再测一次：能否回滚到旧版本

证据：截图 `10-update-available.png`、`11-update-done.png`、日志片段

## 7. 引擎自更新（A-4.4-28）

- [ ] 触发一次 yt-dlp 更新
- [ ] 校验 `SHA2-256SUMS` 后才替换；替换期间**队列暂停**
- [ ] 更新完成后 `yt-dlp --version` 变化
- [ ] 故意改坏校验值 → **拒绝替换**，原文件未损坏、应用仍可下载

证据：截图 `12-engine-update.png`、`13-checksum-reject.png`

## 8. 主题 / 快捷键 / 语言（DoD 第 5 条）

- [ ] 切浅色 / 深色 / 跟随系统 → 全页即时生效；改 Windows 主题 → 应用跟随
- [ ] 强调色「跟随系统」时改系统强调色 → 应用主色跟随
- [ ] 逐个按 §6.8 快捷键：`Ctrl+V` / `Ctrl+N` / `Ctrl+Enter` / `Ctrl+,` / `Ctrl+F` / `Ctrl+Shift+V` / `Del` / `Ctrl+R` / `Esc` / `F5` / `Ctrl+1..4`
- [ ] 在输入框里按 `Ctrl+V`、`Ctrl+F`、`Del` → **不劫持**（正常编辑）
- [ ] 切 English → 文案切换，无文字被截断
- [ ] 关掉「减少动态效果」与开启时，转场表现符合预期

证据：截图 `14-theme-dark.png`、`15-theme-system.png`、`16-en.png`

## 回传格式

```
环境：Win11 23H2 x64 / 无 Python Node FFmpeg Chrome
安装包 SHA256：xxxx
1 安装：PASS（无需管理员，有 SmartScreen）
2 自检：PASS（aria2c OPTIONAL 缺失）
3 下载：PASS（Sprite Fright 1080p，C1–C12 = 11 PASS + 1 SKIPPED）
...
结论：C13 PASS / C14 PASS / C15 PASS / C16 PASS / L3 PASS|SKIPPED
```

> 任何一项 FAIL：把「现象 + 截图 + `%APPDATA%\YTVDLT\logs\` 最新日志」一起回传，不要自行改判。
