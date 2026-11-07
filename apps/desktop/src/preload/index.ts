/**
 * Preload entry (M5-4). Bundled to `dist/preload/bridge.cjs` — CommonJS on
 * purpose: `sandbox: true` preloads run in Electron's restricted context where
 * an ESM preload is only supported from `.mjs`, and the whitelist logic in
 * `bridge.ts` is already tested independently.
 *
 * This file is the only place that destructures the real `electron` module on
 * the renderer side; all policy lives in `bridge.ts`.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { installBridge } from './bridge.js';

installBridge(contextBridge, ipcRenderer);
