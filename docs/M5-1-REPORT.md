# M5-1 报告 · 主题三态 + 强调色 + 动态取色

> 日期 2026-11-06 ／ 决策 D-54 ／ 对应断言 **A-4.4-20**、**A-4.6-06**

## 1. 交付

| 层 | 文件 | 职责 |
|---|---|---|
| 策略（纯 TS） | `packages/core/src/appearance/appearance.ts` | 三态归一、系统偏好解析、强调色优先级、WCAG 对比度、减少动效、触觉省略登记 |
| 颜色（唯一色源） | `packages/ui/src/styles/theme.css` | 暗色调色板 + 5 组强调色（浅/暗各一套）+ 减少动效开关，全部挂在 `html[data-*]` 下 |
| 应用（DOM） | `packages/ui/src/theme/theme.js` | 只写 `<html>` 的 `data-theme` / `data-accent` / `data-motion`；监听系统主题变化 |
| 页面 | 队列页 + 设置页 + 三个弹窗 + 三个 M4 页面 | 统一接入 `theme.css` 与 `theme.js` |

关键取舍：**默认状态不写任何属性**。浅色 + `blue` + 完整动效时 `theme.js` 一个属性都不留，所以 14 张 M3 中文截图保持像素级不变（实测见 §3）。

## 2. 规则

- 三态：`light` / `dark` / `system`；`system` 由 `prefers-color-scheme` 解析，未知值一律回落 `system`。
- 强调色：用户 hex > 系统强调色（仅在选 `system` 时）> 预设（默认 `blue` = M3 原色）。
- 动效：`reduced` 时 `transitionMs = 0`，CSS 侧 `html[data-motion="reduced"]` 直接关闭 transition/animation。
- 触觉：桌面无等价硬件，`hapticsCapability()` 返回 `supported:false` 并入「关于」文案（A-4.6-06 要求「明确省略」而非静默缺失）。

## 3. 验证

| 项 | 命令 / 证据 | 结果 |
|---|---|---|
| 策略单测 | `node node_modules/vitest/vitest.mjs run tests/unit/appearance.test.ts` | **17/17 PASS** |
| 调色板对比度 | 同上（从 CSS 反解 5 组 × 2 主题 × 2 表面） | 全部 **≥ 4.5:1** |
| 暗色截图 | `reports/e2e-summary.json` → `format-dark` / `queue-dark` / `settings-en-dark` | 3/3 PASS |
| **M3 视觉零回归** | 逐例 `png-diff`（容差 0）对比 M5 前基线副本 | **14/14 例 `differPixels=0`** |
| DOM 变化审计 | `git diff --stat tests/e2e/baselines` | 14 个旧 DOM 文件各 **+6 行**（1 个 `link` + 5 个 `script`） |

> 说明：DOM 基线必须重建（新增标签），但像素差为 0，说明「只加了加载点，没有动版面」。这是本轮最重要的回归证据。

## 4. 未完成 / 边界

- **弹窗暗色仅在静态基线里验证**；真实 Electron 窗口下由 `bootstrap` 的 `nativeTheme` 监听触发重绘（`onSystemAppearanceChanged`），但窗口本身要等 N1 才能跑（B1/D-39）。
- 系统强调色读取：`m5-channels` 已把 `systemAppearance.accent()` 作为注入点接好，真实注册表读取要在 `electron-entry`（N1 后）补 `DwmGetColorizationColor`，当前 OS 侧返回 `null` → 回落预设。此项在 M5-SUMMARY 记为未验证。

## 5. 结论

三态与强调色在可离线验证的范围内**完成并通过**；像素零差异证明没有破坏 M3 的视觉契约。
