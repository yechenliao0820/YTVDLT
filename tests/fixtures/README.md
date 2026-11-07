# tests/fixtures — M1 offline fixtures

All fixtures are offline-only: no external network, no real credentials, no
spawned processes (except the L2 `probe-local` case which uses a local
127.0.0.1 HTTP server + the bundled yt-dlp.exe).

| File | 来源 | 用途 |
|---|---|---|
| `info-video.json` | 手工录制的 `--dump-single-json` 样本（字段完整） | `JsonMapper.toMediaInfo` 契约 / A-4.1-04 / A-INF-08 |
| `info-flat-playlist.json` | 手工录制的 `--flat-playlist --dump-single-json` | `JsonMapper.toPlaylistInfo` / A-INF-08 |
| `info-minimal.json` | 缺字段样本 | 兜底不抛异常 / A-INF-08 |
| `config-valid.json` | 合法 ConfigStore 快照（2 条 saved_links） | A-4.1-03 / A-4.4-19 |
| `config-corrupt.json` | 截断 JSON | 损坏回退 + WARNING / A-4.1-03 |
| `stderr-network.txt` | 4 类网络错误关键字 | ErrorMapper 互斥 / A-4.5-05 |
| `stderr-unsupported.txt` | `example.invalid` 不支持站点 | A-4.5-03 |
| `progress-basic.log` | 录制进度行（M2 `ProgressParser` 用，M1 占位） | FakeEngine 回放 / A-INF-10 |
| `media/fixture.mp4` | `u3-verify.mjs` 用随包 LGPL FFmpeg 生成（libopenh264 + aac，10s） | U3 / L2 `probe-local` |
| `manifest.json` | U3 生成：fixture SHA-256 / 时长 / 流信息 | A-INF-03 |

`info-*.json` 中的 URL 均为 `example.org` 占位，**不含任何签名/凭据**；
`formats[].url` 仅存在于内存 DTO，绝不写入日志或错误报告（§4.4/§4.6）。

## M3 追加（B4）

`tests/e2e/fixtures/*.json` 是 **L1 录制 DTO 的 `omitUrl()` 派生副本**，不是新录数据、
不是硬编码：

| 文件 | 来源 | 变换 |
|---|---|---|
| `dialog-media.json` | `tests/fixtures/info-video.json` | 递归删除所有名为 `url` 的自身属性（`formats[].url` / `subtitles[].url` / `automatic_captions[].url`） |
| `dialog-playlist.json` | `tests/fixtures/info-flat-playlist.json` | 同上（含 `entries[].url`） |
| `dialog-media-empty.json` | 上述两份 | 空数据场景：`formats:[]` / `subtitles:{}` / `automatic_captions:{}` / `chapters:null` / `entries:[]` + probe 失败错误对象 |

- **同源校验**：`scripts/run-e2e.mjs` 与 `tests/contract/dialog-dto.contract.test.ts`
  逐条比对 `format_id` / 字幕语言键 / 条目 id + 标题与源 fixture 一致，**禁止虚构**。
- **红线**：`MediaFormat.url` / `SubtitleTrack.url` 在 fixture / DOM / 日志 / 报告中零出现；
  `webpage_url` 与 `PlaylistEntry._type:"url"` 是合法字段/枚举值，不是凭据 URL。
- `packages/ui/src/fixtures/probe-fixture.js` 加载时**再次**执行 `omitUrl()` 兜底。
- `tests/e2e/README.md` 记录固定渲染参数、主判据 ①/② 与 QA 反例复验步骤。
