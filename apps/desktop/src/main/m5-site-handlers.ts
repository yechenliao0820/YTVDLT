/**
 * M5 site/preview-domain IPC handlers (task 4, mechanical extraction from
 * `m5-channels.ts`): the stage-2 subtitle preview pair, D-134 supported-site
 * discovery + per-URL pre-check, the D-160 CANCEL/STATUS pair and the D-148
 * star-prompt pair.
 *
 * The handler bodies are VERBATIM. CANCEL/STATUS answer from the SAME shared
 * precheck scope closure (`ctx.precheck`) that the download domain registers
 * into — one scope registry per host, exactly as before the split.
 */
import { IPC_CHANNELS, blocksEnqueue } from '@ytvdlt/shared';
import type { SupportedSitesDto, UrlSupportCheckDto } from '@ytvdlt/shared';
import { STAR_PROMPT_ACTIONS } from '@ytvdlt/core';
import { assertPreviewId, assertPreviewUrl, MAX_URL_CHARS, validateM5Payload } from './m5-contracts.js';
import type { M5HandlerContext, M5Handler, M5HandlerMap } from './m5-channels.js';

export function createSiteHandlers(ctx: M5HandlerContext): M5HandlerMap {
  const handlers = new Map<string, M5Handler>();
  const deps = ctx.deps;
  const {
    readOperationId, registerPrecheck, finishPrecheck, trackBatchProgress,
    peekControllers, peekProgress,
  } = ctx.precheck;


    // Subtitle preview (stage 2): the real, on-demand probe behind the picker.
  // Two invariants live here rather than in the service:
  //   1. a superseded ticket is released BEFORE the new probe, so a failure
  //      cannot leave the old id alive (the renderer already forgot it);
  //   2. an absent service answers with a code, never with fixture data.
  handlers.set(IPC_CHANNELS.SUBTITLE_PREVIEW, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.SUBTITLE_PREVIEW, payload);
    const url = assertPreviewUrl(record['url']);
    const previous = record['previousPreviewId'];
    if (previous !== undefined && previous !== '') {
      await deps.subtitlePreview?.cancel(assertPreviewId(previous));
    }
    if (deps.subtitlePreview === undefined) {
      return { ok: false, code: 'PREVIEW_UNAVAILABLE', message: '当前构建未启用字幕预览' };
    }
    return deps.subtitlePreview.preview(url);
  });

  handlers.set(IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.SUBTITLE_PREVIEW_CANCEL, payload);
    const previewId = assertPreviewId(record['previewId']);
    if (deps.subtitlePreview === undefined) return { ok: false, canceled: false };
    return { ok: true, canceled: await deps.subtitlePreview.cancel(previewId) };
  });

    // D-134 (A): "which sites can this engine parse?" — a page-level read.
  // The answer is a DTO with counts + rows; `enginePath` is intentionally
  // dropped (absolute local path, not needed by the UI). A failure is a CODE,
  // never a fallback list: §3.1 forbids inventing one, because a stale list is
  // indistinguishable from a correct one.
  handlers.set(IPC_CHANNELS.SUPPORTED_SITES, async (payload): Promise<SupportedSitesDto> => {
    const record = validateM5Payload(IPC_CHANNELS.SUPPORTED_SITES, payload);
    const refresh = record['refresh'];
    if (refresh !== undefined && typeof refresh !== 'boolean') {
      throw new Error('[m5-ipc] refresh must be a boolean');
    }
    const port = deps.siteSupport;
    if (port === undefined) {
      return {
        ok: false, code: 'ENGINE_UNAVAILABLE', engineVersion: '', siteCount: 0,
        subExtractorCount: 0, brokenCount: 0, hasGeneric: false, fetchedAt: '',
        rows: [], cached: false,
      };
    }
    const result = await port.catalog(refresh === true);
    if (!result.ok) {
      return {
        ok: false, code: result.reason, engineVersion: '', siteCount: 0,
        subExtractorCount: 0, brokenCount: 0, hasGeneric: false, fetchedAt: '',
        rows: [], cached: false,
      };
    }
    const catalog = result.catalog;
    return {
      ok: true,
      code: '',
      engineVersion: catalog.engineVersion,
      siteCount: catalog.siteCount,
      subExtractorCount: catalog.subExtractorCount,
      brokenCount: catalog.brokenCount,
      hasGeneric: catalog.extractors.some((entry) => entry.isGeneric),
      fetchedAt: catalog.fetchedAt,
      // The engine's own order is preserved: re-sorting here would hide an
      // engine change from the diff, and the page does its own sorting.
      rows: catalog.extractors,
      // R1-06: the flag comes from the layer that knows — the catalog cache —
      // and is forwarded verbatim. It used to be guessed here from "did the
      // caller pass refresh", which labelled the very first load of a session
      // as cached (and, after the cache-key fix, would have labelled every load
      // that way), telling the user a stale-looking story that was not true.
      cached: result.cached,
    };
  });

  // D-134 (B): the six-state pre-check for ONE url (§3.3/§3.4).
  // Only `UNSUPPORTED` sets `blocks: true`; the renderer must never re-derive
  // that rule, so it is computed here from the single frozen predicate.
  handlers.set(IPC_CHANNELS.URL_SUPPORT_CHECK, async (payload): Promise<UrlSupportCheckDto> => {
    const record = validateM5Payload(IPC_CHANNELS.URL_SUPPORT_CHECK, payload);
    const operationId = readOperationId(record);
    const rawUrl = record['url'];
    if (typeof rawUrl !== 'string' || rawUrl.trim() === ''
      || rawUrl.length > MAX_URL_CHARS || /[\u0000-\u001f\u007f]/.test(rawUrl)) {
      throw new Error('[m5-ipc] URL_SUPPORT_CHECK requires a bounded string url');
    }
    if (!/^https?:\/\//i.test(rawUrl.trim())) {
      throw new Error('[m5-ipc] URL_SUPPORT_CHECK requires an http(s) url');
    }
    const refresh = record['refresh'];
    if (refresh !== undefined && typeof refresh !== 'boolean') {
      throw new Error('[m5-ipc] refresh must be a boolean');
    }
    const url = rawUrl.trim();
    const unavailable: UrlSupportCheckDto = {
      url, state: 'INDETERMINATE', extractor: '', cached: false, blocks: false,
      code: 'PREVIEW_UNAVAILABLE', reason: 'pre-check unavailable in this build',
    };
    const port = deps.siteSupport;
    if (port === undefined) return unavailable;
    // T5: this single check is cancellable — a CANCEL from the page aborts the
    // signal, which kills the engine child and answers the CANCELLED state.
    const controller = registerPrecheck(operationId);
    try {
      const result = await port.check(url, refresh === true, controller.signal);
      return {
        url: result.url,
        state: result.state,
        extractor: result.extractor,
        reason: result.reason,
        cached: result.cached,
        blocks: blocksEnqueue(result.state),
        // Stable code so the renderer resolves the sentence in the active
        // locale; `reason` is the English fallback an old UI can print.
        code: result.state === 'CANCELLED' ? 'PRECHECK_CANCELLED'
          : result.state === 'UNSUPPORTED' && result.extractor === ''
            ? 'SITE_UNSUPPORTED'
            : result.state === 'UNSUPPORTED' ? 'ITEM_UNSUPPORTED'
              : result.state === 'NO_MEDIA' ? 'NO_MEDIA'
                : result.state === 'TIMEOUT' ? 'PRECHECK_TIMEOUT'
                  : result.state === 'INDETERMINATE' ? 'INDETERMINATE' : '',
      };
    } finally {
      finishPrecheck(operationId, controller);
    }
  });

  // D-160: the user-level "stop" for ONE submission. An `operationId` scopes
  // the abort to that submission's controllers; without it only the LEGACY
  // scope is reachable. Two live dialogs with different ids can therefore run
  // and be cancelled independently, which the old global Set could not do.
  // Aborting an already-finished controller is a no-op, so a stale id is
  // harmless; an id nobody registered answers `cancelled: false` honestly.
  handlers.set(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.URL_SUPPORT_CHECK_CANCEL, payload);
    const operationId = readOperationId(record);
    // Task-4 seam: this used to read the closure's scopes map directly; it now
    // peeks through ctx.precheck — the same single registry, read-only.
    const controllers = [...peekControllers(operationId)];
    for (const controller of controllers) controller.abort();
    return { ok: true, cancelled: controllers.length > 0 };
  });

  // T5 (append-only): read-only progress probe for the batch dialogs. Polling,
  // not pushing, on purpose: this IPC surface is invoke/response, and the
  // project's established progress pattern is a polled read (APP_UPDATE_STATUS,
  // §5 rule 6). `active` turns false the moment the last batch pre-check
  // settles, which is the poll's termination condition.
  handlers.set(IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.URL_SUPPORT_CHECK_STATUS, payload);
    const operationId = readOperationId(record);
    // D-160: progress is per submission too, so one dialog's readout cannot
    // show another dialog's checked/total counts.
    const progress = peekProgress(operationId);
    let checked = 0;
    let total = 0;
    if (progress !== undefined) {
      for (const entry of progress.values()) {
        checked += entry.checked;
        total += entry.total;
      }
    }
    return { active: progress !== undefined && progress.size > 0, checked, total };
  });

  // D-148 (A): "may the Star prompt show now?" — a zero-payload read (same
  // rule as APP_INFO). The whole frequency decision (launch count, per-version
  // cap, 7-day retry gap, permanent silence) lives behind the port; the
  // renderer only receives a boolean and can never inflate its own state.
  handlers.set(IPC_CHANNELS.STAR_PROMPT_CHECK, async (payload): Promise<{ show: boolean }> => {
    validateM5Payload(IPC_CHANNELS.STAR_PROMPT_CHECK, payload);
    const port = deps.starPrompt;
    if (port === undefined) return { show: false };
    return port.check();
  });

  // D-148 (B): the user's answer. One validated enum, nothing else — the
  // repository URL is a main-process constant, so the renderer has no way to
  // point `shell.openExternal` anywhere else (D-98 spirit).
  handlers.set(IPC_CHANNELS.STAR_PROMPT_ACTION, async (payload) => {
    const record = validateM5Payload(IPC_CHANNELS.STAR_PROMPT_ACTION, payload);
    const action = record['action'];
    if (typeof action !== 'string' || !STAR_PROMPT_ACTIONS.includes(action as never)) {
      throw new Error('[m5-ipc] unknown star prompt action');
    }
    const port = deps.starPrompt;
    if (port === undefined) return { ok: false, action, code: 'STAR_PROMPT_UNAVAILABLE' };
    return port.applyAction(action);
  });

  return handlers;
}
