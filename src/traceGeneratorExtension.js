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
    options: { viewport, deviceScaleFactor: scaleFactor, isMobile: false },
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
        javaScriptEnabled: true
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

        const beforeLines = await buildFrameLines(
          beforeName, event.beforeSnapshotIds, actionId, relTime(eventTime));
        for (const line of beforeLines) yield line;

        yield JSON.stringify({
          type: 'before',
          callId: actionId,
          startTime: relTime(eventTime),
          apiName: `${event.class || 'Page'}.${event.method || 'click'}`,
          class: event.class || 'Page',
          method: event.method || 'click',
          params: event.params || {},
          pageId,
          wallTime: eventTime,
          beforeSnapshot: beforeName,
          internal: {}
        }) + '\n';

        const actionLines = await buildFrameLines(
          actionName, event.actionSnapshotIds, actionId, relTime(eventTime));
        for (const line of actionLines) yield line;

        // A gated action snapshot must not leave a dangling inputSnapshot
        // reference behind: emit the input line only when the action stage
        // exists. point rides along so the viewer can pin the click position.
        if (actionLines.length > 0) {
          yield JSON.stringify({
            type: 'input', callId: actionId, inputSnapshot: actionName,
            ...(event.params && event.params.point ? { point: event.params.point } : {})
          }) + '\n';
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
        for (const line of afterLines) yield line;

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

        const attachments = [];
        for (const att of (event.attachments || [])) {
          if (!att.resource) continue;

          yield JSON.stringify({
            type: 'screencast-frame',
            pageId,
            sha1: att.resource,
            width: att.width || viewport.width,
            height: att.height || viewport.height,
            timestamp: snapTime,
            frameSwapWallTime: event.endTime || eventTime
          }) + '\n';

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
              for (const name of [`before@${actionId}`, `action@${actionId}`, `after@${actionId}`]) {
                // The synthetic DOM is built here rather than read from IDB: no
                // DOM snapshot exists at all for this action.
                const html = referencerFor(mainFrameId)(
                  neutralizeScripts(fallbackDom.html, name));
                yield JSON.stringify({
                  type: 'frame-snapshot',
                  snapshot: {
                    callId: actionId,
                    snapshotName: name,
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
                }) + '\n';
              }
              afterEvent.afterSnapshot = `after@${actionId}`;
            }
          }

          attachments.push({
            name: att.name || 'screenshot',
            contentType: att.contentType || 'image/jpeg',
            sha1: att.resource
          });
        }

        if (attachments.length > 0) afterEvent.attachments = attachments;
        yield JSON.stringify(afterEvent) + '\n';

      } else if (event.type === 'console') {
        yield JSON.stringify({
          type: 'event',
          time: relTime(eventTime),
          class: 'Page',
          method: 'console',
          params: {
            type: event.messageType || 'log',
            text: event.text || '',
            location: event.location || { url: '', lineNumber: 0, columnNumber: 0 }
          },
          pageId,
          internal: {}
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
      if (!req.url || !req.url.startsWith('http')) continue;

      const postData = req.postDataSha1
        ? { _sha1: req.postDataSha1 }
        : (req.postDataText != null ? { text: req.postDataText } : undefined);

      yield JSON.stringify({
        type: 'resource-snapshot',
        snapshot: {
          pageref: pageId,
          // Viewer matches same-frame responses first when resolving a URL.
          _frameref: req.frameId || mainFrameId,
          // Viewer picks the most recent response whose time is <= the snapshot
          // timestamp; without this the last response wins for every snapshot.
          _monotonicTime: relTime(req.timestamp || baseTime),
          startedDateTime: new Date(req.timestamp || baseTime).toISOString(),
          time: relTime(req.timestamp || baseTime),
          request: {
            url: req.url,
            method: req.method || 'GET',
            headers: req.requestHeaders || [],
            postData
          },
          response: {
            status: req.status || 0,
            statusText: req.statusText || '',
            headers: req.responseHeaders || [],
            content: {
              mimeType: req.mimeType || '',
              size: req.bodySize || 0,
              _sha1: req.bodyResource || undefined
            }
          }
        },
        pageId
      }) + '\n';
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
