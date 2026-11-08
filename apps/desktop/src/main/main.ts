/**
 * Packaged/desktop entry point (M5-4).
 *
 * `electron-entry.ts` already knows how to assemble ports, engine, host and
 * window; what was missing is the one file a packaged app can actually start
 * with. `package.json#main` (or `-c.extraMetadata.main` at build time) points
 * here.
 *
 * Bundled as **CommonJS** (`dist/main/main.cjs`): Electron's built-in module
 * does not expose named ESM exports (`import { app } from 'electron'` throws
 * "does not provide an export named 'BrowserWindow'"), and every workspace
 * package is inlined anyway. CJS also gives us `__dirname` for free — and the
 * path must come from the file's own location, never from `process.cwd()`,
 * because a shortcut, the installer and Explorer all launch with different
 * working directories.
 */
import { app } from 'electron';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startApplication } from './electron-entry.js';

const mainDir = __dirname; // <app>/dist/main
const distDir = join(mainDir, '..'); // <app>/dist
// D-91: pin the real packaged version onto the page URL. The renderer is a
// sandboxed file:// page and cannot call app.getVersion() itself; this keeps
// the footer / About box honest instead of hard-coding a version that rots.
const pageUrl = `${pathToFileURL(join(distDir, 'pages', 'queue', 'index.html')).href}?v=${encodeURIComponent(app.getVersion())}`;
const preloadPath = join(distDir, 'preload', 'bridge.cjs');
const iconPath = join(distDir, 'icon.ico');

// The tray icon is optional: `bootstrap()` already degrades gracefully when the
// Tray constructor throws, and a missing icon must not abort start-up.
const trayIconPath = existsSync(iconPath) ? iconPath : process.execPath;

void startApplication({ pageUrl, preloadPath, trayIconPath }).catch((error: unknown) => {
  // No window exists yet, so this is the last chance to surface a fatal error.
  // `showErrorBox` is intentionally avoided (headless CI); stderr + exit code.
  console.error('[ytvdlt] fatal start-up failure:', error);
  app.exit(1);
});
