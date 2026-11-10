#!/usr/bin/env node
/**
 * capture-readme-shots.mjs — regenerate `docs/assets/*.png` for both READMEs.
 *
 * Renders the REAL UI pages in the bundled chrome-headless-shell over CDP.
 * Task rows are representative sample data injected into the page (the same
 * mechanism the E2E suite uses); no image is drawn or composited by hand.
 * The `?v=` hint supplies the build number exactly as the app does on first
 * paint, so no mock IPC channel is needed for the version label.
 *
 * Usage: node scripts/capture-readme-shots.mjs
 * Writes ONLY docs/assets/*.png. Never touches git, releases or E2E baselines.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { resolveBrowserExecutable } from './lib/find-browser.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UI = join(ROOT, 'packages', 'ui', 'src');
const ASSETS = join(ROOT, 'docs', 'assets');
const PROFILE = join(tmpdir(), `ytvdlt-readme-shots-${Date.now()}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Representative DTO rows, including the D-120 file-state hints. */
function tasks(lang) {
  const zh = lang !== 'en';
  return [
    {
      id: 'run-1', state: 'Running', kind: 'video',
      title: zh ? '城市夜景延时摄影 · 4K' : 'City lights — 4K timelapse',
      uploader: zh ? '影像实验室' : 'Frame Lab', duration: 624,
      percent: 42, speedBps: 4_200_000, etaSec: 96,
      downloadedBytes: 94_371_840, totalBytes: 224_694_080,
      artifactCount: 0, thumbPath: null, errorCode: null, failureKind: null,
      stage: 'downloading', fileStatus: null, dirStatus: null,
    },
    {
      id: 'fetch-2', state: 'FetchingInfo', kind: 'video',
      title: zh ? '开源动画短片 · 1080p' : 'Open movie — 1080p',
      uploader: zh ? '独立制片' : 'Indie Studio', duration: 596,
      percent: null, speedBps: 0, etaSec: null,
      downloadedBytes: null, totalBytes: null,
      artifactCount: 0, thumbPath: null, errorCode: null, failureKind: null,
      stage: null, fileStatus: null, dirStatus: null,
    },
    {
      id: 'done-3', state: 'Completed', kind: 'video',
      title: zh ? '深度学习入门讲座' : 'Deep learning — lecture 01',
      uploader: zh ? '公开课' : 'Open Course', duration: 2840,
      percent: 100, speedBps: 0, etaSec: 0,
      downloadedBytes: 318_767_104, totalBytes: 318_767_104,
      artifactCount: 2, thumbPath: null, errorCode: null, failureKind: null,
      stage: null, fileStatus: 'present', dirStatus: 'present',
    },
    {
      id: 'gone-4', state: 'Completed', kind: 'video',
      title: zh ? '周末旅行记录（文件已移走）' : 'Weekend trip (file moved)',
      uploader: zh ? '个人频道' : 'Personal', duration: 734,
      percent: 100, speedBps: 0, etaSec: 0,
      downloadedBytes: 216_006_656, totalBytes: 216_006_656,
      artifactCount: 1, thumbPath: null, errorCode: null, failureKind: null,
      stage: null, fileStatus: 'missing', dirStatus: 'present',
    },
    {
      id: 'locked-5', state: 'Completed', kind: 'audio',
      title: zh ? '现场录音 · 外置磁盘' : 'Live session — external drive',
      uploader: zh ? '独立音乐' : 'Indie Music', duration: 412,
      percent: 100, speedBps: 0, etaSec: 0,
      downloadedBytes: 48_234_496, totalBytes: 48_234_496,
      artifactCount: 1, thumbPath: null, errorCode: null, failureKind: null,
      stage: null, fileStatus: 'inaccessible', dirStatus: 'present',
    },
    {
      id: 'err-6', state: 'Error', kind: 'video',
      title: zh ? '受限直播回放' : 'Restricted live replay',
      uploader: 'unknown', duration: null,
      percent: 12, speedBps: 0, etaSec: null,
      downloadedBytes: 12_582_912, totalBytes: null,
      artifactCount: 0, thumbPath: null, errorCode: 'HTTP_403', failureKind: 'network',
      stage: null, fileStatus: null, dirStatus: null,
    },
    {
      id: 'cancel-7', state: 'Canceled', kind: 'video',
      title: zh ? '大型素材包（已取消）' : 'Large asset pack (cancelled)',
      uploader: zh ? '素材库' : 'Asset Library', duration: 1800,
      percent: 37, speedBps: 0, etaSec: null,
      downloadedBytes: 61_865_984, totalBytes: 167_205_376,
      artifactCount: 0, thumbPath: null, errorCode: null, failureKind: null,
      stage: null, fileStatus: null, dirStatus: null,
    },
  ];
}

/** Live-mode mock: only the channels the queue page reads on load. */
function queueInit(lang) {
  return `
window.__YTVDLT_SHOT_TASKS__ = ${JSON.stringify(tasks(lang))};
window.ytvdltBridge = {
  channels: [],
  invoke: function (channel) {
    if (channel === 'ytvdlt:task:list') {
      return Promise.resolve({ ok: true, items: window.__YTVDLT_SHOT_TASKS__, tab: 'all', counts: {}, empty: false });
    }
    if (channel === 'ytvdlt:app:info') {
      return Promise.resolve({ version: '0.2.8', name: 'YTVDLT', packaged: true });
    }
    if (channel === 'ytvdlt:settings:get') {
      return Promise.resolve({ privateMode: false });
    }
    return Promise.resolve({ ok: true });
  }
};`;
}

const detailInit = `
window.__YTVDLT_TASK__ = {
  id: 't-20261110-001',
  state: 'Completed',
  percent: 100,
  errorCode: '',
  artifacts: ['C:/Users/leo/Videos/YTVDLT/Deep learning - lecture 01.mp4',
              'C:/Users/leo/Videos/YTVDLT/Deep learning - lecture 01.zh-Hans.vtt'],
  url: 'https://example.org/watch?v=***'
};`;

const SHOW_DELETE_DIALOG = `
var modal = document.getElementById('queue-modal');
if (modal) modal.setAttribute('hidden', 'false');
var count = document.getElementById('queue-modal-count');
if (count) count.textContent = '共 1 个任务';
var box = document.getElementById('queue-modal-with-files');
if (box) { box.checked = true; box.dispatchEvent(new Event('change')); }
`;

/** The shipped HTML still carries the pre-0.2.6 placeholder; a live build
 *  replaces it with the resolved Videos-library paths (D-117). */
const SHOW_REAL_PATHS = `
var pv = document.getElementById('settings-path-video');
if (pv) pv.textContent = '%USERVIDEOS%/YTVDLT';
var pa = document.getElementById('settings-path-audio');
if (pa) pa.textContent = '%USERVIDEOS%/YTVDLT/Audio';
`;

const SHOW_LICENCE = `
var scroll = document.getElementById('settings-scroll');
var about = document.getElementById('section-about');
if (scroll && about) scroll.scrollTop = about.offsetTop - 82;
var details = document.getElementById('about-licence-full');
if (details) details.open = true;
`;

const SHOW_UPDATE_DIALOG = `
if (window.YTVDLTUpdateDialog && typeof window.YTVDLTUpdateDialog.__apply === 'function') {
  window.YTVDLTUpdateDialog.__apply({
    phase: 'available',
    currentVersion: '0.2.7',
    latest: {
      version: '0.2.8',
      notes: 'Fixed: task deletion is now idempotent when a local file is already gone.\\n' +
             'Added: on-demand local file state detection on task cards.\\n' +
             'Added: clear licence information in Settings > About.'
    },
    downloadedBytes: 0,
    totalBytes: null,
    skippedVersion: null,
    canAutoInstall: false
  });
}
`;

const SHOTS = [
  { file: 'queue.png', page: 'pages/queue/index.html', query: 'v=0.2.8&motion=reduced', init: queueInit('zh') },
  { file: 'queue-dark.png', page: 'pages/queue/index.html', query: 'v=0.2.8&motion=reduced&theme=dark&lang=en', init: queueInit('en') },
  { file: 'settings.png', page: 'pages/settings/index.html', query: 'v=0.2.8&motion=reduced', setup: SHOW_REAL_PATHS },
  { file: 'settings-licence.png', page: 'pages/settings/index.html', query: 'v=0.2.8&motion=reduced', setup: SHOW_REAL_PATHS + SHOW_LICENCE },
  { file: 'delete-dialog.png', page: 'pages/queue/index.html', query: 'v=0.2.8&motion=reduced', init: queueInit('zh'), setup: SHOW_DELETE_DIALOG },
  { file: 'task-detail.png', page: 'pages/task-detail/index.html', query: 'v=0.2.8&motion=reduced', init: detailInit,
    setup: "var out = document.getElementById('ytvdlt-output'); if (out) out.setAttribute('hidden', 'true');",
    width: 1280, height: 480 },
  { file: 'update-dialog.png', page: 'pages/queue/index.html', query: 'v=0.2.8&motion=reduced', init: queueInit('zh'), setup: SHOW_UPDATE_DIALOG },
  { file: 'social-preview.png', page: 'pages/queue/index.html', query: 'v=0.2.8&motion=reduced&theme=dark&lang=en', init: queueInit('en'), width: 1280, height: 640 },
];

function pageUrl(shot) {
  const absolute = pathToFileURL(join(UI, shot.page)).href;
  return `${absolute}?${shot.query}`;
}

/** Minimal CDP client over the Node 22 built-in WebSocket. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== undefined && pending.has(msg.id)) {
        const done = pending.get(msg.id);
        pending.delete(msg.id);
        done(msg);
      } else if (msg.method !== undefined) {
        listeners.forEach((fn) => fn(msg));
      }
    };
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((done) => {
          const id = ++seq;
          pending.set(id, done);
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { ws.close(); },
    });
    ws.onerror = (error) => reject(error);
  });
}

async function waitReady(cdp) {
  for (let i = 0; i < 30; i += 1) {
    const reply = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (reply.result?.result?.value === 'complete') return;
    await sleep(150);
  }
}

async function main() {
  mkdirSync(PROFILE, { recursive: true });
  mkdirSync(ASSETS, { recursive: true });
  const exe = resolveBrowserExecutable().path;
  const browser = spawn(exe, [
    '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--window-size=1280,800',
    '--disable-lcd-text', '--allow-file-access-from-files',
    '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  try {
    const portFile = join(PROFILE, 'DevToolsActivePort');
    for (let i = 0; i < 60 && !existsSync(portFile); i += 1) await sleep(150);
    if (!existsSync(portFile)) throw new Error('DevToolsActivePort never appeared');
    const port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const base = `http://127.0.0.1:${port}`;

    for (const shot of SHOTS) {
      const created = await fetch(`${base}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
      const cdp = await connect(created.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: shot.width ?? 1280, height: shot.height ?? 800,
        deviceScaleFactor: 1, mobile: false,
      });
      if (shot.init) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: shot.init });
      await cdp.send('Page.navigate', { url: pageUrl(shot) });
      await waitReady(cdp);
      await sleep(700);
      if (shot.setup) {
        await cdp.send('Runtime.evaluate', { expression: shot.setup, awaitPromise: true });
        await sleep(350);
      }
      const png = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      if (!png.result?.data) throw new Error(`no screenshot for ${shot.file}`);
      const buffer = Buffer.from(png.result.data, 'base64');
      writeFileSync(join(ASSETS, shot.file), buffer);
      console.log(`[shot] ${shot.file.padEnd(24)} ${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}  ${(buffer.length / 1024).toFixed(0)} KiB`);
      cdp.close();
      await fetch(`${base}/json/close/${created.id}`).catch(() => {});
    }
  } finally {
    browser.kill();
  }
  console.log(`[shot] ${SHOTS.length} images written to docs/assets/`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
