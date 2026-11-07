# resources/runtime/win-x64 — M1 运行时前置（HANDOFF §12.4 / §12.10）

> 二进制 **不入库**（`.gitignore` 忽略 `*.exe` / `*.dll` / `*.zip` / `ffmpeg/`）。
> 文本资产（`runtime-manifest.json`、`runtime-manifest.schema.json`、`SHA2-256SUMS`、
> `FFMPEG-LICENSE.txt`、本 README）入库。

## 来源（精确 URL / tag，逐项 SHA-256 见 runtime-manifest.json）

| 文件 | 来源 | tag / 版本 | 许可证 |
|---|---|---|---|
| `yt-dlp.exe` | `https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe` | `2026.10.26` | Unlicense（standalone exe 含第三方组件，NOTICE 在 M5 补齐） |
| `SHA2-256SUMS` | `https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/SHA2-256SUMS` | `2026.10.26` | — |
| `node.exe` | `https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip` 内 `node.exe` | `v24.22.2` | MIT |
| `ffmpeg/*` | `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip` 整个 `bin/` 原样 | `latest`（n9.0 稳定线；脚本记录实际解析到的 asset/published_at） | LGPL（zip 内 `LICENSE.txt` 为 LGPLv3 文本，见 `FFMPEG-LICENSE.txt` 与 DECISIONS D-08） |
| `FFMPEG-LICENSE.txt` | 同上 zip 内 `LICENSE.txt` | — | LGPLv3 全文 |
| `aria2c.exe` | **不捆绑**，用户自备 | `1.37.x` | GPL-2.0-or-later |

BtbN `latest` 是滚动 tag；如需完全可复现，改用
`autobuild-2026-11-04-12-51/ffmpeg-n9.0.2-47-gb204e94e90-win64-lgpl-shared-9.0.zip`
（`fetch-runtime.mjs` 内置该固定备选，选择理由见 `DECISIONS.md` D-06）。

## 重建命令

```bash
node scripts/fetch-runtime.mjs --only=ytdlp
node scripts/fetch-runtime.mjs --only=node
node scripts/fetch-runtime.mjs --only=ffmpeg
node scripts/fetch-runtime.mjs --finalize
node scripts/fetch-runtime.mjs --only=ytdlp --verify-only
node scripts/fetch-runtime.mjs --only=node   --verify-only
node scripts/fetch-runtime.mjs --only=ffmpeg --verify-only
npm run check-runtime
```

## 路径约定（最容易踩坑）

- `items[].path` 是**相对 runtime 根**的 POSIX 路径，**不含 `win-x64` 这一层**。
- 开发态 runtime 根 = `<项目根>/resources/runtime/win-x64`；
  打包态 = `process.resourcesPath/runtime`（`extraResources from: win-x64 → to: runtime` 平铺）。
- 两态共用**同一份** `runtime-manifest.json`，路径零改写。
- DLL 与 `ffmpeg.exe` / `ffprobe.exe` **同目录**；`--ffmpeg-location` 已在 U3 实测支持（D-01/U8），
  另有 PATH 前置兜底。
- 运行时**绝不进 asar**；所有 spawn 用绝对路径 + `argv[]` + `shell:false` + `windowsHide:true`。
