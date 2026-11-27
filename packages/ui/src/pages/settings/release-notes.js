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
      version: '0.3.4',
      date: '2026-11-26',
      zh: [
        '本版全部是修复，没有新增下载功能。',
        '',
        '更新与安装',
        '· 应用内点「安装」改为「先退出、后安装」：不再弹「YTVDLT 正在运行 / 无法关闭」，也不会出现点了确定、安装包自己消失的情况。',
        '· 取消更新包下载不再显示「临时文件清理失败」；取消会直接释放暂存文件占用的磁盘空间。',
        '· 新增「安装完成后自动清理安装包」开关（设置 → 应用本体，默认开启）；关闭后安装包保留，重新打开开关会在下次启动清理。',
        '· 修复安装包清理标记：此前文件名规则只认 0.2.x 的旧命名，标记从未写出、清理实际未生效；现在按真实资产名记录与核对，并新增「本版更新内容」面板。',
        '· 安装包只有在后台等待器确认就绪后才退出应用；确认不到就退回直接打开安装包，不再出现「应用退了、安装器没起」。',
        '',
        '下载',
        '· 修复「只开按播放列表分类、不开按站点分类」时单视频文件落到盘符根目录（如 C:////）并导致任务报错的缺陷。',
        '· 删除任务记录时一并清理该任务的临时中间文件；无痕任务的临时文件改放私有目录。启动时只清空目录，带续传数据的目录保留。',
        '',
        '队列',
        '· 产物在已断开的网络盘或休眠外置盘时，队列页不再长时间转圈：单次文件检查最多等 1.2 秒，按「无法访问」显示。',
        '',
        '封面',
        '· 系统代理 / TUN / Fake-IP 环境下，YouTube 等境外站点封面能正常显示：直连被 Fake-IP 拒绝时自动改用 Chromium 网络栈重试（仍需 https 且通过公网校验）。',
        '· 封面抓取失败后 5 分钟内不再重复请求，日志不再刷屏。',
        '',
        '验证：typecheck 5/5；单测 3,073 过 / 6 跳过；契约 53/53；离线集成 42/42；E2E 31/31 + 反例 5/5。'
      ].join('\n'),
      en: [
        'A fixes-only release. No new download features.',
        '',
        'Update and install',
        '· In-app install now quits first and installs after: no more "is running / cannot be closed" prompts, and no more "clicked OK and the installer vanished".',
        '· Cancelling an update download no longer reports a cleanup failure, and it frees the staged file immediately.',
        '· New "Delete the installer after updating" switch (Settings → App update, on by default). Turn it off to keep the package; re-enable it and the next launch cleans up.',
        '· The cleanup marker now accepts the real asset name. The old rule only matched the 0.2.x naming, so nothing was ever recorded and cleanup never ran.',
        '· The app only quits once the background waiter confirms the installer is armed; otherwise it falls back to opening the package directly, so an update can no longer vanish.',
        '',
        'Downloads',
        '· Fixed single videos landing in the DRIVE ROOT (e.g. C:////) when only "group by playlist" was on, which also failed the task.',
        '· Removing a task now discards its temporary partial files; private-mode partials live under the private directory. The boot sweep only removes EMPTY folders, so resumable data is kept.',
        '',
        'Queue',
        '· The queue page no longer hangs while a recorded file sits on a disconnected network share or a sleeping drive: each file check is capped at 1.2 s and shown as "unavailable".',
        '',
        'Covers',
        '· YouTube covers now load behind a system proxy / TUN / Fake-IP: when the pinned fetch is refused for a fake-IP, the same https URL is retried through Chromium\'s network stack.',
        '· A failed cover fetch is not retried for 5 minutes, so the log no longer floods while a task runs.',
        '',
        'Also in this release: Settings → App update → "What\'s new in this version", readable any time, offline, in both languages.',
        '',
        'Verification: typecheck 5/5; 3,073 unit tests passed (6 skipped); 53/53 contract; 42/42 offline integration; E2E 31/31 + 5/5 negative checks.'
      ].join('\n'),
    },
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
