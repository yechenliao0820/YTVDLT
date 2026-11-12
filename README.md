# YTVDLT

**English** · [简体中文](README.zh-CN.md)

[![Latest release](https://img.shields.io/github/v/release/yechenliao0820/YTVDLT?style=flat-square&color=1d63b8)](https://github.com/yechenliao0820/YTVDLT/releases)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-45-47848F?style=flat-square&logo=electron&logoColor=white)
![Renderer](https://img.shields.io/badge/renderer-zero--dependency-eef2f6?style=flat-square)
![License](https://img.shields.io/badge/license-Non--Commercial-orange?style=flat-square)

A focused Windows desktop downloader for video and audio. **Install it and it
works**: `yt-dlp`, FFmpeg, Node.js and aria2c ship inside the installer, so there
is no Python / Node / FFmpeg setup, no `PATH` editing and no "engine not found"
dialog on first launch.

- Platform: Windows 10 (1809+) / Windows 11, x64
- Shell: Electron 45, TypeScript; the renderer is plain HTML/CSS/JS with **zero
  runtime dependencies**
- Download engine: bundled `yt-dlp`, verified and replaceable at runtime
- Maintainability: a one-way layering rule keeps all queue logic offline-testable

## Latest release — 0.3.0

| | |
|---|---|
| Released | 2026-11-12 |
| Artifact | `YTVDLT.Setup.0.3.0.exe` — NSIS installer, Windows x64, 226,282,986 B |
| SHA-256 | `5d93f92307e3b91ac72e5fa372332caa8766e265d0709254dd87d38287940af3` |
| Tag / release baseline | `v0.3.0` |
| Downloads | [Release 0.3.0](https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.3.0) · [all releases](https://github.com/yechenliao0820/YTVDLT/releases) |

**What changed in 0.3.0** — the first release to carry everything that landed
on top of 0.2.9: the subtitle pipeline, TXT and playlist batch import, the
lowest-quality fix (`-S +res`), bounded child-process output, the dynamic
supported-sites panel with six-state URL pre-checks, the HTTP / IPC /
termination boundary hardening, and two new UI paths — a pre-check you can see
and confirm before a link is queued, and command templates in Settings
(D-124…D-139).

The installer is **not code-signed**; SmartScreen will warn once on first run.

## Screenshots

All images below were regenerated from the **actual UI pages** in headless
Chromium at 1280×800 (the task-detail shot is 1280×480). Task rows are
representative sample data injected into the real renderer — the same mechanism
the E2E suite uses — so the cards show several states at once: downloading,
parsing, completed, cancelled, failed, plus two local file-state hints. (The
supported-sites panel added later is injected in live mode only, so it does not
appear in these static captures.)

| Download queue — light theme (Chinese), with file-state hints | Download queue — dark theme (English) |
|---|---|
| ![Queue](docs/assets/queue.png) | ![Queue, dark](docs/assets/queue-dark.png) |

| Settings — section list follows the scroll | Settings → About — licence table and full English text |
|---|---|
| ![Settings](docs/assets/settings.png) | ![Licences](docs/assets/settings-licence.png) |

| Delete confirmation — files option is an explicit tick | Update dialog — release notes from GitHub |
|---|---|
| ![Delete dialog](docs/assets/delete-dialog.png) | ![Update dialog](docs/assets/update-dialog.png) |

| Task detail — artifacts, state and seven actions |
|---|
| ![Task detail](docs/assets/task-detail.png) |

The repository's social preview image is regenerated too, at 1280×640
(`docs/assets/social-preview.png`).

To regenerate them: `node scripts/capture-readme-shots.mjs` (writes only
`docs/assets/*.png`, never touches git or the E2E baselines).

## What it is

An Electron shell that does three things and nothing else: it orchestrates a
queue, it renders a static UI, and it supervises `yt-dlp` as a child process.
The interesting part is the boundary:

- `packages/core` is pure TypeScript — it may **not** import `node:fs`,
  `node:child_process` or `electron`; every external capability arrives through
  an injected port.
- `packages/engine-ytdlp` builds argv, parses progress lines and validates
  artifacts; network and disk still come from ports.
- `packages/ui` is a dependency-free static page set; it talks to the main
  process through one whitelisted `contextBridge` surface. The renderer never
  touches the filesystem.
- `apps/desktop/src/main/adapters/` is where real `node:*` and Electron
  capabilities are wired in.

That is what makes the queue logic, progress parser, update decision path,
error mapper and local-file state probe testable offline against an in-memory
filesystem. `scripts/check-layering.mjs` enforces the boundary.

## Features

### Downloading

- Paste a link, choose **video** or **audio**, pick a resolution preset
  (best / 2160p / 1440p / 1080p / 720p / 480p / 360p / lowest) or an audio
  bitrate (192 / 128 / 64 / 32 kbps, with optional MP3 or M4A transcode).
  *Lowest* is a real choice again: it asks the engine for the smallest stream by
  relative ordering rather than pinning a number, so a 480p-only source gives
  480p and an audio-only source is not given an invented video stream. (D-133)
- Batch import: paste a TXT list (one URL per line) or a playlist link. A
  playlist is probed live, previewed and selected by default, then confirmed
  once into N independent tasks — each with its own cancel / retry.
  (D-129, D-130)
- **Supported sites, read from your own engine.** The panel lists what the
  bundled `yt-dlp` actually reports (`--list-extractors`) — site count,
  sub-extractors, engine version — with search, sort, refresh and paging. There
  is no fallback list, by design: if the engine cannot be read, the panel says
  so instead of inventing names. `GenericIE` is called out separately, because
  it claims any http(s) URL. (D-134)
- **Support pre-check before a URL joins the queue.** A submission is classified
  as `SUPPORTED` / `UNSUPPORTED` / `NO_MEDIA` / `INDETERMINATE` / `TIMEOUT` /
  `CANCELLED` by the same engine, and **only an unambiguous "unsupported" is
  blocked** — everything else is let through and fails with the engine's own,
  more accurate error if it really fails. A page that simply has no video is
  *not* reported as an unsupported site. The single-link box asks the engine
  **before** creating a task: a clear refusal is shown in the UI language, and
  an unconfirmed verdict (no media / indeterminate / timeout) asks whether to
  queue it anyway instead of enqueueing silently. (D-134, D-139)
- Real filenames: `--restrict-filenames` is no longer silently enabled, so CJK
  titles, spaces and punctuation survive. Existing configs are migrated
  (schema v1 → v2). A repeated download is saved as a separate ` (1)` / ` (2)`
  copy instead of being reported as `ALREADY_DOWNLOADED`. (D-110, D-101)
- Live progress that says something: percentage, downloaded / total size,
  transfer speed and remaining time — each shown only when the engine can
  report it. Unknown percent stays an honest indeterminate animation; a real
  `0` is still `0.0%`. (D-107, D-111, D-112)
- yt-dlp's native downloader is the default. The optional external aria2c
  downloader suppresses yt-dlp's progress template entirely — in an A/B test a
  17.6 MB clip produced **0** progress lines under aria2c vs **6** natively,
  and a 14:56 1080p HLS stream took 89 s vs 24 s (3.7×). Those numbers are
  specific to that clip and environment, not a universal benchmark.
- While a task is active the queue polls every 400 ms and patches only the
  numbers in place, so cover thumbnails do not flicker. Idle polling stays at
  1.2 s. (D-112)
- **Command templates.** Save a named, reusable set of yt-dlp arguments (one
  argument per line) from *Settings → Templates*, and delete them again. Every
  argument is validated against a positive allowlist on the main side —
  `--exec`, `--config-locations`, `--cookies-from-browser` and friends are
  rejected rather than trusted. Editing an existing template is not exposed
  yet; the store already supports it. (D-139)
- Cancel, retry, open file, open folder, multi-select, sort, bulk delete and
  clear history.

### Output you can trust

- Subtitle language filters, automatic captions, embedding and separate
  subtitle files are resolved by the download plan into yt-dlp arguments.
- After every download the artifact is verified: byte-level checks, `ffprobe`,
  full decode, duration tolerance and stream integrity. A truncated file is
  reported as a **failure**, not as "completed".
- Downloading does not end at 100%: merging, post-processing and verification
  are shown as real stages (*Merging video* / *Finalizing*); the green full bar
  appears only after verification passed. (D-115)
- Per-task detail and log pages, plus a copyable error report with the media URL
  redacted. Failed cards also carry a one-line plain-language reason such as
  *Network connection failed*. (D-109)

### Local files and the task lifecycle

This is the area 0.2.8 concentrated on. A task's history record and the file on
disk are two different things:

- **Deletion is idempotent.** `ENOENT` / `ENOTDIR` mean the local cleanup is
  already complete, so the record is still removed. File-in-use, permission and
  drive errors are *not* swallowed: the record is kept and the real OS reason
  is shown. (D-120)
- **No cross-task damage.** If another live task still references the same
  physical file, that file is skipped rather than recycled. No deletion is
  widened beyond the paths the engine recorded for this task.
- **On-demand file state.** Only completed tasks are probed, against the
  recorded artifact path — there is no directory scan. Results are cached for
  1.5 s and force-refreshed on load, on page re-entry and on every open action.
  Buckets are `present / missing / inaccessible / unavailable / invalid`.
- **Honest feedback.** A missing file never blocks opening its original
  folder; a transient drive error is never reported as "the user deleted it".
  Cards get a quiet hint, keep their *Completed* badge, and are never hidden or
  auto-removed. (D-120)
- Files always go to the **Recycle Bin** via `shell.trashItem` — never `rm -rf`.

### Comfort

- Cover thumbnails cached locally with a persistent index, configurable caps
  (128 MiB / 500 files / 30 days), automatic pruning and an "in use" guard.
  Pruned covers also go to the Recycle Bin. (D-103)
- Global navigation bar, a single fullscreen authority (menu F11 and the UI
  button share it), light / dark / follow-system theme, accent colours,
  reduced-motion support and responsive main-window layouts. Frozen screenshot
  pages keep their fixed 1280×800 canvas. (D-106)
- Chinese and English UI, switchable at runtime, with a shared key catalogue.
- Private mode: clears the task history when the window closes, and never
  touches your files.
- Download location picker: video and audio can live in different folders; the
  chosen folder is checked for write access **before** it is saved.
- Settings organised in panes, with a section list that follows the scroll and
  jumps on click. Settings → About now states the licences layer by layer.
- The version label comes from the main process (`APP_INFO`); navigation and
  language switches no longer lose it, and an unknown version shows `v—`
  instead of a stale number. (D-114)
- **First launch follows the OS language**: Simplified, Traditional or any
  Chinese system starts in Chinese, everything else in English. The result is
  persisted immediately — every later start reads the saved value, and only a
  manual switch in Settings changes it. (D-147) The UI ships two languages,
  Simplified Chinese and English, so Traditional-Chinese systems see
  Simplified text.
- **A gentle "How is this version treating you?"**: asked once on the third
  launch of a version while no task is running — if you like YTVDLT, a Star
  on GitHub helps. At most twice per version, with *Maybe later* and *Don't
  ask again*; a new version may ask again. (D-148)

### Staying current

Two independent update paths, on purpose — a stale engine breaks every download
while the app itself is fine.

| | App | yt-dlp engine |
|---|---|---|
| Source | GitHub Releases of this repository | official yt-dlp release feed |
| Check | on startup (toggle), 6 h throttle, or manually | on startup (toggle), 24 h throttle, or manually |
| Verify | SHA-256 recomputed **both** before reusing a cached installer and immediately before launching it; baseline is the published `digest` or a `.sha256` sidecar; with neither, the cache is refused and the file is downloaded again | `SHA2-256SUMS` |
| Apply | download the installer, then **you** confirm the NSIS wizard | atomic `.new` → rename, rollback to `.bak` on mismatch |
| Skip | "don't remind me about this version" | — |

A suspicious file is quarantined (renamed), never permanently deleted; the app
never installs silently. When the installer is ready the button switches to
*Install now* and actually sends `install` — it no longer loops back through
`download`. (D-104, D-119)

The release-notes dialog explains the **whole interval you skipped**: read the
release list, keep every version between your build and the one on offer, and
print one block per version, oldest first. A machine on 0.2.8 upgrading to
0.3.0 therefore reads what 0.2.9 changed *and* what 0.3.0 changed — instead of
one body that refers to a version it never ran. (D-140)

### Known limitations

Stated plainly rather than glossed over:

- The live playlist batch flow (probe → preview → select all by default → one
  confirmation → N independent tasks) is wired to the real engine. The legacy
  M3 playlist picker and the per-format picker remain fixture-driven previews
  and are not part of the production batch path.
- The installer is unsigned; `Engine: unknown` can still appear in an error
  report; post-processing stages have no speed / ETA because the engine does
  not report one.
- The supported-sites panel and the URL pre-check have been run against the
  real engine **both offline and online**: a two-round live audit (2026-11-12)
  covered a dedicated extractor, two GenericIE pages, a media-less page, an
  age-gated video and an unavailable one, with **0 misclassifications**, and
  confirmed that *lowest* selects the minimum available video height (144p on
  the 144/240/360/480/720/1080 source). Real Electron-window verification and
  installer acceptance are still pending. The DNS-rebinding gap is now closed
  (D-143): every outbound connection is pinned to a policy-verified resolved
  address, re-resolved and re-checked on every redirect hop; residual limits
  (such as a fully controlled resolver) are recorded under D-143. The
  hardening history lives in `DECISIONS.md` D-137 / D-138 / D-143.
- App updates download the whole installer (no delta), and the portable build
  does not participate in self-update.
- No real-device, all-sites coverage is claimed; the verification numbers
  below are automated test results, not a field trial.

Full list: [`docs/AI-MAINTENANCE.md`](docs/AI-MAINTENANCE.md) §10.

## Release history — 0.2.2 → 0.3.0

Nine releases in four days. The trajectory moved from UI polish, through
download-core correctness, to edge cases that only appear after a file has been
moved or deleted outside the app.

| Version | Date | Focus | Decisions | Release |
|---|---|---|---|---|
| 0.2.2 | 2026-11-08 | Settings panes with a scrolling section list; indeterminate wait animation; duplicate downloads saved as `(1)` copies; README split into EN/ZH | D-99…D-102 | [v0.2.2](https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.2) |
| 0.2.3 | 2026-11-09 | Thumbnail cache pruning; updater SHA-256 re-verification; E2E browser auto-discovery | D-103…D-105 | [v0.2.3](https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.3) |
| 0.2.4 | 2026-11-09 | Global navigation / fullscreen / theme / responsive layout; honest progress; one-line failure briefs; startup-phase audit | D-106…D-109 | [v0.2.4](https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.4) |
| 0.2.5 | 2026-11-09 | Real (CJK) filenames; progress restored by dropping default aria2c; 400 ms polling and in-place progress patches | D-110…D-112 | [v0.2.5](https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.5) |
| 0.2.6 | 2026-11-09 | `APP_INFO` version truth; post-download stages; safer delete dialog; default Videos folder; per-task temp-file isolation | D-114…D-118 | [v0.2.6](https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.6) |
| 0.2.7 | 2026-11-09 | Updater install state machine; card button height adapts to large windows | D-119 | [v0.2.7](https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.7) |
| 0.2.8 | 2026-11-10 | Idempotent deletion; on-demand local file state detection; layered licence pane with the full English licence | D-120 / D-121 | [v0.2.8](https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.8) |
| **0.2.9** | **2026-11-10** | Native right-click edit menu in editable fields; settings placeholder shows `—` instead of a made-up path | D-122 / D-123 | [v0.2.9](https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.2.9) |
| 0.3.0 | 2026-11-12 | Subtitle pipeline; TXT / playlist batch import; bounded engine output; dynamic supported-sites list and the six-state URL pre-check; HTTP / IPC / process-termination hardening; command templates | D-124…D-139 | [v0.3.0](https://github.com/yechenliao0820/YTVDLT/releases/tag/v0.3.0) |

0.3.0 is published. Work landing on top of it, **not yet released** — the
version-jump release-notes fix (D-140, see *Staying current*), the live-mode
fixture guard (D-141), honest cancel-failure handling (D-142), and four
external-audit fixes: DNS-pinned outbound connections (D-143), bounded
download output (D-144), truly atomic config writes (D-145), and a
detail-page cancel button aligned with what the queue can actually do
(D-146) — is described in
[`docs/CHANGELOG.md`](docs/CHANGELOG.md) and
[`docs/DECISIONS.md`](docs/DECISIONS.md) (now at D-146).

## Engineering and verification

The 0.2.8 release was gated by:

| Gate | Result |
|---|---|
| `pnpm typecheck` | 5/5 workspace packages successful |
| Unit / contract / integration tests | 1152 passed (88 new cases covering the deletion matrix and file-state scenarios) |
| `node scripts/run-e2e.mjs` | 31/31 screenshot + DOM cases, 5/5 deliberate negative checks |
| Screenshot drift | 0 px (two DOM baselines rebuilt per case after the licence-pane change; no PNG baseline was overwritten) |
| `check-layering` / `frozen-gate` | 0 violations / passed |

The 0.3.0 work (subtitles, batch import, playlist batch, supported sites, URL
pre-check, command templates and the D-137/D-138 security-boundary hardening)
was gated separately by:

| Gate | Result |
|---|---|
| `pnpm typecheck` | 5/5 workspace packages successful |
| Unit / contract / integration tests | **1829 passed / 2 skipped across 138 files, 0 failed** |
| Coverage | statements 88.7% / branches 86.7% / functions 92.0% / lines 88.7% (floor 70, not raised) |
| Screenshot E2E | 31/31 cases + 5/5 negative checks; only the two settings baselines were rebuilt (PNG + DOM), the other 58 baseline files byte-identical |
| `check-layering` / `frozen-gate` / `request.ts` freeze | 0 violations / passed / byte-identical |
| Engine self-report provenance | Which extractors exist, and how failures are classified, are read back from the shipped `yt-dlp` — never from a checked-in list |

The audit-and-repair round after 0.3.0 (D-140…D-146, not yet released) passed
the same gates:

| Gate | Result |
|---|---|
| Typecheck | 5/5 workspace packages successful (per-package `tsc --noEmit`) |
| Unit / contract / integration tests | **1,871 passed across 132 files, 0 failed** |
| Coverage | statements 88.3% / branches 86.3% / functions 91.4% / lines 88.3% (floor 70, not raised) |
| Screenshot E2E | 31/31 cases + 5/5 negative checks; **0 px drift, no baseline rebuilt** (the detail-page cancel fix applies to live mode only) |
| `check-layering` / `frozen-gate` / `request.ts` freeze | 0 violations / passed / byte-identical |

Design invariants worth knowing if you plan to modify the code:

- File deletion has exactly one primitive — `shell.trashItem`. Nothing in the
  adapter permanently unlinks a file.
- The renderer never sees a media URL in `TASK_LIST`, and never receives a
  remote thumbnail URL — only a local cached path.
- `packages/core` imports no `node:*`; `check-layering.mjs` fails the build if
  it ever does.
- Every IPC payload is validated against an explicit key whitelist before a
  handler runs.
- The supported-sites list and the URL verdicts come from the running engine.
  There is deliberately no hard-coded fallback, and the enqueue gate fails
  **open**: only a clear "unsupported" blocks a URL.

These are automated results for the shipped build, not a claim that every
Windows device, DPI setting or video site has been exercised.

## Requirements

- Windows 10 1809+ or Windows 11, x64
- No Python, Node.js, FFmpeg or `PATH` setup — the runtime is bundled

## Install

1. Open [Releases](https://github.com/yechenliao0820/YTVDLT/releases) and
   download `YTVDLT.Setup.<version>.exe`.
2. The installer is **not code-signed**, so SmartScreen warns once:
   *More info → Run anyway*.
3. Launch, paste a link, press **Paste & parse**. New installs save into the
   Windows **Videos** library under `YTVDLT` (`app.getPath('videos')`,
   following OneDrive / library redirection); audio goes to its `Audio`
   subfolder. Existing configs are not migrated. (D-117)

## Where things go

| What | Path |
|---|---|
| Default downloads (new install) | `%USERVIDEOS%/YTVDLT` and `…/YTVDLT/Audio` — resolved at runtime by the main process |
| Config / logs (writable install dir) | `<exe folder>\config\config.json`, `<exe folder>\logs\app-YYYYMMDD.jsonl` |
| Config / logs (read-only install, e.g. `C:\Program Files`) | `%APPDATA%\YTVDLT\config\…` |
| Cover cache / downloaded updater | `<dataDir>\thumbs\…`, `<dataDir>\updates\…` |
| Per-task working files | `<dataDir>/work/<taskId>/` (same volume as the output) — `.part`, `.ytdl`, fragment indexes and the artifact manifest. Leftovers are resume evidence, not garbage |

## Build from source

Requires Node.js 22 and pnpm 9.

```bash
pnpm install
pnpm typecheck                 # 5 workspace packages
npm test                       # vitest + v8 coverage (gate 70%)
node scripts/run-e2e.mjs       # screenshot/DOM baselines + deliberate negative checks
node scripts/handoff-check.mjs # reconciles doc numbers with the repo

node scripts/build-desktop.mjs # bundle main + preload, copy the renderer
node scripts/capture-readme-shots.mjs  # optional: regenerate docs/assets/*.png

CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder \
  --config apps/desktop/electron-builder.yml \
  --config.directories.buildResources=apps/desktop/build \
  --config.directories.output=dist-<version> \
  -c.extraMetadata.main=apps/desktop/dist/main/main.cjs \
  -c.electronDist=node_modules/electron/dist \
  --win nsis
```

Four of those flags are not decoration:

| Flag | Why it is required |
|---|---|
| `--config apps/desktop/electron-builder.yml` | the config is not at the repo root |
| `--config.directories.buildResources=apps/desktop/build` | otherwise electron-builder falls back to the stock Electron icon |
| `-c.extraMetadata.main=apps/desktop/dist/main/main.cjs` | the root `package.json` has no `main` (it is also the workspace root) |
| `-c.electronDist=node_modules/electron/dist` | reuses the unpacked Electron, so a flaky CDN cannot break the build |

**Build order matters**: `build-desktop.mjs` must run before `electron-builder`,
otherwise the asar contains the previous frontend. `electron-builder` may also
rewrite the root `package.json` in place — check and restore it afterwards.

## Project layout

```
apps/desktop/          Electron shell: main process, preload, packaging config
packages/shared/       pure types + IPC contract (no node:*, no electron)
packages/core/         pure logic: queue, verification, config, error mapping
packages/engine-ytdlp/ yt-dlp adapter: argv, progress parsing, artifacts
packages/ui/           zero-dependency static renderer (pages/styles/i18n)
scripts/               build, test, acceptance, screenshot and smoke-test drivers
docs/                  decisions, maintenance manual, per-milestone reports
```

The dependency direction is one-way and enforced by `scripts/check-layering.mjs`:

```
ui  ←  preload  ←  apps/desktop
        ↑
   shared  ←  core  ←  engine-ytdlp
```

## Documentation

| Want to know | Read |
|---|---|
| How to change something, where, and how to verify it | [`docs/AI-MAINTENANCE.md`](docs/AI-MAINTENANCE.md) |
| What each release changed | [`docs/CHANGELOG.md`](docs/CHANGELOG.md) |
| Why a decision was made (numbered D-xx records) | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| Delivery scope and known boundaries per version | [`docs/DELIVERY-REPORT.md`](docs/DELIVERY-REPORT.md) |
| Build environment and packaging pitfalls | [`docs/BUILD.md`](docs/BUILD.md) |
| Acceptance criteria and evidence | [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) |
| Artifact history and retired builds | [`docs/BUILD-HISTORY.md`](docs/BUILD-HISTORY.md) |
| Bundled binaries, versions and licence texts | [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md) |

## Third-party components

Each component keeps its **own** licence; this project's licence does not alter
those terms.

| Component | License | How it is used |
|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | separate process, replaceable |
| FFmpeg / ffprobe | LGPL-3.0 | dynamically linked shared build, replaceable DLLs |
| aria2c | GPL-2.0-or-later | separate process, optional segment downloader |
| Electron | MIT | application shell |
| Node.js | MIT | bundled runtime |

Full texts and compliance notes: [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md).

## License

**YTVDLT Non-Commercial License 1.0** — see [`LICENSE`](LICENSE). The complete
English text is also embedded in Settings → About.

- Free for **non-commercial** use: personal study, research, teaching, charity.
- You may read, modify and redistribute the code, provided the license and
  attribution stay intact and modified versions are clearly marked.
- Commercial use requires prior written permission from the author.
- This is **source-available**, not OSI open source; it is **not** MIT.

## Disclaimer

YTVDLT is a front-end for `yt-dlp`. You are responsible for what you download,
for complying with the terms of service of the sites you use, and with applicable
copyright law. The project does not circumvent DRM and does not host or
distribute any media.

<details>
<summary>Repository history</summary>

The original `.git` (development history from 2026-11-05 to 11-07) was lost in a
directory-migration accident on 2026-11-07, with no remote copy to restore from.
This repository is a rebuild: the code and documentation are complete, but the
commit hashes do not match the original history. Recovered commit references are
documented in [`docs/GIT-HISTORY-RECOVERED.md`](docs/GIT-HISTORY-RECOVERED.md).

</details>
