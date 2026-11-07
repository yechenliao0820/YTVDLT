# M5-3 报告 · 空/错状态统一 + 截图基线

> 日期 2026-11-06 ／ 决策 D-56 / D-58 ／ 对应断言 **A-4.4-16**

## 1. 交付

### 1.1 队列主页面（新增）

`packages/ui/src/pages/queue/index.html` + `queue.js`

- 四 Tab：全部 / 下载中 / 已完成 / 已取消，每个 Tab 带实时计数（`data-count`）；
- 搜索框：标题 / 上传者 / 任务 ID / 类型，**不匹配 URL**；
- 卡片：状态徽标、上传者、时长、进度条、`% · 速度 · 剩余`、按状态可用的动作；
- 并发计数 `2/3`、粘贴框（`#queue-url`，供 `--url` 预填）、空态引导与 CTA。

### 1.2 空/错状态同构

四个页面用同一套「状态块」写法（`#<page>-empty` / `#<page>-error` + `hidden="true|false"` + `data-variant`）：

| 页面 | 空态 | 错态 |
|---|---|---|
| 队列 | 无任务 → 引导 + CTA；筛选为空 → 「切到全部」 | 队列读取失败 → 重试 |
| 任务详情 | 任务不存在 → 隐藏详情与动作 | 记录自带 Error → 错误码 + 复制报告 |
| 任务日志 | 暂无日志 | 日志不可用（任务已移除） |
| 批量入队 | 没有选中条目 → 确认按钮 disabled | 批量入队失败 |

### 1.3 截图基线

- 用例从 14 → **30**（新增 16：`format-dark`、`format-en`、`queue-ready/empty/error/en/dark/prefill`、`settings-appearance`、`settings-en-dark`、`batch-ready/empty`、`detail-error/empty`、`log-ready/error`）。
- `run-e2e.mjs` 支持 `page` 字段（页面不再局限于 `dialogs/`），写回提取改为按 `id` 匹配。
- 反例仍为 5 条（PNG 单像素、整图替换、DOM 篡改、fixture 注入 url、fixture 伪造 format_id）。

## 2. 验证

| 项 | 证据 | 结果 |
|---|---|---|
| 视图模型单测 | `tests/unit/task-view.test.ts` | **8/8 PASS**（7 态映射、计数、搜索、空态判定） |
| 页面通道 | `tests/unit/m5-channels.test.ts` | Tab 过滤与计数走真实 IPC handler |
| e2e | `node scripts/run-e2e.mjs` | **30/30 用例 PASS + 5/5 反例 PASS，allPass=true** |
| M3 零回归 | png-diff 逐例 | 14/14 `differPixels=0` |

## 3. 与 PRD 的偏差

1. **Error 归入「已取消」**（D-56）：PRD 四 Tab 不变，未单开「失败」页。
2. **截图尺寸固定 1280×800**，沿用 M3 载体约定；响应式未做像素基线（只在 e2e 之外无法验证）。

## 4. 未完成

- 真实数据驱动：队列页在无 `window.__YTVDLT_TASKS__` 时使用 6 条固定样例（含 6 种状态），用于截图确定性；接真实队列的通道（`TASK_LIST`）已就绪，但**窗口未跑起来**（B1），所以「点开应用看到真实任务」尚未验证。
- 卡片缩略图为字母占位块：真实缩略图需要下载封面（联网 + 缓存策略），未做。

## 5. 结论

空/错状态在四个页面完成统一并纳入基线；队列页的四 Tab 与计数符合 PRD，视觉与交互证据可复现。真实窗口联动仍被 N1 阻塞。
