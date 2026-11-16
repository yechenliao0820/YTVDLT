/**
 * UI 装载链静态完整性（A-D187 的静态半边）：HTML 里引用的本地脚本 / 样式必须真实存在。
 *
 * 为什么需要：`packages/ui/src` 是普通 `<script>` + 相对路径，不是打包器解析的
 * ES module。文件一旦搬家（例如 `dialogs/subtitle-picker.js` → `subtitles/`、
 * 新增 `queue-model.js`），HTML 里的引用不会自动跟着改——打包后表现为
 * **静默失败**（页面少一个全局、按钮点了没反应），e2e 能抓到，但 CI 不跑 e2e。
 *
 * 这条检查不看渲染、不起浏览器、不构建，只在源码树上做存在性断言，因此能进
 * 现有 `pnpm test` 的每一轮 CI。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_ROOT = fileURLToPath(new URL('../../packages/ui/src', import.meta.url));

function walkHtml(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkHtml(full, out);
    } else if (entry.name.endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

/** `src=` / `href=` 的值；HTML 属性顺序和引号风格都不固定，两种引号都收。 */
const ATTR_RE = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

/** External / non-file schemes are out of scope: this test only checks the tree. */
function isExternal(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);
}

interface Ref {
  readonly page: string;
  readonly url: string;
  readonly target: string;
}

const pages = walkHtml(UI_ROOT).sort();
const refs: Ref[] = [];
const external: Array<{ page: string; url: string }> = [];

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(html)) !== null) {
    const raw = match[1].trim();
    if (raw === '' || isExternal(raw)) {
      external.push({ page, url: raw });
      continue;
    }
    // Strip `?cache-bust` / `#anchor` before resolving; both are legitimate.
    const clean = raw.split('#')[0].split('?')[0];
    if (clean === '') continue;
    refs.push({ page, url: raw, target: resolve(dirname(page), clean) });
  }
}

const rel = (path: string): string => relative(UI_ROOT, path).split(sep).join('/');

describe('UI loader integrity (static)', () => {
  it('finds a realistic number of local references (guards against a silent no-op)', () => {
    // 当前实测：8 个 HTML（3 对话框 + 5 页面）、90 条本地引用、6 条外链。
    // 阈值取略低于实测值：真的删掉几个脚本不会误报，但解析器失效（正则写坏、
    // 目录走错）会立刻失败——否则这条用例会变成永远绿的摆设。
    expect(pages.length).toBeGreaterThanOrEqual(8);
    expect(refs.length).toBeGreaterThanOrEqual(80);
  });

  it('every referenced local file exists on disk', () => {
    const missing = refs
      .filter((ref) => !existsSync(ref.target))
      .map((ref) => `${rel(ref.page)} → ${ref.url}`);
    expect(missing).toEqual([]);
  });

  it('references stay inside the UI tree (no accidental escape to ../../..)', () => {
    const escaped = refs
      .filter((ref) => {
        const path = ref.target.split(sep).join('/');
        return !path.toLowerCase().startsWith(UI_ROOT.split(sep).join('/').toLowerCase());
      })
      .map((ref) => `${rel(ref.page)} → ${ref.url}`);
    expect(escaped).toEqual([]);
  });

  it('HTML pages are regular files (no dangling directory reference)', () => {
    for (const page of pages) {
      expect(statSync(page).isFile(), rel(page)).toBe(true);
    }
  });
});
