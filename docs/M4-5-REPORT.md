# M4-5 报告 · 命令模板 + 参数白名单 + 任务日志页

> 版本 v1.0 ／ 2026-11-06 ／ 对应原始验收 ④、`docs/M3-HANDOFF.md` §10.6

## 1. 完成了什么（逐条对照）

| 验收条目 | 实现 | 证据 |
|---|---|---|
| **模板 CRUD** | `CommandTemplateStore`：`create / list / get / update / remove`，`<configDir>/command-templates.json` 原子写；名称 1–80 字、空/控制字符拒绝 | 4 例：CRUD、恶意模板拒存、原子文件往返、重开载入 |
| **载入时二次校验** | 手改文件写入 `--exec` 的条目在 `init()` 被丢弃，`rejectedAtLoad` 记录 `id + reason` | 「drops a hand-edited invalid template at load and reports why」 |
| **argv 数组化 + 选项白名单**（双保险） | 层①`validateTemplateArgs()`：正向白名单 + 每选项值语法（format id / 语言表达式 / 时间片 / 码率 / 整数 / 绝对路径 / 相对模板）；层②`buildCustomDownload()` 末尾再跑 `assertNoForbiddenOptions()` | 「accepts the documented safe option set」+ 16 例恶意输入 |
| **12 类恶意输入逐条拒绝** | `--exec` / `--config-locations` / `--cookies-from-browser` / `|` / `;` / `$()` / 反引号 / 绝对路径注入 / `..` 穿越 / 保留 `--` / 白名单外 `--ppa` / 选项缺值 —— 另加标志位带值、控制字符、值伪装选项、超长共 **16 例** | `it.each` 16 条，全部 `CUSTOM_COMMAND_REJECTED` |
| **`CUSTOM_COMMAND_REJECTED` 且不执行** | `customCommandRejected()` 产出冻结的 17 码之一；`buildCustomDownload` 在构造期抛出，**没有任何 spawn 发生** | 同上 + 「throws CUSTOM_COMMAND_REJECTED for a bad template」 |
| **任务日志页** | 核心 `TaskLogBuffer`：按行追加、CRLF 拆分、控制字符剥离、每任务 2000 行环形上限、`tail/copy/clear`；UI 页 `packages/ui/src/pages/task-log/{index.html,task-log.js}` 渲染逐行 `data-line`，按钮 copy / cancel / retry（retry 仅 Error/Canceled 可用） | 3 例缓冲测试 + 静态页（动作只产出 JSON，不直接操作进程） |
| **URL 仍是唯一占位符** | `buildCustomDownload` 固定 `['…prefix…', ...args, '…progress/print-to-file…', '--', url]`：`--` 恰 1 个且在倒数第二位，enginePath 不入 argv | 「keeps the compliance prefix/suffix, exactly one -- and the URL last」 |

## 2. 验收证据

```text
$ node node_modules/vitest/vitest.mjs run tests/unit/command-template.test.ts
 Test Files  1 passed (1)
      Tests  29 passed (29)
```

其中恶意输入 16 例（超出「12 类」要求 4 例），全部断言 `code==='CUSTOM_COMMAND_REJECTED'` 且带具体 `reason`（如 `denied option --exec`、`shell metacharacter`、`path traversal`）。

## 3. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/core/src/command-template/validate.ts` | 新增 | 白名单 + 值语法 + `customCommandRejected` |
| `packages/core/src/command-template/store.ts` | 新增 | CRUD + 原子持久化 + 载入校验 |
| `packages/core/src/command-template/index.ts` | 新增 | barrel |
| `packages/core/src/task-log/task-log-buffer.ts`（+`index.ts`） | 新增 | 逐行日志环形缓冲 |
| `packages/core/src/index.ts` | 修改 | 导出上述模块 |
| `packages/engine-ytdlp/src/argv-builder-custom.ts` | 新增 | 合规 argv 构造 |
| `packages/engine-ytdlp/src/argv-compliance.ts` | 修改 | 长格式别名 `--format/--output/--rate-limit/--retries` 入白名单 |
| `packages/engine-ytdlp/src/index.ts` | 修改 | 导出 `buildCustomDownload` |
| `packages/ui/src/pages/task-log/{index.html,task-log.js}` | 新增 | 日志页（零依赖静态） |
| `tests/unit/command-template.test.ts` | 新增 | 29 例 |
| `tests/contract/playlist-fixture.contract.test.ts` | 修改 | 通道数 7 → 8（M4-4 追加），断言新通道存在 |
| `docs/M4-5-REPORT.md`、`docs/DECISIONS.md` | 新增/修改 | 本报告 + D-51 |

## 4. 偏离与风险

- **D-51**：白名单是**正向**的（不在表里就拒绝），并给每个选项配独立值语法；黑名单仅作为「额外明确拒绝」清单，不承担安全边界。代价是用户能用的选项有限（当前 23 个），需要扩表时改 `ALLOWED_CUSTOM_OPTIONS` 并补测试。
- 已知取舍：
  - `-o` 只允许**相对**模板（拒绝盘符/UNC/`..`），避免模板把文件写出工作目录；
  - `--cookies` 允许绝对路径（手动导入场景必需），但拒绝 `..` 与控制字符；
  - 不支持 `--exec` 等后处理钩子——这是产品红线，不是疏漏。
- 风险：`validateTemplateArgs` 只校验「数组形态」；若上层把字符串 `"a b"` 传进来会被拒绝（`args must be an array`），不会做 `split(' ')` 猜测——这是刻意的（禁止命令字符串解析）。
- 任务日志页未加入三弹窗截图基线集（同 M4-4 的载体说明）。

## 5. 回归状态

| 项 | 结果 |
|---|---|
| `pnpm turbo run typecheck` | 5/5 |
| `npm test` | 40 files（其中 1 例因通道数断言失败已修）→ 549 例 |
| 冻结 argv | 未触碰 `buildDownload`；`argv-compliance` 仅追加别名 |
| M3 断言 | 未改 ID、未改判据 |

## 6. 下一步

M4-6 · 托盘通知 + 任务详情 7 项操作 + 错误报告面板（M4 收口，随后补 `acceptance --milestone M4`）。

## 7. 审计修正（2026-11-06 复验）

- **真 Bug**：`format-id` 的值正则误留了一个空格字符，导致 `-f '137 251'` 被接受（argv 单元素带空白，违反既有「argv 不含空白」约束）。已修复为 `^[A-Za-z0-9_+.,/:~*\[\]<>=!-]{1,80}$`，并补回归用例「rejects a whitespace-containing format id」，测试数 29 → 30。
- 影响面：仅自定义命令模板的格式串校验；普通下载路径不走该校验，`EXPECTED_MINIMAL` 未受影响。
- 该缺陷说明：**本轮 M4 首过并非零缺陷**，报告不再声称「一次通过」。
