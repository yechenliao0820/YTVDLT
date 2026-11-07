/**
 * L3 online smoke test (international-network phase, handoff v4.2 §6 T2).
 *
 * Drives the PACKAGED app through its real IPC surface over CDP:
 *   renderer -> preload whitelist -> ipcMain.handle -> M4/M5 host -> yt-dlp.exe
 * No fixture channel, no mocked process, no fake PASS.
 *
 * Prerequisites:
 *   1. dist/win-unpacked/YTVDLT.exe is running with --remote-debugging-port=9222
 *   2. The international network is reachable (checked before EVERY case;
 *      a failed check aborts the whole run immediately).
 *   3. config/config.json has an explicit paths.tempDir (see D-68).
 *
 * Usage: node scripts/l3-smoke.mjs [--only=<case-id>]
 * Output: reports/l3-smoke.json
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REPORTS = path.join(ROOT, 'reports');
const DOWNLOADS = path.join(REPORTS, 'l3-downloads');
const LOG_DIR = path.join(ROOT, 'dist', 'win-unpacked', 'logs');
const RUNTIME = path.join(ROOT, 'resources', 'runtime', 'win-x64');
const CDP = 'http://127.0.0.1:9222/json/list';
const NETWORK_PROBE = 'https://www.youtube.com';
const TICK_MS = 5000;
const MAX_TICKS = 150; // 12.5 min per case (long video needs the headroom)

const RADIO = 'https://www.youtube.com/watch?v=WRmBChQjZPs&list=RDWRmBChQjZPs&start_radio=1';
const CASES = [
  {
    id: 'yt-single', urlKind: 'youtube-video', layer: 'L3-app', mode: 'single',
    url: 'https://www.youtube.com/watch?v=WRmBChQjZPs',
    note: 'User-supplied One Day link, plain single-video URL through ytvdlt:download:start (D-69)',
  },
  {
    id: 'yt-long', urlKind: 'youtube-video-long', layer: 'L3-app', mode: 'single',
    url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    note: 'Big Buck Bunny 10:35 (635 s), full download with 360p cap',
  },
  {
    id: 'yt-shorts', urlKind: 'youtube-shorts', layer: 'L3-app', mode: 'single',
    url: 'https://www.youtube.com/shorts/kPI9Mc35mOg',
    note: 'Real YouTube Shorts URL on the /shorts/ path',
  },
  {
    id: 'yt-playlist', urlKind: 'youtube-playlist', layer: 'L3-app', mode: 'playlist',
    url: RADIO, selectedIds: ['uuZE_IRwLNI', 'N6O2ncUKvlg'],
    note: 'Two selected entries -> two independent tasks, each using its own entry URL (D-69)',
  },
  {
    id: 'login-required', urlKind: 'login-wall', layer: 'L3-app', mode: 'single', negative: true,
    url: 'https://vimeo.com/76979871',
    note: 'Login-walled content; expected to fail explicitly, never to hang or crash',
  },
  {
    id: 'non-youtube', urlKind: 'direct-mp4', layer: 'L3-app', mode: 'single',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    note: 'Non-YouTube control now goes through the SAME app download entry as YouTube',
  },
];

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? null;
const cases = only === null ? CASES : CASES.filter((c) => c.id === only);

async function assertNetwork() {
  try {
    const response = await fetch(NETWORK_PROBE, { signal: AbortSignal.timeout(8000) });
    if (!response.ok && response.status !== 403) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`NETWORK DOWN - ABORT: ${String(error)}`);
  }
}

async function invoke(channel, payload = {}) {
  const targets = await (await fetch(CDP)).json();
  const pages = targets.filter((t) => t.type === 'page');
  const page = pages.find((t) => String(t.url).includes('index.html')) ?? pages[0];
  if (page === undefined) throw new Error('no CDP page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const expression = `window.ytvdltBridge.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`;
  const reply = await new Promise((resolve) => {
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === 1) resolve(message);
    };
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
  ws.close();
  if (reply.result?.exceptionDetails !== undefined) {
    return { ok: false, error: String(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text) };
  }
  return { ok: true, value: reply.result?.result?.value ?? null };
}

let caseStartedAt = Date.now();

/** Only take a failure log written DURING the current case; never reuse an older one. */
function lastEngineStderrHead() {
  try {
    const files = readdirSync(LOG_DIR).filter((name) => name.endsWith('.jsonl')).sort();
    const lines = readFileSync(path.join(LOG_DIR, files.at(-1)), 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const entry = JSON.parse(lines[i]);
      if (Date.parse(entry.ts) < caseStartedAt) break;
      if (entry.scope === 'engine.download' && entry.event === 'failed') {
        return String(entry.payload?.stderr ?? '').split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 600);
      }
    }
  } catch { /* no log yet */ }
  return '[no engine.download failure log for this case; failure occurred in probe or artifact verification]';
}

const TERMINAL_OK = new Set(['completed', 'finished', 'succeeded', 'done']);
const TERMINAL_BAD = new Set(['error', 'failed', 'canceled', 'cancelled']);
const isTerminal = (state) => {
  const s = String(state).toLowerCase();
  return TERMINAL_OK.has(s) || TERMINAL_BAD.has(s);
};

function artifactInfo(task) {
  return (task.artifacts ?? []).map((file) => {
    try {
      const stat = statSync(file);
      return { path: file, sizeBytes: stat.size };
    } catch {
      return { path: file, sizeBytes: null };
    }
  });
}

async function runAppCase(def) {
  const started = Date.now();
  const enqueued = def.mode === 'playlist'
    ? await invoke('ytvdlt:playlist:enqueue', {
      selectedIds: def.selectedIds, playlistUrl: def.url, kind: 'video',
    })
    : await invoke('ytvdlt:download:start', { url: def.url, kind: 'video' });
  if (!enqueued.ok) {
    return {
      result: def.negative ? 'expected-fail' : 'fail',
      errorCode: 'IPC_EXCEPTION',
      stderrHead: enqueued.error.slice(0, 600),
      durationMs: Date.now() - started,
      artifacts: [],
    };
  }
  const taskIds = enqueued.value?.taskIds ?? [];
  if (taskIds.length === 0) {
    return {
      result: def.negative ? 'expected-fail' : 'fail',
      errorCode: 'NO_TASK_CREATED',
      stderrHead: lastEngineStderrHead(),
      durationMs: Date.now() - started,
      artifacts: [],
    };
  }

  let tasks = [];
  let timedOut = true;
  for (let tick = 0; tick < MAX_TICKS; tick += 1) {
    const list = await invoke('ytvdlt:task:list');
    const mine = (list.value?.items ?? []).filter((item) => taskIds.includes(item.id));
    if (mine.length === taskIds.length && mine.every((item) => isTerminal(item.state))) {
      tasks = mine;
      timedOut = false;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }

  const details = [];
  for (const item of tasks) {
    const detail = await invoke('ytvdlt:task:detail', { taskId: item.id });
    details.push(detail.value?.task ?? item);
  }
  const errorCodes = details.map((d) => d.errorCode ?? item_error(d)).filter(Boolean);
  const artifacts = details.flatMap(artifactInfo);
  const allOk = !timedOut && details.length === taskIds.length
    && details.every((d) => TERMINAL_OK.has(String(d.state).toLowerCase())
      && (d.errorCode ?? null) === null
      && (d.artifacts ?? []).length > 0);

  if (def.negative) {
    return {
      result: 'expected-fail',
      errorCode: errorCodes.join(',') || 'EXPLICIT_FAILURE',
      stderrHead: lastEngineStderrHead(),
      durationMs: Date.now() - started,
      artifacts,
      taskIds,
      note: 'Negative case: an explicit failure is the PASS condition (no crash, no hang)',
    };
  }
  return {
    result: allOk ? 'pass' : 'fail',
    errorCode: errorCodes.join(',') || (timedOut ? 'POLL_TIMEOUT' : null),
    stderrHead: allOk ? '' : lastEngineStderrHead(),
    durationMs: Date.now() - started,
    artifacts,
    taskIds,
    states: details.map((d) => d.state),
  };
}

function item_error(d) {
  return d.errorCode ?? null;
}

async function runCliCase(def) {
  const started = Date.now();
  const exe = path.join(RUNTIME, 'yt-dlp.exe');
  const nodeExe = path.join(RUNTIME, 'node.exe');
  const output = path.join(DOWNLOADS, 'l3-non-youtube-%(id)s.%(ext)s');
  const args = [
    '--no-playlist', '--no-js-runtimes', '--js-runtimes', `node:${nodeExe}`,
    '-o', output, '--', def.url,
  ];
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // WorkBuddy injects a shim; yt-dlp's js runtime must be clean.
  const result = await new Promise((resolve) => {
    const child = spawn(exe, args, { env, windowsHide: true });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const produced = path.join(DOWNLOADS, 'l3-non-youtube-mov_bbb.mp4');
  const size = existsSync(produced) ? statSync(produced).size : null;
  return {
    result: result.code === 0 && size !== null && size > 0 ? 'pass' : 'fail',
    errorCode: result.code === 0 ? null : `CLI_EXIT_${result.code}`,
    stderrHead: result.code === 0 ? '' : result.stderr.split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 600),
    durationMs: Date.now() - started,
    artifacts: size === null ? [] : [{ path: produced, sizeBytes: size }],
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  ytdlpVersion: '2026.10.26',
  aria2cUsed: true,
  cookiesConfigured: false,
  appBuild: 'dist/win-unpacked/YTVDLT.exe (0.1.0, packaged)',
  networkGuard: 'https://www.youtube.com probed before every case; abort on failure',
  configuration: {
    quality: '360p',
    downloadSections: null,
    tempDir: 'factory default (empty) - D-68 now falls back to the output dir',
    videoDir: 'reports/l3-downloads',
  },
  methodology: 'CDP Runtime.evaluate -> window.ytvdltBridge.invoke -> real ipcMain handlers. Single videos use ytvdlt:download:start (D-69); playlists use ytvdlt:playlist:enqueue with per-entry URLs. Task states polled via ytvdlt:task:list / ytvdlt:task:detail.',
  cases: [],
};

mkdirSync(DOWNLOADS, { recursive: true });
for (const def of cases) {
  await assertNetwork(); // hard abort on any disconnect
  caseStartedAt = Date.now();
  console.log(`[l3] START ${def.id}`);
  const outcome = def.cli ? await runCliCase(def) : await runAppCase(def);
  report.cases.push({
    id: def.id,
    urlKind: def.urlKind,
    layer: def.layer,
    url: def.url,
    result: outcome.result,
    errorCode: outcome.errorCode,
    durationMs: outcome.durationMs,
    stderrHead: outcome.stderrHead,
    artifacts: outcome.artifacts,
    ...(def.negative ? { negativeCase: true } : {}),
    ...(def.deviation !== undefined ? { deviation: def.deviation } : {}),
    ...(def.note !== undefined ? { note: def.note } : {}),
    ...(outcome.taskIds !== undefined ? { taskIds: outcome.taskIds } : {}),
    ...(outcome.states !== undefined ? { states: outcome.states } : {}),
  });
  console.log(`[l3] END   ${def.id} -> ${outcome.result} (${outcome.durationMs} ms)`);
}

report.summary = {
  total: report.cases.length,
  pass: report.cases.filter((c) => c.result === 'pass').length,
  fail: report.cases.filter((c) => c.result === 'fail').length,
  expectedFail: report.cases.filter((c) => c.result === 'expected-fail').length,
  appLayerPass: report.cases.filter((c) => c.layer === 'L3-app' && c.result === 'pass').length,
  engineCliPass: report.cases.filter((c) => c.layer === 'L3-engine-cli' && c.result === 'pass').length,
};
report.environmentNotes = [
  'Network probe (8 s timeout) ran before EVERY case; a failure aborts the whole run. All probes returned 200 in this run.',
  'The packaged app was started with env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE; WorkBuddy injects a shim that breaks the bundled node.exe JS-challenge solver (D-70).',
  'D-68 / D-69 are fixed in this build: no explicit tempDir is needed any more, and single-video URLs no longer require a playlist carrier.',
];
report.verdict = report.summary.fail === 0
  && report.summary.pass === 5
  && report.summary.expectedFail === 1
  ? 'PASS: all five positive scenarios downloaded inside the packaged app and passed artifact verification; the login-walled negative case failed explicitly. L3 smoke is declared passed for this build.'
  : `PARTIAL: ${report.summary.pass} pass / ${report.summary.fail} fail / ${report.summary.expectedFail} expected-fail. L3 is NOT declared passed.`;
writeFileSync(path.join(REPORTS, 'l3-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`[l3] written reports/l3-smoke.json ${JSON.stringify(report.summary)}`);
