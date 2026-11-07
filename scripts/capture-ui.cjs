/**
 * Throwaway UI capture (not part of the app): loads the built queue page in a
 * real Electron window and writes a PNG, so the packaged renderer can be
 * eyeballed without a human at the machine.
 *
 *   env -u ELECTRON_RUN_AS_NODE electron.exe scripts/capture-ui.cjs <out.png>
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const distDir = join(__dirname, '..', 'apps', 'desktop', 'dist');
const out = process.argv[2] ?? join(__dirname, '..', 'reports', 'ui-shot.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#eef2f6',
    webPreferences: {
      preload: join(distDir, 'preload', 'bridge.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  await win.loadFile(join(distDir, 'pages', 'queue', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const image = await win.webContents.capturePage();
  writeFileSync(out, image.toPNG());
  console.log(`captured ${out}`);
  app.quit();
});
