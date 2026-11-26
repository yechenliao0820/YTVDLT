/**
 * D-287 · bundled "what's new" for RELEASED versions.
 *
 * Why a bundled file instead of the GitHub release body:
 *  - the settings page is a sandboxed `file://` document — it has no fs, and a
 *    `fetch()` of a local JSON is not reliable under the page CSP;
 *  - the release body is English-only, while this page speaks both languages;
 *  - the GitHub API is N3 (international) — the notes must be readable offline,
 *    exactly like the version string.
 *
 * The text is the SAME user-facing summary that the in-app update dialog showed
 * when this version was offered, so "what changed in my version" stays
 * available after the install instead of only on GitHub.
 *
 * Maintenance: append one entry per release, newest first, at the same time the
 * GitHub release body is written. `version` is the plain semver (no leading v).
 */
(function () {
  'use strict';

  var NOTES = [
    {
      version: '0.3.3',
      date: '2026-11-26',
      zh: [
        '本版是 0.3.2 之后两批在线审计的收尾，没有新增功能面。',
        '',
        '你会看到的变化',
        '· 分类下载落到真实目录：开启「按站点 / 按播放列表分目录」后，文件进入 <输出>/<站点>/<播放列表>/，不再生成字面量 %(extractor_key)s 目录。',
        '· 界面反馈恢复：队列状态行、删除确认里的「同时删除本地文件」复选框与说明、设置页「打开发布页」、日志页正文、批量任务行列表重新可见。',
        '· 损坏的 tasks.json 不再拖垮启动：恢复、入队、重试、删除照常；队列槽位始终补位。',
        '· 下载目录配置残留 %变量% 时当场拒绝并说明原因，不再写入字面量目录。',
        '',
        '可靠性与隐私',
        '· 无痕模式：开关经主进程确认后才建任务；无痕任务不写入 tasks.json；封面回收按删除时刻复核。',
        '· 配置、命令模板、历史导入改为先落盘后提交 + 逐元素校验；缩略图索引损坏先做字节备份。',
        '· 封面只走 https；带凭据的更新代理被拒绝。',
        '· 退出：第二次退出不再截断 5 秒清理预算；Alt+F4 / 关闭窗口回到队列。',
        '· yt-dlp 每次启动都带 --ignore-config --no-plugin-dirs。',
        '',
        '验证：typecheck 5/5；单测 3,078 过；E2E 31/31 + 反例 5/5；M5 验收 10/10 门；覆盖率 86.93%。'
      ].join('\n'),
      en: [
        'This release closes out two rounds of online audit work on top of 0.3.2. No new features.',
        '',
        'What changes for you',
        '· Categorized downloads land in real folders: with "subfolder by site / playlist" enabled, files go to <output>/<Extractor>/<Playlist>/ instead of a literal %(extractor_key)s directory.',
        '· Restored UI feedback: the queue status line, the "also delete local files" checkbox and its explanation in the delete dialog, the "Open release page" button in Settings, the task-log body and the batch row list are visible again.',
        '· A damaged tasks.json no longer bricks the app: restore, enqueue, retry and delete keep working, and the queue always refills a freed slot.',
        '· A configured download folder that still contains an unresolved %VARIABLE% is refused up front with a clear message.',
        '',
        'Reliability and privacy',
        '· Private mode: the switch is confirmed by the main process before any task is created; private tasks are never written to tasks.json; cover purge re-checks references at delete time.',
        '· Config, command templates and history import use persist-first / commit-after with per-element validation; a corrupt thumbnail index is backed up byte-for-byte before recovery.',
        '· Cover images only over HTTPS; update proxies carrying embedded credentials are rejected.',
        '· Quit path: a second quit request can no longer cut the 5 s cleanup budget; Alt+F4 and window close return to the queue.',
        '· yt-dlp isolation: every spawn uses --ignore-config --no-plugin-dirs.',
        '',
        'Verification: typecheck 5/5; 3,078 unit tests passed; E2E 31/31 + 5/5 negative checks; M5 acceptance 10/10 gates; coverage 86.93%.'
      ].join('\n'),
    },
  ];

  function normalize(value) {
    return String(value === null || value === undefined ? '' : value)
      .trim()
      .replace(/^v/i, '');
  }

  function forVersion(version) {
    var wanted = normalize(version);
    if (wanted === '') return null;
    for (var i = 0; i < NOTES.length; i += 1) {
      if (NOTES[i].version === wanted) return NOTES[i];
    }
    return null;
  }

  globalThis.YTVDLTReleaseNotes = {
    forVersion: forVersion,
    versions: function () { return NOTES.map(function (entry) { return entry.version; }); },
  };
})();
