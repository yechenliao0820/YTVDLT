# 快捷键（SHORTCUTS）

> 来源：`packages/core/src/shortcuts/shortcuts.ts` 的 `DEFAULT_BINDINGS`（14 条绑定）。
> 渲染层同源实现：`packages/ui/src/shortcuts/shortcuts.js`。两处不一致会被 `tests/unit/shortcuts.test.ts` 抓住。

## 全局

| 快捷键 | 动作 | 说明 |
|---|---|---|
| `Ctrl+Shift+V` | 全局粘贴并预填 | **系统级**热键：在任意窗口复制链接后按下，YTVDLT 取剪贴板内容填入新建下载框。已在编辑框内也不会误触（`editingSafe: true`） |

## 队列页

| 快捷键 | 动作 | 说明 |
|---|---|---|
| `Ctrl+V` | 粘贴并解析 | 在非输入框聚焦时读取剪贴板并直接探测 |
| `Ctrl+N` | 新建下载 | 聚焦 URL 输入框 |
| `Ctrl+Enter` | 开始下载 | 提交当前表单 |
| `Ctrl+F` | 搜索 | 聚焦搜索框（按标题 / 上传者 / 任务 ID；**不搜 URL**） |
| `Ctrl+R` | 重试选中 | 只对 `Error` / `Canceled` 生效 |
| `Delete` | 取消选中 | 运行中任务转 `Canceled`；终态任务无动作 |
| `F5` | 刷新列表 | 重新读取队列快照 |
| `Escape` | 关闭对话框 | 优先关闭最上层弹窗 |
| `Ctrl+1` | 切到「全部」 | Tab 导航 |
| `Ctrl+2` | 切到「下载中」 | 同上 |
| `Ctrl+3` | 切到「已完成」 | 同上 |
| `Ctrl+4` | 切到「已取消」 | 同上（失败任务并入此页） |
| `Ctrl+,` | 打开设置 | — |

## 编辑安全（`editingSafe`）

| 值 | 含义 | 本例 |
|---|---|---|
| `true` | 输入框聚焦时**仍然生效** | `Ctrl+N`、`Ctrl+Enter`、`Ctrl+R`、`Ctrl+,`、`Escape`、`Ctrl+1..4`、`Ctrl+Shift+V` |
| `false` | 输入框聚焦时**让位给文本编辑** | `Ctrl+V`（粘贴文字）、`Ctrl+F`（查找）、`Delete`（删字符）、`F5` |

> 这条规则是 `matches()` / `shouldIgnore()` 的判据：同一个键在「输入框」与「列表」里做不同的事，靠 `editingSafe` 分流，不靠临时判断。

## 冲突检测

`detectConflicts()` 把加速键归并后返回重复项。当前 14 条**无冲突**（`Ctrl+1..4` 是四个不同键）。
新增绑定时若与既有键冲突，单测会失败——这是有意为之：快捷键冲突在运行时表现为「某功能偶发失灵」，很难查。
