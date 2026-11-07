#!/usr/bin/env node
/**
 * e2e-cases.mjs — three-dialog scenario table (F027).
 *
 * Each case maps a scenario to: a static HTML page, a URL query string that
 * selects state/mode, the L1 recorded fixture, the expected DOM assertions
 * (main criterion ①), the screenshot/DOM baseline names, and the M3 assertion
 * IDs it discharges. Scenarios never hard-code media data: every format id,
 * subtitle language and playlist entry comes from `tests/e2e/fixtures/*.json`,
 * which are `omitUrl()`-derived from the M1 recorded fixtures.
 */
import { join } from 'node:path';

export const FIXTURES = {
  media: 'dialog-media.json',
  playlist: 'dialog-playlist.json',
  empty: 'dialog-media-empty.json',
};

/** Every case produces one PNG baseline + one `*.dom.html` DOM snapshot. */
export const E2E_CASES = [
  // ---- FormatSelectorDialog (PRD §5.1) ----
  {
    id: 'format-ready',
    dialog: 'format-selector.html',
    fixture: FIXTURES.media,
    query: 'case=format-ready&autoconfirm=1',
    state: 'ready',
    assertionIds: ['A-M3-01', 'A-M3-02', 'A-4.2-04', 'A-M3-06'],
    checks: [
      { name: 'three-groups', pattern: 'id="col-video-only"' },
      { name: 'three-groups-audio', pattern: 'id="col-audio-only"' },
      { name: 'three-groups-merged', pattern: 'id="col-merged"' },
      { name: 'video-137', pattern: 'data-format-id="137"' },
      { name: 'audio-251', pattern: 'data-format-id="251"' },
      { name: 'recommended-preselected', pattern: 'data-selected="true"' },
      { name: 'total-bytes-not-dash', pattern: 'data-total-bytes="[0-9]' },
      { name: 'writeback-formatId', pattern: '"formatId": "137\\+251"' },
      { name: 'writeback-five-domains', pattern: '"requestPatch"' },
      { name: 'confirm-enabled', pattern: 'data-confirm="enabled"' },
      { name: 'confirmed', pattern: 'data-confirmed="true"' },
    ],
  },
  {
    id: 'format-empty',
    dialog: 'format-selector.html',
    fixture: FIXTURES.empty,
    query: 'case=format-empty&empty=1',
    state: 'empty',
    assertionIds: ['A-M3-05', 'A-4.5-04'],
    checks: [
      { name: 'empty-state', pattern: 'data-state="empty"' },
      { name: 'empty-banner', pattern: '没有可用格式' },
      { name: 'confirm-disabled', pattern: 'aria-disabled="true"' },
      { name: 'no-items', pattern: 'data-visible-count="0"' },
    ],
  },
  {
    id: 'format-disabled',
    dialog: 'format-selector.html',
    fixture: FIXTURES.media,
    query: 'case=format-disabled&mode=command',
    state: 'disabled',
    assertionIds: ['A-M3-05', 'A-4.1-07'],
    checks: [
      { name: 'disabled-state', pattern: 'data-state="disabled"' },
      { name: 'command-explanation', pattern: 'Command 模式' },
      { name: 'group-disabled', pattern: 'data-disabled="true"' },
      { name: 'confirm-disabled', pattern: 'aria-disabled="true"' },
    ],
  },
  {
    id: 'format-error',
    dialog: 'format-selector.html',
    fixture: FIXTURES.media,
    query: 'case=format-error&error=1',
    state: 'error',
    assertionIds: ['A-M3-05', 'A-4.5-02'],
    checks: [
      { name: 'error-state', pattern: 'data-state="error"' },
      { name: 'retry-visible', pattern: 'id="ytvdlt-retry" hidden="false"' },
      { name: 'confirm-disabled', pattern: 'aria-disabled="true"' },
    ],
  },
  {
    id: 'format-mp3',
    dialog: 'format-selector.html',
    fixture: FIXTURES.media,
    query: 'case=format-mp3&mp3=1',
    state: 'ready',
    assertionIds: ['A-4.2-09', 'A-4.2-07'],
    checks: [
      { name: 'audio-quality-greyed', pattern: 'id="label-audio-quality"[^>]*data-disabled="true"' },
      { name: 'r1-warning', pattern: 'R1：转码 MP3' },
    ],
  },
  {
    id: 'format-badid',
    dialog: 'format-selector.html',
    fixture: FIXTURES.media,
    query: 'case=format-badid&badid=1',
    state: 'ready',
    assertionIds: ['A-4.5-04', 'A-M3-05'],
    checks: [
      { name: 'format-unavailable', pattern: 'FORMAT_UNAVAILABLE' },
      { name: 'inline-error-visible', pattern: 'id="ytvdlt-inline-error" data-visible="true"' },
      { name: 'confirm-disabled', pattern: 'aria-disabled="true"' },
    ],
  },

  // ---- SubtitleSelectorDialog (PRD §5.2) ----
  {
    id: 'subtitle-ready',
    dialog: 'subtitle-selector.html',
    fixture: FIXTURES.media,
    query: 'case=subtitle-ready&autoconfirm=1',
    state: 'ready',
    assertionIds: ['A-M3-03', 'A-4.3-08', 'A-4.3-02', 'A-M3-06'],
    checks: [
      { name: 'three-groups-suggested', pattern: 'id="col-suggested"' },
      { name: 'three-groups-other', pattern: 'id="col-other"' },
      { name: 'three-groups-automatic', pattern: 'id="col-automatic"' },
      { name: 'language-multiselect', pattern: 'data-language="en"' },
      { name: 'selected-count', pattern: 'data-selected-count="[1-9]' },
      { name: 'convert-five-options', pattern: '<option value="lrc">lrc</option>' },
      { name: 'expression-valid', pattern: 'data-expression-valid="true"' },
      { name: 'writeback-subtitle', pattern: '"kind": "subtitle"' },
      { name: 'writeback-enabled', pattern: '"enabled": true' },
    ],
  },
  {
    id: 'subtitle-empty',
    dialog: 'subtitle-selector.html',
    fixture: FIXTURES.empty,
    query: 'case=subtitle-empty&empty=1&autoconfirm=1',
    state: 'empty',
    assertionIds: ['A-M3-05', 'A-4.3-02'],
    checks: [
      { name: 'empty-state', pattern: 'data-state="empty"' },
      { name: 'empty-hint', pattern: '没有字幕语言' },
      { name: 'manual-expression-confirm', pattern: 'data-confirm="enabled"' },
      { name: 'expression-valid', pattern: 'data-expression-valid="true"' },
    ],
  },
  {
    id: 'subtitle-audio-mode',
    dialog: 'subtitle-selector.html',
    fixture: FIXTURES.media,
    query: 'case=subtitle-audio-mode&mode=audio',
    state: 'ready',
    assertionIds: ['A-M3-05', 'A-4.3-06'],
    checks: [
      { name: 'audio-mode', pattern: 'data-mode="audio"' },
      { name: 'embed-disabled', pattern: 'id="label-embed"[^>]*data-disabled="true"' },
      { name: 'keep-disabled', pattern: 'id="label-keep"[^>]*data-disabled="true"' },
      { name: 'audio-reason', pattern: '仅音频模式不可嵌入' },
    ],
  },
  {
    id: 'subtitle-invalid-expression',
    dialog: 'subtitle-selector.html',
    fixture: FIXTURES.media,
    query: 'case=subtitle-invalid-expression&expr=en%20bad',
    state: 'ready',
    assertionIds: ['A-M3-05', 'A-4.3-02'],
    checks: [
      { name: 'expression-invalid', pattern: 'data-expression-valid="false"' },
      { name: 'inline-error-visible', pattern: 'id="ytvdlt-inline-error" data-visible="true"' },
      { name: 'confirm-disabled', pattern: 'aria-disabled="true"' },
    ],
  },
  {
    id: 'subtitle-disabled',
    dialog: 'subtitle-selector.html',
    fixture: FIXTURES.media,
    query: 'case=subtitle-disabled&enabled=0',
    state: 'disabled',
    assertionIds: ['A-M3-05', 'A-4.3-01'],
    checks: [
      { name: 'disabled-state', pattern: 'data-state="disabled"' },
      { name: 'all-controls-disabled', pattern: 'id="label-auto"[^>]*data-disabled="true"' },
      { name: 'confirm-disabled', pattern: 'aria-disabled="true"' },
    ],
  },

  // ---- PlaylistSelectorDialog (PRD §5.3) ----
  {
    id: 'playlist-ready',
    dialog: 'playlist-selector.html',
    fixture: FIXTURES.playlist,
    query: 'case=playlist-ready&autoconfirm=1',
    state: 'ready',
    assertionIds: ['A-M3-04', 'A-4.1-05', 'A-4.4-03', 'A-M3-06'],
    checks: [
      { name: 'three-entries', pattern: 'data-entry-id="a3"' },
      { name: 'select-all', pattern: 'id="ctl-select-all"' },
      { name: 'select-none', pattern: 'id="ctl-select-none"' },
      { name: 'selected-count', pattern: 'data-selected-count="3"' },
      { name: 'total-duration', pattern: 'data-total-duration="5:00"' },
      { name: 'path-preview', pattern: 'data-path-preview="[^"]*Recorded Flat Playlist' },
      { name: 'save-selection-label', pattern: '保存选择' },
      { name: 'never-enqueue', pattern: 'data-enqueue-batch="never"' },
      { name: 'writeback-selected-ids', pattern: '"selectedPlaylistIds"' },
      { name: 'no-request-patch', pattern: /"requestPatch"\s*:/, absent: true },
    ],
  },
  {
    id: 'playlist-empty',
    dialog: 'playlist-selector.html',
    fixture: FIXTURES.empty,
    query: 'case=playlist-empty&empty=1',
    state: 'empty',
    assertionIds: ['A-M3-05', 'A-4.1-05'],
    checks: [
      { name: 'empty-state', pattern: 'data-state="empty"' },
      { name: 'empty-hint', pattern: 'entries=\\[\\]' },
      { name: 'confirm-disabled', pattern: 'aria-disabled="true"' },
    ],
  },
  {
    id: 'playlist-error',
    dialog: 'playlist-selector.html',
    fixture: FIXTURES.playlist,
    query: 'case=playlist-error&error=1',
    state: 'error',
    assertionIds: ['A-M3-05', 'A-4.5-02'],
    checks: [
      { name: 'error-state', pattern: 'data-state="error"' },
      { name: 'retry-visible', pattern: 'id="ytvdlt-retry" hidden="false"' },
      { name: 'confirm-disabled', pattern: 'aria-disabled="true"' },
    ],
  },

  // ---- M5-1/M5-2: theme + language on a frozen M3 dialog (A-4.4-20 / A-4.4-21) ----
  {
    id: 'format-dark',
    dialog: 'format-selector.html',
    fixture: FIXTURES.media,
    query: 'case=format-dark&theme=dark&accent=teal&autoconfirm=1',
    state: 'ready',
    assertionIds: ['A-4.4-20', 'A-4.6-06'],
    checks: [
      { name: 'dark-theme', pattern: 'data-theme="dark"' },
      { name: 'dark-accent', pattern: 'data-accent="teal"' },
      { name: 'confirm-enabled', pattern: 'data-confirm="enabled"' },
      { name: 'writeback-formatId', pattern: '"formatId": "137\\+251"' },
    ],
  },
  {
    id: 'format-en',
    dialog: 'format-selector.html',
    fixture: FIXTURES.media,
    query: 'case=format-en&lang=en&autoconfirm=1',
    state: 'ready',
    assertionIds: ['A-4.4-21'],
    checks: [
      { name: 'lang-en', pattern: 'lang="en"' },
      { name: 'data-lang-en', pattern: 'data-lang="en"' },
      { name: 'translated-heading', pattern: 'Format selection' },
      { name: 'translated-confirm', pattern: 'Confirm selection' },
      { name: 'no-missing-keys', pattern: 'data-i18n-missing="0"' },
      { name: 'no-overflow', pattern: 'data-text-overflow="0"' },
    ],
  },

  // ---- M5-0/M5-3: the queue page (A-4.4-16, A-4.1-02) ----
  {
    id: 'queue-ready',
    page: 'pages/queue/index.html',
    query: 'case=queue-ready',
    state: 'ready',
    assertionIds: ['A-4.4-16'],
    checks: [
      { name: 'six-cards', pattern: 'data-task-id="t-error-6"' },
      { name: 'ready-state', pattern: 'id="queue-root"[^>]*data-state="ready"' },
      { name: 'visible-count', pattern: 'data-visible-count="6"' },
      { name: 'total-count', pattern: 'data-total-count="6"' },
      { name: 'concurrency', pattern: 'data-concurrency="2/3"' },
      { name: 'tab-all-selected', pattern: 'data-tab="all" aria-selected="true"' },
      { name: 'tab-downloading-count', pattern: 'data-count="3"' },
      { name: 'tab-finished-count', pattern: 'data-count="1"' },
      { name: 'tab-canceled-count', pattern: 'data-count="2"' },
      { name: 'no-media-url', pattern: '"url"\\s*:', absent: true },
    ],
  },
  {
    id: 'queue-empty',
    page: 'pages/queue/index.html',
    query: 'case=queue-empty&empty=1',
    state: 'empty',
    assertionIds: ['A-4.4-16'],
    checks: [
      { name: 'empty-state', pattern: 'id="queue-root"[^>]*data-state="empty"' },
      { name: 'empty-visible', pattern: 'id="queue-empty" data-variant="empty" hidden="false"' },
      { name: 'empty-guide', pattern: '还没有任务' },
      { name: 'empty-cta', pattern: 'id="queue-empty-cta"' },
      { name: 'zero-count', pattern: 'data-visible-count="0"' },
      { name: 'cards-hidden', pattern: 'id="queue-cards" hidden="true"' },
    ],
  },
  {
    id: 'queue-error',
    page: 'pages/queue/index.html',
    query: 'case=queue-error&error=1',
    state: 'error',
    assertionIds: ['A-4.4-16'],
    checks: [
      { name: 'error-state', pattern: 'id="queue-root"[^>]*data-state="error"' },
      { name: 'error-visible', pattern: 'id="queue-error" data-variant="error" hidden="false"' },
      { name: 'error-copy', pattern: '队列读取失败' },
      { name: 'error-retry', pattern: 'id="queue-retry"' },
    ],
  },
  {
    id: 'queue-en',
    page: 'pages/queue/index.html',
    query: 'case=queue-en&lang=en',
    state: 'ready',
    assertionIds: ['A-4.4-21'],
    checks: [
      { name: 'lang-en', pattern: 'data-lang="en"' },
      { name: 'translated-title', pattern: 'Download queue' },
      { name: 'translated-tab', pattern: '>Downloading<' },
      { name: 'translated-empty-cta', pattern: 'Paste a link to start' },
      { name: 'no-overflow', pattern: 'data-text-overflow="0"' },
      { name: 'no-missing-keys', pattern: 'data-i18n-missing="0"' },
    ],
  },
  {
    id: 'queue-dark',
    page: 'pages/queue/index.html',
    query: 'case=queue-dark&theme=dark&accent=violet',
    state: 'ready',
    assertionIds: ['A-4.4-20', 'A-4.6-06'],
    checks: [
      { name: 'dark-theme', pattern: 'data-theme="dark"' },
      { name: 'dark-accent', pattern: 'data-accent="violet"' },
      { name: 'cards-rendered', pattern: 'data-task-id="t-run-1"' },
    ],
  },
  {
    id: 'queue-prefill',
    page: 'pages/queue/index.html',
    query: 'case=queue-prefill&focus=0&prefill=https%3A%2F%2Fexample.org%2Fv%3Fid%3D1',
    state: 'ready',
    assertionIds: ['A-4.1-02'],
    checks: [
      { name: 'prefilled-marker', pattern: 'data-prefilled="true"' },
      { name: 'prefill-host-only', pattern: 'data-prefill-host="example.org"' },
      { name: 'input-prefilled', pattern: 'id="queue-url"' },
      // The signed link must never be mirrored into the DOM (only its host is).
      { name: 'no-url-in-dom', pattern: 'https://example\\.org/v', absent: true },
    ],
  },

  // ---- M5 settings page (theme + accent + language live switching) ----
  {
    id: 'settings-appearance',
    page: 'pages/settings/index.html',
    query: 'case=settings-appearance',
    state: 'ready',
    assertionIds: ['A-4.4-20', 'A-4.6-07'],
    checks: [
      { name: 'three-themes', pattern: 'data-theme="system" aria-pressed="true"' },
      { name: 'accent-system', pattern: 'data-accent="system" aria-pressed="true"' },
      { name: 'motion-select', pattern: 'id="settings-motion"' },
      { name: 'autostart-optional', pattern: 'id="settings-autostart"' },
      { name: 'license-notice', pattern: 'LGPL-3.0' },
      { name: 'haptics-omitted', pattern: '触觉反馈' },
    ],
  },
  {
    id: 'settings-en-dark',
    page: 'pages/settings/index.html',
    query: 'case=settings-en-dark&lang=en&theme=dark&accent=teal',
    state: 'ready',
    assertionIds: ['A-4.4-20', 'A-4.4-21', 'A-4.6-06'],
    checks: [
      { name: 'dark-theme', pattern: 'data-theme="dark"' },
      { name: 'dark-accent', pattern: 'data-accent="teal"' },
      { name: 'lang-en', pattern: 'data-lang="en"' },
      { name: 'translated-title', pattern: '>Settings<' },
      { name: 'no-overflow', pattern: 'data-text-overflow="0"' },
      { name: 'no-missing-keys', pattern: 'data-i18n-missing="0"' },
    ],
  },

  // ---- M5-3: the three M4 pages now share one empty/error language ----
  {
    id: 'batch-ready',
    page: 'pages/queue/playlist-batch.html',
    query: 'case=batch-ready&selected=a1,a2,a3',
    state: 'ready',
    assertionIds: ['A-4.4-16'],
    checks: [
      { name: 'three-rows', pattern: 'data-playlist-items="3"' },
      { name: 'ready-state', pattern: 'id="ytvdlt-batch"[^>]*data-state="ready"' },
      { name: 'confirm-enabled', pattern: 'data-confirm="enabled"' },
      { name: 'never-auto-start', pattern: 'data-enqueue-batch="on-confirm"' },
      { name: 'empty-hidden', pattern: 'id="batch-empty" data-variant="empty" hidden="true"' },
    ],
  },
  {
    id: 'batch-empty',
    page: 'pages/queue/playlist-batch.html',
    query: 'case=batch-empty&selected=zzz',
    state: 'empty',
    assertionIds: ['A-4.4-16'],
    checks: [
      { name: 'empty-state', pattern: 'id="ytvdlt-batch"[^>]*data-state="empty"' },
      { name: 'empty-visible', pattern: 'id="batch-empty" data-variant="empty" hidden="false"' },
      { name: 'confirm-disabled', pattern: 'data-confirm="disabled"' },
    ],
  },
  {
    id: 'detail-error',
    page: 'pages/task-detail/index.html',
    query: 'case=detail-error',
    state: 'error',
    assertionIds: ['A-4.4-16'],
    checks: [
      { name: 'error-state', pattern: 'id="ytvdlt-task-detail"[^>]*data-state="error"' },
      { name: 'seven-actions', pattern: 'data-action="copy-error-report"' },
      { name: 'error-code', pattern: 'HTTP_403' },
      { name: 'empty-hidden', pattern: 'id="detail-empty" data-variant="empty" hidden="true"' },
    ],
  },
  {
    id: 'detail-empty',
    page: 'pages/task-detail/index.html',
    query: 'case=detail-empty&empty=1',
    state: 'empty',
    assertionIds: ['A-4.4-16'],
    checks: [
      { name: 'empty-state', pattern: 'id="ytvdlt-task-detail"[^>]*data-state="empty"' },
      { name: 'empty-visible', pattern: 'id="detail-empty" data-variant="empty" hidden="false"' },
      { name: 'body-hidden', pattern: 'id="detail-body" hidden="true"' },
      { name: 'actions-hidden', pattern: 'id="detail-actions"[^>]*hidden="true"' },
    ],
  },
  {
    id: 'log-ready',
    page: 'pages/task-log/index.html',
    query: 'case=log-ready',
    state: 'ready',
    assertionIds: ['A-4.4-16'],
    checks: [
      { name: 'state-running', pattern: 'id="ytvdlt-task-log"[^>]*data-state="running"' },
      { name: 'lines', pattern: 'data-line-count="4"' },
      { name: 'empty-hidden', pattern: 'id="log-empty" data-variant="empty" hidden="true"' },
    ],
  },
  {
    id: 'log-error',
    page: 'pages/task-log/index.html',
    query: 'case=log-error&error=1',
    state: 'error',
    assertionIds: ['A-4.4-16'],
    checks: [
      { name: 'error-state', pattern: 'id="ytvdlt-task-log"[^>]*data-state="error"' },
      { name: 'error-visible', pattern: 'id="log-error" data-variant="error" hidden="false"' },
      { name: 'lines-hidden', pattern: 'id="log-lines"[^>]*hidden="true"' },
    ],
  },
];

/** Absolute path of a dialog HTML page. */
export function dialogPath(root, dialog) {
  return join(root, 'packages', 'ui', 'src', 'dialogs', dialog);
}

/** Absolute path of any UI page (`page` is relative to packages/ui/src). */
export function pagePath(root, page) {
  return join(root, 'packages', 'ui', 'src', ...page.split('/'));
}

/** Baseline file names for a case. */
export function baselineNames(caseId) {
  return { png: `${caseId}.png`, dom: `${caseId}.dom.html` };
}

/** Fixed browser flags: deterministic 1280x800 @ DPR1, CSS uses a fixed font stack. */
export const RENDER_FLAGS = [
  '--headless',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1280,800',
  '--disable-lcd-text',
  '--virtual-time-budget=2000',
  '--allow-file-access-from-files',
];

export const RENDER_METADATA = {
  windowSize: '1280x800',
  deviceScaleFactor: 1,
  fontStack: 'Arial, Helvetica, Liberation Sans, sans-serif (fixed in packages/ui/src/styles/ytvdlt.css)',
  disableLcdText: true,
  virtualTimeBudgetMs: 2000,
};
