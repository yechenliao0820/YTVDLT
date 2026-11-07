# M5-2 报告 · 快捷键 + i18n（zh-CN / en）

> 日期 2026-11-06 ／ 决策 D-55 ／ 对应断言 **A-4.1-02**、**A-4.4-21**

## 1. 快捷键（§6.8 全量）

| 加速键 | 动作 | 输入框聚焦时 |
|---|---|---|
| `Ctrl+V` | 粘贴并解析 | **不触发**（不劫持编辑键） |
| `Ctrl+N` | 新建下载 | 触发 |
| `Ctrl+Enter` | 开始 | 触发 |
| `Ctrl+,` | 设置 | 触发 |
| `Ctrl+F` | 搜索 | **不触发** |
| `Ctrl+Shift+V` | 全局唤起并预填 | **触发**（全局例外） |
| `Delete` | 取消（需确认） | **不触发** |
| `Ctrl+R` | 重试 | 触发 |
| `Esc` | 关闭弹窗 | 触发 |
| `F5` | 刷新 | **不触发** |
| `Ctrl+1..4` | 切导航 | 触发 |

实现分两层：`packages/core/src/shortcuts/shortcuts.ts` 是权威表与匹配策略（macOS 下 `Ctrl` 映射 `Cmd`），`packages/ui/src/shortcuts/shortcuts.js` 是浏览器镜像。**单元测试会解析镜像文件并逐字段比对**，两边一旦漂移立即失败（这是本轮特意加的防漂移护栏）。

`--url=<link>` / `--url <link>` 与 `Ctrl+Shift+V` 都归一到同一个 `prefillIntent`：`bootstrap` 把 URL 作为 `?prefill=` 传给队列页，页面填入粘贴框（`data-prefilled` 标记可用于断言）。

## 2. i18n（zh-CN / en）

- 字典：`packages/ui/src/i18n/messages.js`，**语义键** 100+ 条（队列、设置、关于、7 个任务状态、4 类通知、托盘）。
- 应用：`packages/ui/src/i18n/i18n.js`
  - 新页面：`data-i18n` / `data-i18n-placeholder` / `data-i18n-aria-label` / `data-i18n-title`；
  - M3 弹窗：整段中文 → 英文短语表（HTML 冻结，避免作废 14 张基线）；
  - 默认 `zh-CN` 时**不写 DOM**；
  - 输出 `data-i18n-missing`（缺失键数）与 `data-text-overflow`（越界元素数），供 e2e 断言。

溢出测量规则：优先测 `[data-fit]`；无该属性时退回固定选择器集合（标题/按钮/标签/说明），**刻意不测会省略号截断的卡片标题**——截断是设计，不是缺陷。

## 3. 验证

| 项 | 证据 | 结果 |
|---|---|---|
| 快捷键单测 | `tests/unit/shortcuts.test.ts` | **12/12 PASS**（表一致性、编辑守卫、全局例外、冲突=0、深链） |
| 预填链路 | `tests/unit/bootstrap.test.ts` | `--url` → `?prefill=`、二次启动带 URL 聚焦 |
| i18n 单测 | `tests/unit/i18n.test.ts` | **11/11 PASS**（双语键集合相等、占位符同名、页面引用键全覆盖、短语表无空/重复） |
| 英文渲染 | e2e `format-en` / `queue-en` / `settings-en-dark` | `data-i18n-missing="0"`、`data-text-overflow="0"` |

## 4. 已知缺口（如实登记）

1. **弹窗动态拼接串**：如 `'条目 #' + position`、`'任务日志 · ' + id` 仍为中文。短语表只能替换完整文本节点，拼接部分需改写 JS；本轮为保基线不动，留待 M6。
2. **对话框文案覆盖**：短语表覆盖 80+ 条静态文案（标题、按钮、标签、提示），未覆盖动态生成的错误详情（多为代码/英文错误码）。
3. **语言切换方式**：设置页切到英文后整页重载（`?lang=en`），切回中文亦重载。原因同上——`i18n.js` 只做 zh→en 正向替换，反向没有保留原文。真实应用里应由主进程持久化后重载窗口。

## 5. 结论

快捷键 100% 实现且策略可测；i18n 在 M5 新界面**完整**、在 M3 弹窗**静态文案完整、动态拼接未覆盖**，缺口已量化并登记，未声称「全部文案 100%」。
