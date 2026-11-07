/**
 * probe-fixture.js — loads L1 recorded MediaInfo / PlaylistInfo DTOs.
 *
 * The JSON files live in `tests/e2e/fixtures/` and are DERIVED from the M1
 * recorded `tests/fixtures/info-video.json` / `info-flat-playlist.json` by
 * `omitUrl()` (see tests/e2e/README.md). Nothing is hard-coded or invented:
 * every format id, subtitle language and playlist entry comes from the
 * recording. `omitUrl()` is applied AGAIN at load time as a defence in depth,
 * so `MediaFormat.url` / `SubtitleTrack.url` can never reach the DOM, logs or
 * reports (packages/shared/src/media.ts:15-16,23).
 *
 * headless shell is launched with `--allow-file-access-from-files`, which
 * permits a synchronous XHR against a sibling file:// JSON. Async fetch() is
 * blocked for file:// by Chrome even with that flag, hence the sync XHR.
 */
(function (global) {
  'use strict';
  var YTVDLT = global.YTVDLT || (global.YTVDLT = {});

  var FIXTURE_BASE = '../../../../tests/e2e/fixtures/';

  /** Recursively drop every own property literally named `url`. */
  function omitUrl(value) {
    if (Array.isArray(value)) return value.map(omitUrl);
    if (value !== null && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (key) {
        if (key === 'url') return;
        out[key] = omitUrl(value[key]);
      });
      return out;
    }
    return value;
  }

  /** True when ANY nested object still carries a `url` key (red-line detector). */
  function hasUrlKey(value) {
    if (Array.isArray(value)) return value.some(hasUrlKey);
    if (value !== null && typeof value === 'object') {
      return Object.keys(value).some(function (key) {
        return key === 'url' || hasUrlKey(value[key]);
      });
    }
    return false;
  }

  function readJson(relativePath) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', relativePath, false);
    xhr.send(null);
    if (xhr.status !== 0 && xhr.status !== 200) {
      throw new Error('fixture unavailable: ' + relativePath + ' (status ' + xhr.status + ')');
    }
    return JSON.parse(xhr.responseText);
  }

  /** Load + sanitize one of the three L1 recorded dialog fixtures. */
  function loadProbeFixture(name) {
    var raw = readJson(FIXTURE_BASE + name);
    if (hasUrlKey(raw)) {
      throw new Error('fixture contains a forbidden url key: ' + name);
    }
    return omitUrl(raw);
  }

  /** Expose a URL-free snapshot for DOM rendering / assertions. */
  function describe() {
    return { base: FIXTURE_BASE, redLine: 'no MediaFormat.url / SubtitleTrack.url anywhere' };
  }

  YTVDLT.omitUrl = omitUrl;
  YTVDLT.hasUrlKey = hasUrlKey;
  YTVDLT.loadProbeFixture = loadProbeFixture;
  YTVDLT.fixtureInfo = describe;
})(window);
