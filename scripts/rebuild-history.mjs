#!/usr/bin/env node
/**
 * rebuild-history.mjs — 用文件真实修改时间 + 文档记录，重建一条分段历史。
 *
 * 前提：原始 .git 已在事故中永久丢失（无远端、未进回收站），哈希与 blob 不可能还原。
 * 本脚本只做一件事：把现有文件按 mtime 归入 6 个开发阶段，逐段提交，
 * 让 `git log` 能反映真实的时间线与里程碑，而不是一个巨大的"全量快照"。
 *
 * 安全性：全程 `git rm --cached` 只清索引，不动工作区文件；在新分支 `history` 上操作。
 *
 *   node scripts/rebuild-history.mjs
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const git = (args, env) =>
  execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...env } }).trim();

const STAGES = [
  {
    until: '2026-11-05T23:59:59',
    at: '2026-11-05T10:30:00',
    subject: 'feat(m1-m3): 类型契约、核心域与三对话框 UI',
    body: '按 M1 契约先行的约定落下 shared/core/engine 骨架，M3 完成 probe / 格式 / 路径三个对话框（零依赖静态页 + 截图基线）。\n（重构提交：原始 blob 与哈希不可恢复，内容取自工作区现存文件）',
  },
  {
    until: '2026-11-06T11:59:59',
    at: '2026-11-06T09:40:00',
    subject: 'feat(m4): 任务队列、yt-dlp 引擎适配与产物校验',
    body: '队列 FIFO / 并发 / 状态机 13 条合法迁移；engine-ytdlp 的 argv 构造与进度解析；C1–C12 产物校验。\n（重构提交）',
  },
  {
    until: '2026-11-06T17:59:59',
    at: '2026-11-06T15:20:00',
    subject: 'feat(m5-0..m5-3): 打包链、任务面与详情页',
    body: 'esbuild 打包主进程 + preload；托盘、单实例、数据目录探针；队列页与详情页静态面。\n（重构提交）',
  },
  {
    until: '2026-11-06T23:59:59',
    at: '2026-11-06T21:10:00',
    subject: 'feat(d-61..d-67): 打包门控、引擎自更新、非商业许可与组件更新',
    body: 'frozen 门控 + 便携数据目录；electron-updater 与应用更新协调器；yt-dlp/aria2c 独立更新；自定义许可与合规文档。\n（重构提交）',
  },
  {
    until: '2026-11-07T11:59:59',
    at: '2026-11-07T09:30:00',
    subject: 'test(l3,t4): 六场景在线烟测与自更新端到端',
    body: 'L3 六场景（单视频 / 播放列表 / 非 YouTube / 失败重试）；T4 v1→v2 自更新实测；D-72/D-73 修复。\n（重构提交）',
  },
  {
    until: '2026-11-07T23:59:59',
    at: '2026-11-07T20:40:00',
    subject: 'fix(ui,core): 按钮直连、详情返回、%USERPROFILE% 展开（D-76..D-81）',
    body: '队列页与详情页接真实 IPC；通道名映射；点击直连；详情页返回；路径环境变量展开；维护手册与交付报告。\n（重构提交）',
  },
];

const HEAD_BRANCH = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (HEAD_BRANCH !== 'main' && HEAD_BRANCH !== 'master') {
  console.error(`[rebuild] 请在 main/master 上运行，当前为 ${HEAD_BRANCH}`);
  process.exit(2);
}
const baseBranch = HEAD_BRANCH;

const tracked = git(['ls-files']).split('\n').filter(Boolean);
const buckets = new Map(STAGES.map((s) => [s.subject, []]));
const leftovers = [];

for (const file of tracked) {
  const mtime = statSync(file).mtime.toISOString().slice(0, 19);
  const stage = STAGES.find((s) => mtime <= s.until);
  if (stage) buckets.get(stage.subject).push(file);
  else leftovers.push(file);
}

console.log(`[rebuild] 已跟踪文件 ${tracked.length} 个；按阶段归入：`);
for (const stage of STAGES) console.log(`  ${stage.at.slice(0, 10)}  ${buckets.get(stage.subject).length.toString().padStart(3)}  ${stage.subject}`);

git(['checkout', '--orphan', 'history']);
git(['rm', '-r', '--cached', '.']);

let commitCount = 0;
for (const stage of STAGES) {
  const files = buckets.get(stage.subject);
  if (files.length === 0) continue;
  execFileSync('git', ['add', '--pathspec-from-file=-'], {
    input: files.join('\n'),
    env: { ...process.env, GIT_AUTHOR_DATE: stage.at, GIT_COMMITTER_DATE: stage.at },
  });
  execFileSync('git', ['commit', '-m', stage.subject, '-m', stage.body], {
    env: { ...process.env, GIT_AUTHOR_DATE: stage.at, GIT_COMMITTER_DATE: stage.at },
    stdio: 'pipe',
  });
  commitCount += 1;
}

if (leftovers.length > 0) {
  execFileSync('git', ['add', '--pathspec-from-file=-'], { input: leftovers.join('\n') });
  execFileSync('git', ['commit', '-m', 'chore: 收尾补入（时间戳晚于阶段划分）', '-m', '（重构提交）'], { stdio: 'pipe' });
  commitCount += 1;
}

console.log(`[rebuild] history 分支共 ${commitCount} 个提交：`);
console.log(git(['log', '--oneline']));
console.log(`[rebuild] 回到 ${baseBranch}`);
git(['checkout', baseBranch]);
