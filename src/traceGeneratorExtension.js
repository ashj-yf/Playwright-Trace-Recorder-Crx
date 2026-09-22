/**
 * Playwright trace generator for Chrome extension service workers.
 *
 * Streams the archive out instead of building it in memory:
 *  - `trace.trace` is emitted line by line through a ZipBlobWriter stream, so the
 *    full trace text never exists as a single string
 *  - DOM snapshots are read back from IndexedDB one frame at a time, parsed,
 *    emitted, then released — peak heap is one snapshot, not all of them
 *  - events, request records and resources are streamed out of IndexedDB too
 *
 * Resources are already content-addressed (sha1) by the recorder, so no hashing
 * or base64 buffering happens here.
 */

import { ZipBlobWriter } from './zipStream.js';
import {
  readSnapshot,
  readResource,
  readEvents,
  readRequests,
  listResourceNames
} from './traceStore.js';
const RESOURCE_PREFIX = 'resources/';
const LINE_CHUNK_BYTES = 64 * 1024;

/** Coalesce many small lines into larger chunks before they hit the compressor. */
async function* chunkLines(lines) {
  let buffer = '';
  for await (const line of lines) {
    buffer += line;
    if (buffer.length >= LINE_CHUNK_BYTES) {
      yield buffer;
      buffer = '';
    }
  }
  if (buffer) yield buffer;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Builds the subtree-reference encoder used for ONE FRAME of one recording.
 * Back-reference indices are per frameId in the viewer, so each frame gets its
 * own instance; the state (hash table + snapshot counter) is otherwise per
 * recording.
 *
 * Exported for tests: the round-trip check feeds real snapshots through this and
 * asserts the trace viewer renders them identically to the un-referenced form.
 *
 * Two invariants make this safe, both dictated by the viewer's
 * `snapshotNodes()` (utils/isomorphic/trace/snapshotRenderer.js):
 *
 *  1. Indices come from a post-order walk of the *emitted* tree that numbers
 *     text nodes and elements and never descends into a reference. So indices
 *     have to be handed out top-down while the hashes that decide what is
 *     unchanged have to be computed bottom-up — hence two passes.
 *  2. A reference points at the snapshot that last *materialized* the subtree,
 *     encoded as `[[snapshotsBack, nodeIndex]]`.
 */
function createSubtreeReferencer() {
  /** Subtree hash → [snapshotIndex, nodeIndex] where it was last materialized. */
  const materialized = new Map();
  let snapshotIndex = 0;

  // Bounds the table on a long recording of a large page. Past this, subtrees are
  // still emitted correctly, just in full — declining to register a hash only
  // ever costs compression, never correctness.
  const MAX_REF_ENTRIES = 200000;

  /**
   * 96-bit FNV-1a-style digest, three accumulators in one pass over `text`.
   * A 32-bit hash would eventually collide across a long recording and silently
   * swap one subtree for another, so the extra width buys real safety here.
   */
  function hash96(text) {
    let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x85ebca6b);
      h3 = Math.imul(h3 ^ c, 0xc2b2ae35);
    }
    return (h1 >>> 0).toString(36) + '.' + (h2 >>> 0).toString(36) + '.' +
      (h3 >>> 0).toString(36) + '.' + text.length.toString(36);
  }

  function hashTree(node) {
    if (typeof node === 'string') return { hash: hash96('t:' + node) };
    if (!Array.isArray(node) || typeof node[0] !== 'string') return { hash: null };
    const children = [];
    let acc = 'e:' + node[0] + ':' + JSON.stringify(node[1] || {});
    for (let i = 2; i < node.length; i++) {
      const child = hashTree(node[i]);
      children.push(child);
      acc += '|' + child.hash;
    }
    return { hash: hash96(acc), children };
  }

  function encodeNode(node, hashes, counter) {
    const known = hashes.hash === null ? undefined : materialized.get(hashes.hash);
    if (known) return [[snapshotIndex - known[0], known[1]]];

    const remember = () => {
      if (materialized.size < MAX_REF_ENTRIES) {
        materialized.set(hashes.hash, [snapshotIndex, counter.next]);
      }
      counter.next++;
    };

    if (typeof node === 'string') {
      remember();
      return node;
    }
    if (hashes.hash === null) return node;

    const out = [node[0], node[1]];
    for (let i = 2; i < node.length; i++) {
      out.push(encodeNode(node[i], hashes.children[i - 2], counter));
    }
    remember();
    return out;
  }

  return function referenceUnchangedSubtrees(html) {
    const encoded = encodeNode(html, hashTree(html), { next: 0 });
    snapshotIndex++;
    return encoded;
  };
}

/**
 * Rewrite a parsed snapshot tree into its viewer-safe emitted form:
 *  - iframe elements tagged at capture with `__pw_frame__` get the viewer's
 *    snapshot route as their src (`#<frameId>/<snapshotName>`),
 *  - scripts can never execute: external src moves to data-src, inline scripts
 *    are renamed to invisible X-SCRIPT elements while keeping their source,
 *  - prefetched/preloaded scripts lose their executable rel.
 * Mutates in place — the parsed tree is discarded right after serialization.
 */
function neutralizeScripts(node, snapshotName) {
  if (!Array.isArray(node) || node.length < 2) return node;
  const tag = node[0];
  const attrs = node[1];
  if (attrs && typeof attrs === 'object') {
    if (attrs.__pw_frame__) {
      attrs.src = `#${attrs.__pw_frame__}/${snapshotName}`;
      delete attrs.__pw_frame__;
    }
    if (tag === 'LINK') {
      const rel = attrs.rel || '';
      const as = attrs.as || '';
      if (rel.includes('modulepreload') || (rel.includes('preload') && as === 'script')) {
        if (attrs.href) attrs['data-js-href'] = attrs.href;
        attrs.rel = rel.replace('modulepreload', '').replace('preload', '').trim();
      }
    } else if (tag === 'STYLE') {
      // Not a real stylesheet URL — inline stylesheet text travels inside the
      // snapshot itself, and the viewer only resolves external <link> sheets.
      delete attrs['data-href'];
    } else if (tag === 'SCRIPT') {
      if (attrs.src) {
        attrs['data-src'] = attrs.src;
        delete attrs.src;
      } else {
        // Inline script: preserve the source text but make it unexecutable and
        // invisible when the snapshot DOM is rendered.
        node[0] = 'X-SCRIPT';
        attrs.style = attrs.style ? `display:none!important;${attrs.style}` : 'display:none!important';
      }
    }
  }
  for (let i = 2; i < node.length; i++) {
    if (Array.isArray(node[i])) neutralizeScripts(node[i], snapshotName);
  }
  return node;
}

/**
 * CDP wire protocol -> HAR `httpVersion` spelling.
 *
 * Mirrors playwright-core's `Response.internalHttpVersion()` exactly: absent or
 * `http/1.1` reads back as `HTTP/1.1`, `h2` as `HTTP/2.0`, and anything else
 * (including `blob`) is passed through unchanged. Emitting CDP's own spelling
 * would show "h2" where every official trace and the official HAR exporter
 * show "HTTP/2.0".
 */
function harHttpVersion(protocol) {
  if (!protocol) return 'HTTP/1.1';
  if (protocol === 'http/1.1') return 'HTTP/1.1';
  if (protocol === 'h2') return 'HTTP/2.0';
  return protocol;
}

/**
 * Builds the HAR `timings` block from CDP's `Network.ResourceTiming`.
 *
 * Every phase is a difference of two fields that share one clock (`requestTime`),
 * so the subtraction is directly in milliseconds — this is the same arithmetic
 * playwright-core performs in `_onResponseReceived`/`_onRequestFinished`. `-1`
 * means "this phase did not happen" (cache hit, reused connection) and is
 * preserved rather than zeroed, because zero would claim an instantaneous phase
 * instead of an absent one.
 *
 * `send` is pinned to 0 exactly as official does. `receive` measures response
 * headers to end of body: CDP's `timing` has no end field for it, so it comes
 * from the recorder's own arrival timestamps.
 *
 * @param {Object} req Stored request record.
 * @returns {{dns: number, connect: number, ssl: number, send: number,
 *   wait: number, receive: number}|{send: number, wait: number, receive: number}}
 */
function harTimings(req) {
  // No CDP timing at all (a cache hit, a service-worker-served response, or a
  // request whose response never arrived): the honest answer is the same
  // all-placeholder block the official HAR scaffold starts from.
  const t = req.timing;
  if (!t) return { send: -1, wait: -1, receive: -1 };

  const phase = (end, start) =>
    Number.isFinite(end) && Number.isFinite(start) && end !== -1 && start !== -1
      ? roundish(end - start)
      : -1;

  // Response headers -> end of body. The recorder samples both ends on its own
  // wall clock; a request that never finished keeps -1 rather than inventing
  // the remainder of the total.
  const receive = req.responseReceivedAt && req.finishedAt && req.finishedAt >= req.responseReceivedAt
    ? roundish(req.finishedAt - req.responseReceivedAt)
    : -1;

  return {
    dns: phase(t.dnsEnd, t.dnsStart),
    connect: phase(t.connectEnd, t.connectStart),
    ssl: phase(t.connectEnd, t.sslStart),
    // Official pins send to 0 (not -1): the phase is considered measured.
    send: 0,
    wait: phase(t.receiveHeadersEnd, t.sendStart),
    receive
  };
}

/**
 * Normalizes CDP's `securityDetails` to the shape official's HAR carries.
 *
 * playwright-core builds this object field-by-field (`_securityDetailsFinished`)
 * with exactly `protocol`, `subjectName`, `issuer`, `validFrom` and `validTo`;
 * CDP's own payload additionally holds fields such as
 * `certificateTransparencyCompliance`, `sanList` and `signedCertificateTimestampList`.
 * Publishing the raw object would put keys in the archive that no HAR consumer
 * expects, so only the official five are kept. Absent fields are omitted (which
 * is how official's `undefined` values serialize), leaving `{}` for a plain
 * HTTP response — exactly what official writes there.
 *
 * @param {Object} details CDP `Network.SecurityDetails`.
 * @returns {Object} The five-field HAR object.
 */
function harSecurityDetails(details) {
  const out = {};
  for (const key of ['protocol', 'subjectName', 'issuer', 'validFrom', 'validTo']) {
    if (details[key] !== undefined && details[key] !== null) out[key] = details[key];
  }
  return out;
}

/**
 * Truncates to microsecond precision, matching playwright-core's
 * `millisToRoundishMillis` (`(value * 1e3 | 0) / 1e3`). Without it, floating
 * point noise from the CDP differences shows up as absurd fractional
 * milliseconds in the HAR.
 */
function roundish(ms) {
  return Math.trunc(ms * 1e3) / 1e3;
}

/**
 * Emits a Playwright trace zip for a finished (or recovered) recording.
 *
 * @param {Object} recording Recorder state; everything bulky is read from IDB.
 * @returns {Promise<{id: string, blob: Blob, name: string, url: string,
 *   timestamp: number, eventCount: number, size: number}>}
 */
async function generatePlaywrightTraceInBrowser(recording) {
  const id = crypto.randomUUID();
  const session = recording.session;
  const zip = new ZipBlobWriter();

  const nowWall = Date.now();
  const mainFrameId = recording.mainFrameId || ('frame@' + id.substring(0, 8));
  const viewport = recording.viewport || { width: 1280, height: 720 };
  // Screencast frames are captured at device pixels while the viewport above is
  // in CSS pixels; declaring the real ratio is what keeps the two consistent.
  const scaleFactor = Number.isFinite(recording.deviceScaleFactor) && recording.deviceScaleFactor > 0
    ? recording.deviceScaleFactor : 1;

  // Base time is the first event's timestamp. Events live in IDB, so prime the
  // iterator before opening the trace stream.
  const eventIterator = readEvents(session)[Symbol.asyncIterator]();
  const firstEventResult = await eventIterator.next();
  const baseTime = !firstEventResult.done
    ? (firstEventResult.value.timestamp || firstEventResult.value.time ||
       firstEventResult.value.startTime || recording.startTime || nowWall)
    : (recording.startTime || nowWall);
  const relTime = absTime => Math.max(0, absTime - baseTime);

  const pageId = 'page@' + id.substring(0, 8);

  // ── metadata.json ───────────────────────────────────────────────────────────
  await zip.addFile('metadata.json', JSON.stringify({
    version: 6,
    startTime: 0,
    endTime: relTime(nowWall),
    wallTime: baseTime,
    browserName: 'chromium',
    options: {
      viewport,
      deviceScaleFactor: scaleFactor,
      isMobile: false,
      ...(recording.locale ? { locale: recording.locale } : {}),
      ...(recording.timezoneId ? { timezoneId: recording.timezoneId } : {})
    },
    pages: [{
      pageId,
      url: recording.url || '',
      title: recording.name || 'Playwright Trace'
    }]
  }, null, 2));

  // Stylesheets are deduplicated per recording, so every snapshot shares the
  // same override list — build it once instead of per snapshot.
  const resourceOverrides = [];
  for (const [href, resourceName] of (recording.cssRefs || new Map())) {
    resourceOverrides.push({ url: href, sha1: resourceName });
  }

  // One referencer (snapshot counter + subtree hash table) per frame.
  const referencers = new Map();
  const referencerFor = frameId => {
    let ref = referencers.get(frameId);
    if (!ref) {
      ref = createSubtreeReferencer();
      referencers.set(frameId, ref);
    }
    return ref;
  };

  async function loadSnapshotDom(snapshotId) {
    if (snapshotId === null || snapshotId === undefined) return null;
    let json;
    try {
      json = await readSnapshot(snapshotId);
    } catch (err) {
      console.warn('[TraceGen] Could not read snapshot', snapshotId, err);
      return null;
    }
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch (_) {
      return null;
    }
  }

  /**
   * Build every frame's frame-snapshot line for one action stage
   * (before/action/after). Each entry in idsMap is one frame's snapshot id.
   */
  async function buildFrameLines(snapshotName, idsMap, callId, snapTime) {
    const entries = Object.entries(idsMap || {});
    entries.sort(([a], [b]) =>
      (a === mainFrameId ? -1 : 0) - (b === mainFrameId ? -1 : 0));

    const lines = [];
    for (const [frameId, snapshotId] of entries) {
      const domSnap = await loadSnapshotDom(snapshotId);
      if (!domSnap || !Array.isArray(domSnap.html)) continue;

      const effectiveFrameId = domSnap.frameId || frameId;
      const html = referencerFor(effectiveFrameId)(
        neutralizeScripts(domSnap.html, snapshotName));

      // `timestamp` is the monotonic offset the timeline is drawn against, but
      // the viewer pairs a snapshot with the screencast frame that was on screen
      // when it was taken by wall clock (snapshotRenderer.closestScreenshot).
      // The page stamps that instant at capture time; fall back to the derived
      // offset only if it is missing, which degrades pairing but stays valid.
      const wallTime = Number.isFinite(domSnap.wallTime) ? domSnap.wallTime : snapTime;

      lines.push(JSON.stringify({
        type: 'frame-snapshot',
        snapshot: {
          callId,
          snapshotName,
          pageId,
          frameId: effectiveFrameId,
          frameUrl: domSnap.url || recording.url || '',
          doctype: domSnap.doctype || 'html',
          html,
          viewport: domSnap.viewport || viewport,
          timestamp: snapTime,
          wallTime,
          collectionTime: 0,
          resourceOverrides,
          isMainFrame: !!domSnap.isMainFrame || effectiveFrameId === mainFrameId
        }
      }) + '\n');
    }
    return lines;
  }

  // ── trace.trace ─────────────────────────────────────────────────────────────
  let eventCount = 0;

  async function* traceLines() {
    yield JSON.stringify({
      version: 6,
      type: 'context-options',
      origin: 'library',
      browserName: 'chromium',
      channel: '',
      options: {
        viewport,
        deviceScaleFactor: scaleFactor,
        isMobile: false,
        hasTouch: false,
        javaScriptEnabled: true,
        // The environment the page actually ran under. Official records both;
        // they are read from the page at capture time and omitted when unknown,
        // rather than guessed, so a trace never claims an environment it did not
        // observe.
        ...(recording.locale ? { locale: recording.locale } : {}),
        ...(recording.timezoneId ? { timezoneId: recording.timezoneId } : {})
      },
      platform: navigator.platform || 'unknown',
      wallTime: baseTime,
      monotonicTime: 0,
      sdkLanguage: 'javascript',
      testIdAttributeName: 'data-testid',
      internal: {}
    }) + '\n';

    yield JSON.stringify({
      type: 'event',
      time: relTime(baseTime),
      class: 'BrowserContext',
      method: 'newPage',
      params: { page: { guid: pageId } },
      pageId,
      internal: {}
    }) + '\n';

    // The synthetic initial line states where the recording STARTED. With the
    // CDP navigation handler owning rec.url, recording.url is now the FINAL url
    // (metadata deliberately keeps it), so the start url comes from the first
    // main-frame navigation event — which is the Page.reload echo at recording
    // start — falling back to recording.url when no navigation was captured.
    let initialUrl = recording.url || '';
    for await (const ev of readEvents(session)) {
      if (ev && ev.type === 'navigation' && ev.frameId === mainFrameId && ev.url) {
        initialUrl = ev.url;
        break;
      }
    }

    if (initialUrl) {
      yield JSON.stringify({
        type: 'event',
        time: relTime(baseTime),
        class: 'Frame',
        method: 'navigated',
        params: { url: initialUrl, name: '' },
        pageId,
        internal: {}
      }) + '\n';
    }

    // Consecutive same-URL navigations of one frame carry no timeline
    // information (the Page.reload echo repeats the start url the synthetic
    // line already announced); seeding the main frame's last url absorbs it
    // instead of emitting a duplicate.
    const lastNavigatedUrl = new Map();
    lastNavigatedUrl.set(mainFrameId, initialUrl);

    let actionIndex = 0;
    const pendingActions = new Map();

    // Continue from the primed iterator.
    const events = (async function* () {
      if (!firstEventResult.done) yield firstEventResult.value;
      for await (const value of eventIterator) yield value;
    })();

    for await (const event of events) {
      if (!event || !event.type) continue;
      eventCount++;
      const eventTime = event.timestamp || event.time || event.startTime || nowWall;

      if (event.type === 'before') {
        actionIndex++;
        const actionId = event.callId || `action-${actionIndex}`;
        const beforeName = `before@${actionId}`;
        const actionName = `action@${actionId}`;

        // The declaring line MUST be emitted before the snapshot it names.
        // Playwright's modernizer (`_modernize_8_to_9`) resolves each
        // frame-snapshot's `phase` by looking the snapshot up in a map that is
        // only populated while the declaring event is processed; a snapshot
        // written first gets `phase = undefined`, registers no renderer, and
        // renders blank. Building still happens here (the subtree referencer is
        // stateful and counts snapshots in emission order), only the yield moves.
        const beforeLines = await buildFrameLines(
          beforeName, event.beforeSnapshotIds, actionId, relTime(eventTime));

        yield JSON.stringify({
          type: 'before',
          callId: actionId,
          startTime: relTime(eventTime),
          // No `apiName`: the v6→v8 modernizer copies it verbatim into `title`,
          // which then WINS over the viewer's own metadata lookup and renders the
          // raw string (e.g. "Frame.click") instead of a human title. Official
          // traces carry `class`+`method` only and let the viewer resolve
          // "Click" / "Fill "{value}"" with the selector as subtitle.
          class: event.class || 'Frame',
          method: event.method || 'click',
          params: event.params || {},
          pageId,
          wallTime: eventTime,
          // Only declare a before snapshot that actually exists: a dangling
          // reference makes the viewer ask for a snapshot it can never find.
          beforeSnapshot: beforeLines.length > 0 ? beforeName : undefined,
          internal: {}
        }) + '\n';

        for (const line of beforeLines) yield line;

        const actionLines = await buildFrameLines(
          actionName, event.actionSnapshotIds, actionId, relTime(eventTime));

        // A gated action snapshot must not leave a dangling inputSnapshot
        // reference behind: emit the input line only when the action stage
        // exists. point rides along so the viewer can pin the click position,
        // and box lets it outline the element the action addressed.
        if (actionLines.length > 0) {
          yield JSON.stringify({
            type: 'input', callId: actionId, inputSnapshot: actionName,
            ...(event.params && event.params.point ? { point: event.params.point } : {}),
            ...(event.params && event.params.box ? { box: event.params.box } : {})
          }) + '\n';

          for (const line of actionLines) yield line;
        }

        pendingActions.set(actionId, {
          hasDom: beforeLines.length > 0 || actionLines.length > 0
        });

      } else if (event.type === 'after') {
        const actionId = event.callId || `action-${actionIndex}`;
        const pending = pendingActions.get(actionId);
        pendingActions.delete(actionId);
        const snapTime = relTime(event.endTime || eventTime);

        const afterName = `after@${actionId}`;
        const afterLines = await buildFrameLines(
          afterName, event.afterSnapshotIds, actionId, snapTime);

        const hasDomSnapshots =
          (pending && pending.hasDom) || afterLines.length > 0;

        const afterEvent = {
          type: 'after',
          callId: actionId,
          endTime: snapTime,
          wallTime: event.endTime || eventTime,
          afterSnapshot: afterLines.length > 0 ? afterName : undefined,
          internal: {}
        };

        // Synthetic frames are BUILT here (the subtree referencer is stateful and
        // counts in emission order) but yielded after the declaring `after` line,
        // for the same reason as the before/action stages above.
        //
        // Only the `after` stage is synthesized. This branch runs when the action
        // produced no DOM snapshot at all, so there is no before/action state to
        // represent; emitting three copies of the same embedded screenshot would
        // multiply the payload for frames no renderer can ever reach.
        const fallbackLines = [];
        const attachments = [];
        for (const att of (event.attachments || [])) {
          if (!att.resource) continue;

          // The continuous screencast supplies the filmstrip; this full-detail
          // screenshot is what the viewer shows in its attachments panel, where
          // the downsampled filmstrip frame is not readable. Both are kept on
          // purpose — they answer different questions.

          // Without any DOM snapshot the viewer would show a blank frame, so
          // fall back to displaying the screenshot itself (main frame only).
          if (!hasDomSnapshots) {
            const bytes = await readResource(session, att.resource);
            if (bytes) {
              const b64 = bytesToBase64(bytes);
              const fallbackDom = {
                doctype: 'html',
                frameId: mainFrameId,
                isMainFrame: true,
                html: ['HTML', {},
                  ['HEAD', {}],
                  ['BODY', { style: 'margin:0;overflow:hidden;background:#0f0f0f;display:flex;align-items:center;justify-content:center;height:100vh;' },
                    ['IMG', { src: `data:${att.contentType || 'image/jpeg'};base64,${b64}`, style: 'max-width:100%;max-height:100%;object-fit:contain;' }]
                  ]
                ],
                url: recording.url || '',
                viewport
              };
              // The synthetic DOM is built here rather than read from IDB: no
              // DOM snapshot exists at all for this action.
              const html = referencerFor(mainFrameId)(
                neutralizeScripts(fallbackDom.html, afterName));
              fallbackLines.push(JSON.stringify({
                type: 'frame-snapshot',
                snapshot: {
                  callId: actionId,
                  snapshotName: afterName,
                  pageId,
                  frameId: mainFrameId,
                  frameUrl: recording.url || '',
                  doctype: 'html',
                  html,
                  viewport,
                  timestamp: snapTime,
                  // No page-stamped capture instant exists for a synthetic
                  // frame; the action's absolute end time is the closest
                  // truthful wall clock, and keeps pairing working.
                  wallTime: event.endTime || eventTime,
                  collectionTime: 0,
                  resourceOverrides,
                  isMainFrame: true
                }
              }) + '\n');
              afterEvent.afterSnapshot = afterName;
            }
          }

          attachments.push({
            name: att.name || 'screenshot',
            contentType: att.contentType || 'image/jpeg',
            sha1: att.resource
          });
        }

        if (attachments.length > 0) afterEvent.attachments = attachments;

        // Declaration first, then the snapshots it names.
        yield JSON.stringify(afterEvent) + '\n';
        for (const line of afterLines) yield line;
        for (const line of fallbackLines) yield line;

      } else if (event.type === 'screencast-frame') {
        // The continuous screencast: one line per frame, in arrival order. These
        // are what the viewer draws as the filmstrip and repaints canvases from,
        // and `frameSwapWallTime` is the field it pairs a snapshot against — so
        // it must stay the absolute page-presentation instant recorded at
        // capture time, unlike the trace-relative `timestamp`.
        if (!event.sha1) continue;
        yield JSON.stringify({
          type: 'screencast-frame',
          pageId,
          sha1: event.sha1,
          width: event.width || viewport.width,
          height: event.height || viewport.height,
          timestamp: relTime(event.timestamp || eventTime),
          frameSwapWallTime: event.frameSwapWallTime || event.timestamp || eventTime
        }) + '\n';

      } else if (event.type === 'console') {
        // The viewer renders console output only from a top-level
        // `type: "console"` line, reading `messageType`, `args` and `location`.
        // The older `type:"event", class:"Page", method:"console"` shape is not
        // understood by the current viewer, so those messages were invisible.
        const text = event.text || '';
        yield JSON.stringify({
          type: 'console',
          messageType: event.messageType || 'log',
          text,
          // The args panel wants {preview, value} pairs. The recorder stores the
          // joined text rather than per-argument handles, so the text is exposed
          // as a single argument — enough for the viewer's rendering path.
          args: event.args || [{ preview: text.slice(0, 200), value: text }],
          location: event.location || { url: '', lineNumber: 0, columnNumber: 0 },
          time: relTime(eventTime),
          pageId
        }) + '\n';

      } else if (event.type === 'pageError') {
        // Uncaught page exceptions surface in the viewer's Console panel and are
        // counted as errors. The shape mirrors the official recorder's
        // `_onPageError` event (serializeError nests the error one level deep).
        const err = event.error || {};
        yield JSON.stringify({
          type: 'event',
          time: relTime(eventTime),
          class: 'BrowserContext',
          method: 'pageError',
          params: {
            error: {
              error: {
                name: err.name || 'Error',
                message: err.message || String(err.value || 'Uncaught error'),
                stack: err.stack || ''
              }
            },
            location: event.location || { url: '', line: 0, column: 0 }
          },
          pageId
        }) + '\n';
      } else if (event.type === 'navigation') {
        // Only the main frame's navigations enter the timeline: the line
        // format carries no frame identity (official Frame.navigated params
        // are just {url, name}), so a child frame's navigation would read as
        // the page itself navigating. Child-frame events stay recorded in the
        // event store. `name` is the CDP frame name (iframe name attribute),
        // not the document title — official frameDispatcher semantics.
        if (event.frameId !== mainFrameId) continue;
        if (lastNavigatedUrl.get(event.frameId) === event.url) continue;
        lastNavigatedUrl.set(event.frameId, event.url);
        yield JSON.stringify({
          type: 'event',
          time: relTime(eventTime),
          class: 'Frame',
          method: 'navigated',
          params: { url: event.url, name: event.name || '' },
          pageId,
          internal: {}
        }) + '\n';
      }
    }
  }

  try {
    await zip.addStream('trace.trace', chunkLines(traceLines()));
  } catch (err) {
    throw new Error(`stream trace.trace: ${err && err.message}`);
  }

  // ── trace.network ───────────────────────────────────────────────────────────
  async function* networkLines() {
    for await (const req of readRequests(session)) {
      // Keep http(s) AND ws(s): a websocket handshake's URL is ws(s)://, and the
      // viewer routes it to the Messages tab by `_resourceType === 'websocket'`.
      if (!req.url || !/^https?:|^wss?:/.test(req.url)) continue;

      const isWebSocket = req.resourceType === 'websocket';

      const postData = req.postDataSha1
        ? { _sha1: req.postDataSha1 }
        : (req.postDataText != null ? { text: req.postDataText } : undefined);

      // HAR scaffold the viewer dereferences WITHOUT a guard. `queryString` is
      // read as `.length` by the Payload tab and `cookies` by "Copy as
      // Fetch"/cURL; when either is absent the panel throws a TypeError and
      // React unmounts the entire viewer (blank page). Official traces always
      // carry them, so they are emitted even when empty.
      let queryString = [];
      try {
        const parsed = new URL(req.url);
        queryString = [...parsed.searchParams].map(([name, value]) => ({ name, value }));
      } catch (_) { /* unparsable URL: an empty query string is correct */ }

      // The viewer's network panel draws each request as
      //   start    = _monotonicTime - (minimum across resources)
      //   duration = time
      // so `time` is a DURATION and `_monotonicTime` is the start offset.
      // Writing the start offset into both makes every bar span from its own
      // start to the same absolute point, pushing the waterfall past the end of
      // the recording. A request that never finished (recording stopped mid
      // flight) gets a zero duration rather than a bogus one.
      const startedMs = req.timestamp || baseTime;
      const durationMs = req.finishedAt && req.finishedAt > startedMs
        ? req.finishedAt - startedMs
        : 0;

      // CDP reports the wire protocol ("h2", "http/1.1", "blob"); HAR wants the
      // display spelling. This mirrors official's `internalHttpVersion()`
      // one-for-one so a trace shows "HTTP/2.0" exactly where Playwright does.
      const httpVersion = harHttpVersion(req.protocol);

      // CDP's ResourceTiming expresses every phase in MILLISECONDS relative to
      // `requestTime`, with -1 marking a phase that never happened. Taking a
      // difference between two fields on that same clock therefore yields
      // milliseconds directly (verified against playwright-core's own
      // `millisToRoundishMillis` use). `harTimings` performs that arithmetic.
      const timings = harTimings(req);

      const snapshot = {
        pageref: pageId,
        // Viewer matches same-frame responses first when resolving a URL.
        _frameref: req.frameId || mainFrameId,
        // The request's start offset, used for both the "most recent response
        // at this instant" lookup and the waterfall's left edge.
        _monotonicTime: relTime(startedMs),
        // CDP's resource classification; drives the panel's type filter and, for
        // `websocket`, routes the row to the Messages tab.
        _resourceType: isWebSocket ? 'websocket' : (req.resourceType || 'other'),
        startedDateTime: new Date(startedMs).toISOString(),
        time: durationMs,
        request: {
          url: req.url,
          method: req.method || 'GET',
          httpVersion,
          cookies: [],
          queryString,
          headersSize: -1,
          bodySize: postData && postData.text ? postData.text.length : -1,
          headers: req.requestHeaders || [],
          postData
        },
        response: {
          status: req.status || 0,
          statusText: req.statusText || '',
          httpVersion,
          cookies: [],
          headers: req.responseHeaders || [],
          headersSize: -1,
          // A redirect hop names its successor here; the panel renders it as the
          // redirect target row. Official writes '' for a non-redirect.
          redirectURL: req.redirectURL || '',
          // The viewer shows `_transferSize > 0 ? _transferSize : bodySize`,
          // so both are written: the decoded size always, the wire size when
          // CDP reported one.
          bodySize: req.bodySize || 0,
          _transferSize: req.encodedLength || 0,
          content: {
            mimeType: req.mimeType || '',
            size: req.bodySize || 0,
            _sha1: req.bodyResource || undefined
          }
        },
        cache: {},
        timings
      };

      // A failed request names its cause here; official's own HAR export writes
      // exactly this field, and it is the only place the reason survives.
      if (req.errorText) snapshot.response._failureText = req.errorText;

      // Server address and TLS metadata. Official always emits `_serverPort`
      // alongside `serverIPAddress`, so the two travel together rather than
      // leaving a newer/older consumer to guess a port from a host. TLS details
      // are narrowed to the five fields official publishes.
      if (req.remoteIPAddress) {
        snapshot.serverIPAddress = req.remoteIPAddress;
        snapshot._serverPort = req.remotePort;
      }
      if (req.securityDetails) {
        snapshot._securityDetails = harSecurityDetails(req.securityDetails);
      }

      // WebSocket frames ride the handshake's entry as `_webSocketMessages`; the
      // Messages tab reads exactly this field (or a jsonl side-file). Frames are
      // already normalized to {type, time, opcode, data} in the service worker.
      if (isWebSocket && Array.isArray(req._webSocketMessages) && req._webSocketMessages.length) {
        snapshot._webSocketMessages = req._webSocketMessages;
      }

      yield JSON.stringify({ type: 'resource-snapshot', snapshot, pageId }) + '\n';
    }
  }

  try {
    await zip.addStream('trace.network', chunkLines(networkLines()));
  } catch (err) {
    throw new Error(`stream trace.network: ${err && err.message}`);
  }

  // ── resources ───────────────────────────────────────────────────────────────
  // Read back from IndexedDB one at a time; each value is an inline byte buffer,
  // so no Blob-handle I/O (which fails across service-worker restarts) happens.
  // A single resource is resident only until its zip entry is compressed.
  const resourceNames = await listResourceNames(session);

  let stored = 0;
  let missing = 0;
  for (const name of resourceNames) {
    let bytes;
    try {
      bytes = await readResource(session, name);
    } catch (err) {
      console.warn('[TraceGen] Could not read resource', name, err);
    }
    if (!bytes) { missing++; continue; }
    try {
      await zip.addStream(RESOURCE_PREFIX + name, [bytes]);
    } catch (err) {
      throw new Error(`stream resource ${name}: ${err && err.message}`);
    }
    stored++;
  }
  if (missing) console.warn(`[TraceGen] ${missing} resource(s) were unavailable`);
  console.log(`[TraceGen] Wrote ${stored} resource(s) into the archive`);

  const blob = zip.finish();

  return {
    id,
    blob,
    name: recording.name,
    url: recording.url,
    timestamp: nowWall,
    eventCount,
    size: blob.size
  };
}

export { generatePlaywrightTraceInBrowser, createSubtreeReferencer };
