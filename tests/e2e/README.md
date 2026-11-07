# tests/e2e — 三弹窗截图 / DOM 基线回归（M3 · B4）

本目录是 **PRD-M3 §5.5 / D-31** 的零依赖离线载体：`packages/ui/` 是纯静态
HTML/CSS/原生 JS 三弹窗，`scripts/run-e2e.mjs` 直调本机**已缓存**的
`chrome-headless-shell.exe` 做截图与 `--dump-dom`，**不依赖** `@playwright/test` /
`react` / `react-dom` / `@mui/material`（这些包只是根 `package.json` 的
`ytvdltPlannedDependencies` 登记项，未安装，`pnpm-lock.yaml` 零改动）。

## 固定渲染参数（跨机器稳定）

| 项 | 值 |
|---|---|
| exe | `C:\Users\leolee\AppData\Local\ms-playwright\chromium_headless_shell-1234\chrome-headless-shell-win64\chrome-headless-shell.exe` |
| `--version` | `Google Chrome for Testing 151.0.7922.34` |
| 窗口 | `--window-size=1280,800` |
| DPI | `--force-device-scale-factor=1` |
| 其它 | `--headless --disable-gpu --no-sandbox --hide-scrollbars --disable-lcd-text --virtual-time-budget=2000 --allow-file-access-from-files` |
| 字体 | `packages/ui/src/styles/ytvdlt.css` 固定 `Arial, Helvetica, Liberation Sans, sans-serif`，CSS 中**无 `url()` 引用** |
| 驱动 | `spawnSync(绝对路径, argv[], {shell:false, windowsHide:true})`，**禁止字符串拼接命令** |

`--allow-file-access-from-files` 是必需的：Chrome 对 `file://` 页面禁用异步
`fetch()`，`packages/ui/src/fixtures/probe-fixture.js` 改用**同步 XHR** 读取
`fixtures/*.json`，因此 fixture 仍是真实 L1 录制 JSON 而非内联硬编码。

## 目录

- `fixtures/dialog-media.json` — 由 `tests/fixtures/info-video.json`（L1 录制）经
  `omitUrl()` 剥离所有 `url` 键得到；`formats` / `subtitles` / `chapters` 字段与源一致。
- `fixtures/dialog-playlist.json` — 由 `tests/fixtures/info-flat-playlist.json` 经 `omitUrl()` 得到。
- `fixtures/dialog-media-empty.json` — 同源的空数据场景（`formats:[]` / `subtitles:{}` /
  `entries:[]`）与 probe 失败错误对象；**不虚构任何格式 / 字幕 / 条目**。
- `baselines/*.png` — 每个用例一张 1280×800 基线截图（含空态 / 禁用态 / 错误态）。
- `baselines/*.dom.html` — 每个用例一份 `--dump-dom` DOM 快照基线。

> `MediaFormat.url` / `SubtitleTrack.url`（`packages/shared/src/media.ts:15-16,23`）
> 含签名 / 凭据，在 fixture、DOM、日志、`reports/e2e-summary.json` 中**零出现**。
> `_type: "url"` 是 `PlaylistEntry` 的合法枚举值，不是凭据字段；红线检测只针对
> **名为 `url` 的自身属性**。

## 生成 / 更新基线

```bash
npm run test:e2e -- --update-baselines   # 重新生成 PNG + DOM 基线（改动后必须重跑 3 次默认模式）
npm run test:e2e                        # 用基线判定（缺失基线直接 FAIL，不静默创建）
npm run test:e2e -- --negative-checks   # 附 QA 三类反例复验
node scripts/run-e2e.mjs --case=format-ready --json
```

产物：`reports/e2e-summary.json`，含 exe 绝对路径 / 版本 / 全部 argv / 窗口 DPI 字体 /
fixture 与基线 SHA-256 / 每例 `pass|fail` / `differPixels` / `ratio` / `negativeChecks[]`。

## 判定口径（§1.5.3）

| 级别 | 判据 |
|---|---|
| **主判据 ①** | DOM 快照：与 `baselines/*.dom.html` 逐字节比对 + 结构化断言（三组分栏 / 按语言多选 / 禁用·空·错三态 / `aria-disabled` / 已选计数 / 合计体积缺失显「—」/ 五域同构回写 JSON / 无 `url`、无 `mergeToMkv`） |
| **主判据 ②** | 像素容差：`scripts/lib/png-diff.mjs` 用 `node:zlib` 解 IDAT + filter 0–4 逆变换，逐像素 RGBA 比对；尺寸必须 1280×800；**单通道差 ≤2**（吸收亚像素抗锯齿），**不同像素数必须为 0**（比 §1.5.3 的 0.1% 更严格）。理由：固定 1280×800 / DPR1 / 固定字体下本机连跑 3 次 `differPixels=0`，把 ratio 上限收紧到 0 才能保证 QA「改坏 1 像素」必然 FAIL，不会被 0.1% 容差吞掉 |
| 备选（不作主判据） | PNG 字节 / SHA-256 哈希。Chrome 输出含非确定性元数据，**哈希不稳**，只在 `hashStable:true` 且同环境验证后启用 |

## QA 反例复验（改坏任一基线必须 FAIL）

`run-e2e.mjs` 每次运行都会执行三类**内存级**反例并写入 `negativeChecks[]`；QA 也可以
直接改动磁盘基线后跑默认模式：

1. **改坏 PNG 基线**：用任意图像工具改 1 像素，或直接把 `baselines/<其它用例>.png`
   复制成 `baselines/format-ready.png` → 主判据 ② `comparePngBuffers` 必须 FAIL。
   内存等价：`corruptRgba(decodePng(baseline), 1)` → `compareRgba` `pass===false`。
2. **改坏 DOM 基线**：删掉 `baselines/format-ready.dom.html` 里的 `id="ytvdlt-confirm"`
   或把 `aria-disabled="true"` 改成 `"false"` → 主判据 ① 必须 FAIL。
3. **改坏 fixture**：给 `fixtures/dialog-media.json` 的 `formats[0]` 注入 `url` 键，或
   虚构一个 `format_id` → `validateFixtures()` 的 URL 红线 / 同源校验必须 FAIL。

`--negative-checks` 会让上述三类反例显式进入 exit code 判定；任何一类「改坏了却
仍然 PASS」都会令 `npm run test:e2e -- --negative-checks` 退出 1。

## 联网后补做（PRD §5.5 表 5 项，本轮不做）

装 `react` / `react-dom` / `@mui/material` / `@playwright/test` → 三弹窗迁移 React 组件 →
新建 `playwright.config.ts` + `tests/e2e/*.spec.ts` → 正式 runner 重跑并**替换基线**
→ 复验 `A-M3-01…06`（ID 不改号）。**本轮禁止声称正式基建已建成。**
