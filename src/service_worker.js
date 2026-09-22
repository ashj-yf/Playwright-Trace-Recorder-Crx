import { generatePlaywrightTraceInBrowser } from './traceGeneratorExtension.js';
import {
  sha1Hex,
  putResource,
  putSnapshot,
  putEvent,
  putRequest,
  readRequest,
  putSession,
  listSessions,
  countEvents,
  countRequests,
  clearSession,
  sweepOrphanSessions,
  putTraceArchive,
  deleteTrace as deleteStoredTrace
} from './traceStore.js';

// Open the side panel automatically whenever the toolbar icon is clicked,
// mirroring the playwright-crx pattern.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/**
 * Memory budgets.
 *
 * Everything bulky (screenshots, response bodies, stylesheets, DOM snapshots)
 * AND the lightweight event/request log is written to IndexedDB as it is
 * captured, so the service worker heap only ever holds small counters. These
 * ceilings bound on-disk growth and protect against pathological pages.
 */
const LIMITS = {
  // CDP hands response bodies over whole; materializing one giant body (video,
  // download) would spike the heap regardless of every other bound, so a single
  // fetch is capped. Everything else is kept, JS included.
  maxSingleBodyBytes: 64 * 1024 * 1024,
  // Total network payload (response + post bodies) per recording.
  maxNetworkBytes: 256 * 1024 * 1024,
  // Post bodies smaller than this stay inline in the request record.
  maxInlinePostBytes: 64 * 1024,
  maxCssBytes: 32 * 1024 * 1024,
  maxSnapshotBytes: 256 * 1024 * 1024,
  maxScreenshotBytes: 64 * 1024 * 1024,
  // The continuous screencast is what makes the viewer's filmstrip move; it is
  // the one capture stream that runs for the whole recording, so it gets its own
  // budget instead of competing with the per-action screenshots.
  maxScreencastBytes: 128 * 1024 * 1024,
  // Distinct network requests tracked.
  maxTrackedRequests: 3000,
  // WebSocket frames retained per socket. The Messages tab renders every frame,
  // so an unbounded socket would grow the record without bound; a frame past
  // this cap is dropped (and counted), not the socket itself.
  maxWebSocketFrames: 5000,
  // A single WebSocket frame larger than this is dropped: text/binary frames
  // can be megabytes, and each is stored inline in the request record.
  maxWebSocketFrameBytes: 256 * 1024,
  // Hard ceiling on recorded events.
  maxEvents: 20000,
  // Screencast frames are capped separately: at ~15 fps they would race through
  // maxEvents within minutes and, because that counter also gates action-stage
  // snapshots, a long recording would silently lose snapshot detail.
  maxScreencastFrames: 60000,
  // Actions may arrive faster than snapshots can be captured; beyond this depth
  // actions are still recorded but without DOM snapshots.
  maxQueuedCaptures: 4
};

/**
 * Screencast capture parameters.
 *
 * These mirror the official recorder (playwright-core `server/screencast.js`
 * plus `server/chromium/crPage.js`): frames are deliberately downsampled. The
 * screencast is a coarse "what was on screen" track that the viewer draws as a
 * filmstrip; the full-detail record is the DOM snapshot. Keeping every frame at
 * device resolution instead produced ~150 KB frames at ~1.5 fps — both heavier
 * and far less smooth than the official's ~3.6 KB at ~15 fps.
 *
 * The reference recorder caps the longest edge to 800 CSS px at jpeg quality 90.
 */
const SCREENCAST_LONG_EDGE = 800;
const SCREENCAST_QUALITY = 90;
// Guards against a truncated/empty payload being hashed and written as a
// "frame". A real jpeg frame is orders of magnitude larger.
const SCREENCAST_MIN_FRAME_BYTES = 256;

/**
 * Frame-rate policy, mirroring the official recorder's throttling.
 *
 * CDP pushes frames as fast as the page repaints (~60 fps). Keeping all of them
 * is untenable — measured on an animating page, a 5.5 s clip produced 258 frames
 * at ~34 KB each, about 90 MB per minute, against ~180 KB for a comparable
 * official trace. So frames are DROPPED, never delayed.
 *
 * The official recorder (playwright-core `tracing.js`) keeps roughly one frame
 * per `throttledRate` (200 ms) while the page is static, then runs unthrottled
 * for `unthrottleDuration` (500 ms) around every action. That is what makes an
 * action read as motion while a quiet stretch costs almost nothing. Both halves
 * matter: throttling alone would make actions choppy, and never throttling is
 * the 90 MB/min case above.
 *
 * The ack is always sent, even for a dropped frame: withholding it throttles
 * CDP itself, and a frame left unacked stalls the stream permanently.
 */
const SCREENCAST_THROTTLE_MS = 200;
const SCREENCAST_UNTHROTTLE_MS = 500;

/**
 * Keep every frame for a short window around an action.
 *
 * Mirrors the official `_temporarilyDisableThrottling`, which it calls on the
 * before/input/after call of every action.
 */
function unthrottleScreencast(rec) {
  if (!rec) return;
  rec.screencastUnthrottledUntil = Date.now() + SCREENCAST_UNTHROTTLE_MS;
}

let activeRecording = null;

// Actions are serialized through this chain so a burst of clicks or keystrokes
// cannot fan out into unbounded concurrent snapshot captures.
let captureChain = Promise.resolve();
let captureQueueDepth = 0;

// ── Port registry ─────────────────────────────────────────────────────────────
const panelPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ventriloquist-panel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  port.postMessage({
    type: 'RECORDING_STATUS',
    recording: !!activeRecording,
    currentRecording: activeRecording ? { name: activeRecording.name } : null
  });
});

function broadcastToPanel(message) {
  for (const p of panelPorts) {
    try { p.postMessage(message); } catch (_) { panelPorts.delete(p); }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Ventriloquist Standalone installed/updated');
});

console.log('Ventriloquist Standalone Service Worker running');

// Finalize recordings the worker never got to export (worker killed, browser
// closed), and sweep rows left by older versions. Recovery is serialized: a
// sweep started by a previous SW wake must finish before a new recording's
// session row exists, or the sweep could mistake the live session for an orphan.
let recoveryChain = Promise.resolve();
function recoverOrphanSessions(keepSession = null) {
  const run = recoveryChain.then(() => runRecovery(keepSession));
  recoveryChain = run.then(() => {}, () => {});
  return run;
}
recoverOrphanSessions().catch(err => console.warn('Could not recover stale sessions:', err));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Reads a JPEG's intrinsic pixel size from its SOF marker.
 *
 * The CDP screenshot response carries only the encoded bytes, so the real
 * dimensions have to come out of the file. Header-only scan, no decoding.
 *
 * @param {Uint8Array} bytes A complete JPEG.
 * @returns {{width:number, height:number}|null} null when unparseable.
 */
function jpegSize(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;                                    // past SOI
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }   // resynchronise on marker prefix
    const marker = bytes[i + 1];
    // Start-of-frame markers carry the dimensions; DHT/JPG/DAC sit in the same
    // numeric range but are not frames.
    if (marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8]
      };
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length <= 0) break;                     // malformed; avoid a spin
    i += 2 + length;
  }
  return null;
}

/** Device pixel ratio, defaulting to 1 when the page never reported one. */
function deviceScaleFactor(rec) {
  const dsf = rec && rec.deviceScaleFactor;
  return Number.isFinite(dsf) && dsf > 0 ? dsf : 1;
}

function base64ToUint8Array(base64) {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return bytes;
}

function shortId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

/** Keep IndexedDB writes awaitable so stopRecording can drain them. */
function track(rec, promise) {
  rec.pendingWrites.add(promise);
  promise.catch(() => {}).then(() => rec.pendingWrites.delete(promise));
  return promise;
}

async function drainPendingWrites(rec) {
  // Writes can enqueue more writes, so loop until the set stays empty.
  for (let i = 0; i < 10 && rec.pendingWrites.size > 0; i++) {
    await Promise.allSettled([...rec.pendingWrites]);
  }
}

function isQuotaError(err) {
  return err && (err.name === 'QuotaExceededError' || err.name === 'ConstraintError');
}

/**
 * Store a content-addressed resource and register it with the recording.
 * Returns the resource name, or null when a budget or quota was exhausted.
 */
async function storeResource(rec, bytes, extension, budgetKey, budgetLimit) {
  if (!bytes || bytes.byteLength === 0) return null;
  if (rec.bytes[budgetKey] + bytes.byteLength > budgetLimit) {
    rec.dropped[budgetKey]++;
    return null;
  }
  let name;
  try {
    name = (await sha1Hex(bytes)) + (extension || '');
  } catch (err) {
    console.warn('Could not hash resource:', err.message);
    return null;
  }
  if (rec.resourceNames.has(name)) return name;  // identical payload already stored
  try {
    const written = await putResource(rec.session, name, bytes);
    rec.resourceNames.add(name);
    if (written) rec.bytes[budgetKey] += bytes.byteLength;
  } catch (err) {
    if (isQuotaError(err)) notifyLimit(rec, 'browser storage quota');
    else console.warn('Could not store resource:', err.message);
    return null;
  }
  return name;
}

// ── Recording lifecycle ───────────────────────────────────────────────────────

/**
 * Viewport-capped screencast frame size, in CSS pixels.
 *
 * Mirrors the official recorder: scale the viewport down so its longest edge is
 * at most SCREENCAST_LONG_EDGE, then round to even numbers (CDP adjusts odd
 * dimensions silently, which would desync the declared size from the pixels).
 */
function screencastSize(rec) {
  const vp = rec.viewport || { width: 1280, height: 720 };
  const longest = Math.max(vp.width || 1, vp.height || 1);
  const scale = Math.min(1, SCREENCAST_LONG_EDGE / longest);
  return {
    width: Math.max(2, Math.floor((vp.width || 2) * scale) & ~1),
    height: Math.max(2, Math.floor((vp.height || 2) * scale) & ~1)
  };
}

/**
 * Begin the continuous screencast.
 *
 * This is the one capture stream that runs for the whole recording, and it is
 * what the viewer's filmstrip and canvas repaint are drawn from. Capturing a
 * screenshot per action instead (the previous approach) produced frames only at
 * action boundaries: 1.5 fps over a session, versus ~15 fps here.
 */
async function startScreencast(rec) {
  if (!rec.debuggeeTabId || rec.screencastActive) return;
  const { width, height } = screencastSize(rec);
  try {
    await cdpSend(rec, '', 'Page.startScreencast', {
      format: 'jpeg',
      quality: SCREENCAST_QUALITY,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1
    });
    rec.screencastActive = true;
    rec.screencastMax = { width, height };
    console.log(`Screencast started (max ${width}x${height})`);
  } catch (e) {
    console.warn('Could not start screencast:', e.message);
  }
}

/** Stop the stream; frames already in flight are drained by screencastChain. */
async function stopScreencast(rec) {
  if (!rec.debuggeeTabId || !rec.screencastActive) return;
  rec.screencastActive = false;
  try {
    await cdpSend(rec, '', 'Page.stopScreencast');
    console.log(`Screencast stopped after ${rec.screencastFrames} frames`);
  } catch (e) {
    console.warn('Could not stop screencast:', e.message);
  }
}

/**
 * Persist one screencast frame and append its `screencast-frame` line.
 *
 * CDP will not send the next frame until the previous one is acked, so the ack
 * is the backpressure valve: it is only sent once the bytes are in IndexedDB.
 * Acking first would let frames pile up in the worker heap under load, which is
 * exactly what `maxQueuedCaptures` exists to prevent elsewhere.
 *
 * @param {Object} rec Recording state.
 * @param {Object} params CDP Page.screencastFrame params.
 */
function handleScreencastFrame(rec, params) {
  // Throttle decision, made synchronously before anything is queued: the
  // unthrottled window around an action must be judged against the moment the
  // frame arrived, not the moment the write chain gets to it.
  const now = Date.now();
  const unthrottled = now < (rec.screencastUnthrottledUntil || 0);
  if (!unthrottled && now - (rec.screencastLastKept || 0) < SCREENCAST_THROTTLE_MS) {
    // Dropped for rate. The ack still goes out immediately — CDP sends exactly
    // one frame at a time, so a withheld ack would stop the stream rather than
    // slow it.
    rec.dropped.screencastThrottled++;
    if (rec.debuggeeTabId) {
      cdpSend(rec, '', 'Page.screencastFrameAck', { sessionId: params.sessionId })
        .catch(() => {});
    }
    return;
  }
  rec.screencastLastKept = now;

  // Serialize: the ack for frame N must not be sent before frame N is written,
  // and two frames must not interleave their IndexedDB writes.
  rec.screencastChain = rec.screencastChain
    .then(() => storeScreencastFrame(rec, params))
    .catch(err => console.warn('Screencast frame failed:', err.message))
    .then(() => {
      // Release the next frame only after this one is durable. A frame dropped
      // by a budget still gets acked, or the stream would stall permanently.
      if (rec.debuggeeTabId) {
        cdpSend(rec, '', 'Page.screencastFrameAck', { sessionId: params.sessionId })
          .catch(() => {});
      }
    });
}

async function storeScreencastFrame(rec, params) {
  const meta = params.metadata || {};
  const base64 = params.data || '';
  if (!base64) return;

  const bytes = base64ToUint8Array(base64);
  if (bytes.byteLength < SCREENCAST_MIN_FRAME_BYTES) return;

  const name = await storeResource(
    rec, bytes, '.jpeg', 'screencast', LIMITS.maxScreencastBytes);
  if (!name) return;

  // `frameSwapWallTime` is the page's own frame-presentation instant, and the
  // viewer pairs a snapshot to a frame by exactly this field. CDP reports it in
  // seconds since the epoch; the viewer compares it against a millisecond
  // `wallTime`, so the unit must be converted here.
  const swapWallTime = meta.timestamp
    ? meta.timestamp * 1000
    : Date.now();

  // Declare the frame's real pixel size, read back from the JPEG header rather
  // than assumed from the requested cap: CDP scales to fit `maxWidth`/
  // `maxHeight` while preserving aspect ratio, so the encoded frame is often
  // smaller than the requested box.
  const dims = jpegSize(bytes) || rec.screencastMax || { width: 0, height: 0 };

  rec.screencastFrames++;

  // Screencast lines do not go through the shared event ceiling: at ~15 fps a
  // long recording would exhaust maxEvents, and that same counter decides
  // whether an action may keep its action-stage snapshot — so the filmstrip
  // would silently starve the DOM record.
  if (rec.screencastFrames > LIMITS.maxScreencastFrames) {
    rec.dropped.screencast++;
    return;
  }
  try {
    // Both instants are stored absolute, like every other event; the exporter
    // rebases them onto the trace's own zero. A frame can be the very first
    // event of a recording, and it is then what defines that zero — a relative
    // value here would make every later timestamp meaningless.
    await putEvent(rec.session, {
      type: 'screencast-frame',
      pageId: 'page1',
      sha1: name,
      width: dims.width,
      height: dims.height,
      frameSwapWallTime: swapWallTime,
      timestamp: swapWallTime
    });
  } catch (err) {
    console.warn('Could not persist screencast frame:', err.message);
    if (isQuotaError(err)) notifyLimit(rec, 'browser storage quota');
  }
}

// ── Recording lifecycle ───────────────────────────────────────────────────────

function createRecording(name, tabId) {
  return {
    session: crypto.randomUUID(),
    name,
    startTime: Date.now(),
    mainFrameId: 'frame@' + shortId(),
    mainCdpFrameId: null,
    debuggeeTabId: tabId || null,
    url: null,
    viewport: null,
    // Device pixel ratio reported by the page; reconciles the CSS-pixel
    // viewport with device-pixel screencast frames at export time.
    deviceScaleFactor: null,
    // The page's own locale and time zone, read once from the first frame that
    // reports them. Exported in the trace's context-options so the archive
    // records the environment it was captured under.
    locale: null,
    timezoneId: null,

    // ── Frame registry (multi-frame capture) ──
    // cdpFrameId -> entry:
    //   {cdpFrameId, ourFrameId, sessionId, parentCdp, ownerIndex, url, main,
    //    contextId}
    // Same-process frames (same-origin iframes) share the main CDP session and
    // are evaluated through their default execution context (contextId);
    // out-of-process iframes get their own flattened session.
    frames: new Map(),
    // flattened CDP sessionId <-> cdpFrameId (OOPIF targets only)
    frameBySession: new Map(),
    sessionByCdp: new Map(),
    // `${sessionId}|${cdpFrameId}` -> default execution context id
    contexts: new Map(),
    liveSessions: new Set(),
    workerSessions: new Set(),
    attachJobs: new Set(),

    // href -> resource name, so each stylesheet is fetched once per recording.
    cssRefs: new Map(),
    cssFailed: new Set(),
    // href -> {sessionId, requestId} for Network.getResponseBody fallback.
    cssRequestIds: new Map(),
    resourceNames: new Set(),

    // WebSocket state, keyed by the CDP requestId of the handshake. The handshake
    // is itself an ordinary Network.requestWillBeSent, and the frames arrive as
    // separate webSocket* events carrying the same id, so the frames are folded
    // onto the already-tracked request record.
    wsByRequestId: new Map(),

    // Per-frame last after-snapshot ids: ourFrameId -> snapshot id.
    lastSnapshotIds: {},

    // ── Continuous screencast ──
    // The viewer's filmstrip is drawn from `screencast-frame` lines, which the
    // official recorder emits continuously for the whole session. Frames are
    // written to IndexedDB through this chain so the ack that releases the next
    // frame never overtakes the write of the current one.
    screencastChain: Promise.resolve(),
    screencastFrames: 0,
    screencastActive: false,
    screencastMax: null,
    // Frame-rate policy state: when the unthrottled window ends, and when the
    // last frame was actually kept (see handleScreencastFrame).
    screencastUnthrottledUntil: 0,
    screencastLastKept: 0,

    // Counters only; the log itself lives in IndexedDB.
    eventCount: 0,
    trackedRequestCount: 0,
    bytes: { network: 0, css: 0, snapshots: 0, screenshots: 0, screencast: 0 },
    dropped: {
      network: 0, oversize: 0, css: 0, snapshots: 0, screenshots: 0,
      events: 0, requests: 0, postData: 0, actionSnapshots: 0, screencast: 0,
      screencastThrottled: 0, webSocketFrames: 0
    },
    pendingWrites: new Set(),
    // All request-record mutations serialize through this chain so get/merge/put
    // for the same requestId can never race.
    requestChain: Promise.resolve(),
    limitNotified: false
  };
}

function sessionInfo(rec) {
  return {
    session: rec.session,
    name: rec.name,
    startTime: rec.startTime,
    mainFrameId: rec.mainFrameId,
    url: rec.url,
    viewport: rec.viewport,
    deviceScaleFactor: rec.deviceScaleFactor,
    locale: rec.locale,
    timezoneId: rec.timezoneId,
    screencastFrames: rec.screencastFrames,
    cssRefs: [...rec.cssRefs.entries()]
  };
}

function persistSession(rec) {
  track(rec, putSession(sessionInfo(rec)).catch(err =>
    console.warn('Could not persist session info:', err.message)));
}

async function startRecording(name, tabId) {
  if (activeRecording) {
    throw new Error('Already recording');
  }

  const rec = createRecording(name, tabId);
  activeRecording = rec;
  captureChain = Promise.resolve();
  captureQueueDepth = 0;
  pendingFill = null;
  console.log(`Recording started: ${name} (tabId=${tabId}, session=${rec.session})`);

  // Make sure no boot-time recovery/sweep is still scanning the stores before
  // this session's rows exist (recovery is serialized).
  await recoveryChain.catch(() => {});
  await putSession(sessionInfo(rec)).catch(() => {});
  await recoverOrphanSessions(rec.session).catch(() => {});

  if (tabId) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      console.log(`Debugger attached to tab ${tabId}`);
    } catch (e) {
      console.warn('Could not attach debugger:', e.message);
      rec.debuggeeTabId = null;
    }
    if (rec.debuggeeTabId) {
      // Flattened auto-attach gives a CDP session per frame (including OOPIFs),
      // which is what makes iframe snapshots possible.
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true
        });
      } catch (e) {
        console.warn('Could not enable target auto-attach:', e.message);
      }

      // Enable CDP domains independently — a failed domain should not kill the session
      for (const domain of ['Network', 'Page', 'Runtime', 'Log', 'DOM']) {
        try {
          await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
        } catch (e) {
          console.warn(`Failed to enable ${domain} domain:`, e.message);
        }
      }

      // The frame tree (same-process iframes included) is synced from
      // Page.getFrameTree before every snapshot capture.

      // Reload the page so all network requests flow through CDP.
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Page.reload', { ignoreCache: false });
        await new Promise(r => setTimeout(r, 2000));
        console.log('Page reloaded to capture network resources');
      } catch (e) {
        console.warn('Could not reload page:', e.message);
      }
    }
  }

  if (rec.debuggeeTabId) {
    const initial = await captureDomSnapshot(rec);
    for (const [fid, snap] of Object.entries(initial)) {
      rec.lastSnapshotIds[fid] = snap.id;
      if (fid === rec.mainFrameId) {
        rec.url = snap.url || rec.url;
        rec.viewport = snap.viewport || rec.viewport;
      }
    }
    persistSession(rec);
    // Start last: the frame size is derived from the viewport, which only the
    // first snapshot knows.
    await startScreencast(rec);
  }

  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STARTED' });
    } catch (_) {
      // Content script unresponsive — stale context after extension reload.
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => { window._ventriloquistInjected = false; }
        });
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ['src/content.js']
        });
      } catch (e) {
        console.warn('Could not re-inject content script:', e.message);
      }
    }
  }

  broadcastToPanel({
    type: 'RECORDING_STARTED',
    recording: true,
    currentRecording: { name }
  });
}

async function stopRecording() {
  if (!activeRecording) {
    throw new Error('Not recording');
  }

  // Settle an open typing burst and let queued captures run while the debugger
  // is still attached and the recording is still active, so the final Page.fill
  // action lands with real snapshots instead of being dropped by the guards.
  settlePendingFill('stop');
  try { await captureChain; } catch (_) {}

  // Stop the stream before detaching: with the debugger gone the frames can no
  // longer be acked, so any still in flight would be lost silently.
  await stopScreencast(activeRecording);

  const recording = activeRecording;
  activeRecording = null;
  console.log(`Recording stopped: ${recording.name}`);

  // The final frames are mid-write when the stream stops; drain that chain
  // before the session is archived, or the tail of the filmstrip goes missing.
  try { await recording.screencastChain; } catch (_) {}

  if (recording.debuggeeTabId) {
    try {
      await chrome.tabs.sendMessage(recording.debuggeeTabId, { type: 'RECORDING_STOPPED' });
    } catch (_) { /* tab may have navigated away */ }
    try {
      await chrome.debugger.detach({ tabId: recording.debuggeeTabId });
      console.log(`Debugger detached from tab ${recording.debuggeeTabId}`);
    } catch (e) {
      console.warn('Could not detach debugger:', e.message);
    }
  }

  broadcastToPanel({ type: 'RECORDING_STOPPED', recording: false });

  // Let in-flight snapshot captures, network tasks and resource writes land.
  try { await captureChain; } catch (_) {}
  await recording.requestChain.catch(() => {});
  await drainPendingWrites(recording);

  logRecordingStats(recording);

  try {
    await saveTraceLocally(recording);
    broadcastToPanel({ type: 'TRACE_SAVED', name: recording.name });
  } catch (error) {
    console.error('Error saving recording:', error);
    broadcastToPanel({ type: 'TRACE_ERROR', error: error.message });
    throw error;
  } finally {
    // Recording rows have been folded into the archive — reclaim the space.
    await clearSession(recording.session).catch(err =>
      console.warn('Could not clear recording session:', err));
  }
}

function logRecordingStats(rec) {
  const mb = n => (n / (1024 * 1024)).toFixed(1) + ' MB';
  console.log(
    `[Recording] ${rec.eventCount} events, ` +
    `snapshots ${mb(rec.bytes.snapshots)}, network ${mb(rec.bytes.network)}, ` +
    `css ${mb(rec.bytes.css)}, screenshots ${mb(rec.bytes.screenshots)}, ` +
    `screencast ${mb(rec.bytes.screencast)} (${rec.screencastFrames} frames), ` +
    `${rec.resourceNames.size} resources, ${rec.frames.size} frames`
  );
  const dropped = Object.entries(rec.dropped).filter(([, v]) => v > 0);
  // Rate-limited frames are ordinary operation, not a degraded capture: the
  // policy deliberately keeps only ~5 fps while the page is static. Reporting
  // them as "limits hit" would cry wolf on every healthy recording.
  const throttled = rec.dropped.screencastThrottled;
  const limited = dropped.filter(([k]) => k !== 'screencastThrottled');
  if (throttled > 0) {
    console.log(`[Recording] Screencast rate-limited ${throttled} frame(s) while idle ` +
      `(kept ${rec.screencastFrames})`);
  }
  if (limited.length) {
    console.warn('[Recording] Budget limits hit:',
      limited.map(([k, v]) => `${k}=${v}`).join(', '));
  }
}

function notifyLimit(rec, what) {
  if (rec.limitNotified) return;
  rec.limitNotified = true;
  broadcastToPanel({
    type: 'RECORDING_LIMIT',
    message: `Capture budget reached (${what}); continuing with reduced detail.`
  });
}

// ── Crash recovery ────────────────────────────────────────────────────────────

/**
 * Finalize sessions a dead worker left behind. A session with captured events
 * or requests is exported as a "(recovered)" trace; empty ones are deleted.
 * `keepSession` is the recording that just started and must not be touched.
 */
async function runRecovery(keepSession = null) {
  let infos;
  try {
    infos = await listSessions();
  } catch (err) {
    console.warn('Could not list sessions for recovery:', err.message);
    return;
  }
  for (const info of infos) {
    if (!info || info.session === keepSession) continue;
    let eventCount = 0;
    let requestCount = 0;
    try {
      [eventCount, requestCount] = await Promise.all([
        countEvents(info.session), countRequests(info.session)
      ]);
    } catch (_) { /* rows unreadable — fall through to cleanup */ }

    if (eventCount === 0 && requestCount === 0) {
      await clearSession(info.session).catch(() => {});
      continue;
    }

    try {
      console.log(`[Recovery] finalizing orphan session ${info.session} ` +
        `(events=${eventCount}, requests=${requestCount})`);
      const pseudo = {
        session: info.session,
        name: info.name || 'Recording',
        startTime: info.startTime || Date.now(),
        url: info.url || null,
        viewport: info.viewport || null,
        deviceScaleFactor: info.deviceScaleFactor || null,
        mainFrameId: info.mainFrameId || ('frame@' + (info.session || '').replace(/-/g, '').slice(0, 8)),
        cssRefs: new Map(info.cssRefs || []),
        recovered: true
      };
      const traceInfo = await generatePlaywrightTraceInBrowser(pseudo);
      await putTraceArchive(
        {
          id: traceInfo.id,
          name: traceInfo.name,
          url: traceInfo.url,
          timestamp: traceInfo.timestamp,
          size: traceInfo.size
        },
        traceInfo.blob
      );
      await appendTraceMetadata(traceInfo, `${info.name || 'Recording'} (recovered)`);
      console.log(`Recovered unsaved recording "${info.name}" as trace ${traceInfo.id}`);
    } catch (err) {
      console.warn(`Could not recover session ${info.session}:`, err.message);
    } finally {
      await clearSession(info.session).catch(() => {});
    }
  }

  // Rows left by pre-v2 versions have no session record at all.
  await sweepOrphanSessions(keepSession).catch(err =>
    console.warn('Could not sweep orphan sessions:', err.message));
}

// ── Message handling ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START_RECORDING':
      startRecording(message.name, message.tabId).then(() => {
        sendResponse({ success: true, recording: true });
      }).catch(err => {
        console.error('Error starting recording:', err);
        activeRecording = null;
        sendResponse({ success: false, error: err.message });
      });
      return true;

    case 'STOP_RECORDING':
      stopRecording().then(() => {
        sendResponse({ success: true, recording: false });
      }).catch(err => {
        console.error('Error stopping recording:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true;

    case 'GET_RECORDING_STATUS':
      sendResponse({
        recording: !!activeRecording,
        currentRecording: activeRecording ? { name: activeRecording.name } : null
      });
      return true;

    case 'RECORD_EVENT':
      enqueueAction(message.event);
      broadcastToPanel({
        type: 'EVENT_CAPTURED',
        eventType: message.event && message.event.type,
        selector: message.event && message.event.selector
      });
      sendResponse({ success: true });
      return true;

    case 'GET_LOCAL_TRACES':
      chrome.storage.local.get('local_traces').then(({ local_traces = [] }) => {
        sendResponse({ traces: local_traces });
      }).catch(err => {
        sendResponse({ error: err.message });
      });
      return true;

    case 'GET_LEGACY_TRACE_ZIP': {
      // Traces recorded before archives moved to IndexedDB are still base64 in
      // chrome.storage.local. The panel falls back to this for them.
      const key = `trace_zip_${message.id}`;
      chrome.storage.local.get(key).then((result) => {
        sendResponse({ zipBase64: result[key] || null });
      }).catch(err => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    case 'DELETE_TRACE':
      chrome.storage.local.get('local_traces').then(async ({ local_traces = [] }) => {
        const updated = local_traces.filter(t => t.id !== message.id);
        await deleteStoredTrace(message.id).catch(() => {});
        // Legacy traces were kept as base64 in chrome.storage.local.
        await chrome.storage.local.remove(`trace_zip_${message.id}`);
        await chrome.storage.local.set({ local_traces: updated });
        sendResponse({ success: true });
        broadcastToPanel({ type: 'TRACES_UPDATED', traces: updated });
      }).catch(err => {
        sendResponse({ error: err.message });
      });
      return true;

    case 'GET_ACTIVE_TAB':
      chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
        sendResponse({ tabId: tab ? tab.id : null });
      }).catch(() => sendResponse({ tabId: null }));
      return true;

    case 'GET_MANIFEST_VERSION':
      sendResponse({ version: chrome.runtime.getManifest().version });
      return true;

    case 'open_side_panel': {
      const tabId = sender.tab?.id;
      if (!tabId) {
        console.warn('[Playwright Trace Recorder] No tab ID in sender for open_side_panel');
        sendResponse({ success: false, error: 'No tab ID' });
        return true;
      }
      (async () => {
        try {
          await chrome.sidePanel.open({ tabId });
          console.log('[Playwright Trace Recorder] ✅ Side panel opened for tab:', tabId);
          sendResponse({ success: true });
        } catch (err) {
          console.warn('[Playwright Trace Recorder] ❌ Failed to open side panel:', err.message);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// ── Trace persistence ─────────────────────────────────────────────────────────

async function appendTraceMetadata(traceInfo, displayName) {
  const { local_traces = [] } = await chrome.storage.local.get('local_traces');
  local_traces.unshift({
    id: traceInfo.id,
    name: displayName,
    url: traceInfo.url,
    timestamp: traceInfo.timestamp,
    eventCount: traceInfo.eventCount,
    size: traceInfo.size
  });

  // Keep at most 50 traces to avoid unbounded storage growth
  const evicted = local_traces.splice(50);
  for (const trace of evicted) {
    await deleteStoredTrace(trace.id).catch(() => {});
    await chrome.storage.local.remove(`trace_zip_${trace.id}`).catch(() => {});
  }

  await chrome.storage.local.set({ local_traces });
}

async function saveTraceLocally(recording) {
  console.log('Generating trace ZIP in extension…');
  let traceInfo;
  try {
    traceInfo = await generatePlaywrightTraceInBrowser(recording);
  } catch (err) {
    throw new Error(`generate trace failed: ${err && err.message}`);
  }

  // Persist the archive in fixed-size slices (never the whole archive in the
  // worker heap), and as ArrayBuffer slices rather than Blobs: an IndexedDB
  // Blob's internal handle breaks after the service worker restarts and later
  // reads (the panel's Download) reject with "network error".
  try {
    await putTraceArchive(
      {
        id: traceInfo.id,
        name: traceInfo.name,
        url: traceInfo.url,
        timestamp: traceInfo.timestamp,
        size: traceInfo.size
      },
      traceInfo.blob
    );
  } catch (err) {
    throw new Error(`store trace archive: ${err && err.message}`);
  }

  try {
    await appendTraceMetadata(traceInfo, traceInfo.name);
  } catch (err) {
    throw new Error(`metadata: ${err && err.message}`);
  }

  console.log(`Trace "${recording.name}" saved locally (${traceInfo.size} bytes)`);

  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title: 'Playwright Trace Recorder',
    message: `Trace "${recording.name}" saved. Click Download to get the file.`
  }).catch(() => {});

  return traceInfo;
}

// ── CDP plumbing for flattened frame/worker sessions ──────────────────────────

// A command sent to a target that navigated away or stopped responding must not
// hang forever, or the capture/request chains (and therefore stopRecording)
// wedge permanently.
const CDP_COMMAND_TIMEOUT_MS = 30000;

function cdpSend(rec, sessionId, method, params = {}) {
  if (!rec.debuggeeTabId) return Promise.reject(new Error('No debuggee tab'));
  // In flat mode a child command carries its sessionId inside the params.
  const payload = sessionId ? { ...params, sessionId } : params;
  const command = chrome.debugger.sendCommand(
    { tabId: rec.debuggeeTabId }, method, payload);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`CDP ${method} timed out`)),
      CDP_COMMAND_TIMEOUT_MS);
  });
  return Promise.race([command, timeout]).finally(() => clearTimeout(timer));
}

const IFRAME_TARGET_TYPES = new Set(['iframe']);
const WORKER_TARGET_TYPES = new Set(['worker', 'shared_worker', 'service_worker']);

async function enableDomains(rec, sessionId, domains) {
  for (const domain of domains) {
    try {
      await cdpSend(rec, sessionId, `${domain}.enable`);
    } catch (e) {
      console.warn(`Failed to enable ${domain} on session ${sessionId || '(main)'}:`, e.message);
    }
  }
}

/**
 * Index of the iframe element owning `entry` inside its parent document.
 * The owner node lives in the PARENT frame's process, so the query runs on the
 * parent's CDP session ('' for the main frame / any same-process child).
 */
async function resolveOwnerIndex(rec, entry) {
  if (!entry.parentCdp) return null;
  const parent = rec.frames.get(entry.parentCdp);
  if (!parent) return null;
  try {
    const owner = await cdpSend(rec, parent.sessionId || '', 'DOM.getFrameOwner', {
      frameId: entry.cdpFrameId
    });
    if (!owner || owner.backendNodeId === undefined) return null;
    const resolved = await cdpSend(rec, parent.sessionId || '', 'DOM.resolveNode', {
      backendNodeId: owner.backendNodeId
    });
    const objectId = resolved && resolved.object && resolved.object.objectId;
    if (!objectId) return null;
    const result = await cdpSend(rec, parent.sessionId || '', 'Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      silent: true,
      functionDeclaration: `function(){
        var list = this.ownerDocument.querySelectorAll('iframe,frame');
        return Array.prototype.indexOf.call(list, this);
      }`
    });
    return typeof result.result.value === 'number' ? result.result.value : null;
  } catch (_) {
    return null;
  }
}

async function handleAttached(rec, sessionId, targetInfo) {
  if (!sessionId || rec.liveSessions.has(sessionId)) return;
  try {
    if (IFRAME_TARGET_TYPES.has(targetInfo && targetInfo.type)) {
      // OOPIF: it owns a flattened session. Same-process iframes never show up
      // here; they come from Page.getFrameTree + Runtime context events instead.
      await enableDomains(rec, sessionId, ['Network', 'Page', 'Runtime', 'Log', 'DOM']);
      rec.liveSessions.add(sessionId);
      rec.frameBySession.set(sessionId, targetInfo.targetId);
      rec.sessionByCdp.set(targetInfo.targetId, sessionId);
      const existing = rec.frames.get(targetInfo.targetId);
      if (existing) {
        existing.sessionId = sessionId;
        if (targetInfo.url) existing.url = targetInfo.url;
      }
    } else if (WORKER_TARGET_TYPES.has(targetInfo && targetInfo.type)) {
      await enableDomains(rec, sessionId, ['Network', 'Runtime', 'Log']);
      rec.liveSessions.add(sessionId);
      rec.workerSessions.add(sessionId);
    }
  } catch (e) {
    console.warn('Failed to set up attached target:', e.message);
  }
}

/**
 * Build/refresh the frame registry from the browser's authoritative frame tree.
 * The main session's Page.getFrameTree sees every frame (same-process children
 * and OOPIF nodes); flattened child sessions only add the sessionId mapping.
 */
async function syncFrameTree(rec) {
  let tree;
  try {
    tree = await cdpSend(rec, '', 'Page.getFrameTree');
  } catch (_) {
    return; // tab may be gone
  }
  const seen = new Set();
  const walk = (node, parentCdp) => {
    const f = node.frame;
    if (!f || !f.id) return;
    seen.add(f.id);
    let entry = rec.frames.get(f.id);
    if (!entry) {
      entry = {
        cdpFrameId: f.id,
        ourFrameId: f.parentId ? 'frame@' + shortId() : rec.mainFrameId,
        sessionId: rec.sessionByCdp.get(f.id) || '',
        contextId: rec.contexts.get(`|${f.id}`) || null,
        parentCdp,
        ownerIndex: undefined,
        url: f.url || '',
        main: !f.parentId
      };
      rec.frames.set(f.id, entry);
    } else {
      entry.parentCdp = parentCdp;
      entry.main = !f.parentId;
      if (f.url) entry.url = f.url;
      const sid = rec.sessionByCdp.get(f.id);
      if (sid) entry.sessionId = sid;
      if (!entry.contextId) {
        const ctx = rec.contexts.get(`|${f.id}`);
        if (ctx) entry.contextId = ctx;
      }
    }
    for (const child of node.childFrames || []) walk(child, f.id);
  };
  walk(tree.frameTree, null);

  // Drop frames that no longer exist (navigated away / closed).
  for (const cdpFrameId of [...rec.frames.keys()]) {
    if (!seen.has(cdpFrameId)) rec.frames.delete(cdpFrameId);
  }
}

/**
 * Refresh the frame registry before a snapshot: sync the tree, wait for the
 * default execution contexts of same-process child frames to be announced,
 * and resolve owner element indices.
 * @returns frame entries, main frame first
 */
async function refreshFrames(rec) {
  await Promise.allSettled([...rec.attachJobs]);
  await syncFrameTree(rec);

  // New same-process iframes announce a default execution context via
  // Runtime.executionContextCreated; give it a moment to arrive.
  const pending = [...rec.frames.values()]
    .filter(e => !e.main && !e.sessionId && !e.contextId);
  if (pending.length) {
    for (let attempt = 0; attempt < 10; attempt++) {
      let allReady = true;
      for (const entry of pending) {
        const ctx = rec.contexts.get(`|${entry.cdpFrameId}`);
        if (ctx) entry.contextId = ctx;
        else allReady = false;
      }
      if (allReady) break;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  for (const entry of [...rec.frames.values()]) {
    if (entry.main) continue;
    if (entry.ownerIndex === undefined || entry.ownerIndex === null) {
      const idx = await resolveOwnerIndex(rec, entry);
      if (idx !== null) entry.ownerIndex = idx;
    }
  }

  const entries = [...rec.frames.values()];
  entries.sort((a, b) => (a.main ? -1 : b.main ? 1 : 0));
  return entries;
}

/**
 * Evaluate an expression in one frame's default context: flattened child
 * session for OOPIFs, explicit contextId for same-process frames, plain
 * evaluate for the main frame.
 */
async function evaluateFrame(rec, entry, expression, awaitPromise = false) {
  const params = { expression, returnByValue: true, awaitPromise };
  const sessionId = entry.sessionId || '';
  if (!sessionId && !entry.main && entry.contextId) {
    params.contextId = entry.contextId;
  }
  const result = await cdpSend(rec, sessionId, 'Runtime.evaluate', params);
  return result && result.result ? result.result.value : null;
}

// ── DOM snapshots ─────────────────────────────────────────────────────────────

const PAGE_INFO_EXPR = `(function(){
  var urls = [], seen = {};
  function add(u){ if(u && !seen[u]){ seen[u] = 1; urls.push(u); } }
  var links = document.querySelectorAll('link[rel*="stylesheet"], link[rel="preload"][as="style"]');
  for (var i = 0; i < links.length; i++) add(links[i].href);
  for (var j = 0; j < document.styleSheets.length; j++) add(document.styleSheets[j].href);
  var dt = document.doctype;
  // The locale/timezone the page actually ran under. The recorder never emulates
  // them, so the page's own resolved values ARE the recording's environment —
  // which is what official records in these same two context-options fields.
  var tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  return JSON.stringify({
    url: window.location.href,
    doctype: dt ? dt.name : 'html',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    deviceScaleFactor: window.devicePixelRatio || 1,
    locale: navigator.language || '',
    timezoneId: tz,
    stylesheets: urls
  });
})()`;

/**
 * Serializes one frame's DOM into Playwright's NodeSnapshot form.
 *
 * Beyond plain elements it reproduces the viewer's own snapshot conventions:
 *  - `__playwright_value_` / `__playwright_checked_` / `__playwright_selected_`
 *    carry live form state (attributes alone hold only the default values),
 *  - `__playwright_scroll_top_` / `_left_` carry scroll offsets, so the viewer
 *    restores what was on screen instead of pinning every container to the top,
 *  - `__playwright_bounding_rect_` on canvas/iframe/frame, without which the
 *    viewer refuses to repaint a canvas from the screencast,
 *  - `__playwright_popover_open_` / `__playwright_dialog_open_` for overlay
 *    visibility that markup alone cannot express,
 *  - `__playwright_target__` on the element an action addressed, which the
 *    viewer outlines in the snapshot,
 *  - open Shadow DOM is encoded as a TEMPLATE[__playwright_shadow_root_] child,
 *  - constructable/adopted stylesheets travel as TEMPLATE[__playwright_style_sheet_],
 *  - iframe elements are tagged with the recorder frame id (`__pw_frame__`) and
 *    rewritten to the viewer's `/snapshot/<frame>/<name>` route at export time,
 *  - <style>/<script> text, which carries whole stylesheets or sources, is
 *    never capped like ordinary text nodes.
 *
 * @param {string} frameMapJson ownerIndex -> frame id map for child frames.
 * @param {string} fid This frame's recorder id.
 * @param {boolean} isMain Whether this is the main frame.
 * @param {string} [targetSelector] Selector of the element the action addressed.
 * @param {string} [targetCallId] callId to stamp on it (matches the snapshot line).
 */
function buildDomSnapshotExpr(frameMapJson, fid, isMain, targetSelector, targetCallId) {
  return `(function(){
  try{
    var MAX_NODES = 60000, MAX_TEXT = 5000, nodes = 0, truncated = false;
    var FRAME_MAP = ${frameMapJson};
    var FID = ${JSON.stringify(fid)};
    var MAIN = ${isMain ? 'true' : 'false'};
    var TARGET_SELECTOR = ${JSON.stringify(targetSelector || '')};
    var TARGET_CALL_ID = ${JSON.stringify(targetCallId || '')};
    var frameIdx = 0;
    // Mark the action's target so the serializer picks it up, and unmark it
    // afterwards: the expando lives on a live page element and would otherwise
    // leak a stale target into every later snapshot.
    var marked = null;
    if(TARGET_SELECTOR && TARGET_CALL_ID){
      try {
        var hits = document.querySelectorAll(TARGET_SELECTOR);
        if(hits.length === 1){ marked = hits[0]; marked.__playwright_target__ = TARGET_CALL_ID; }
      } catch(e){ marked = null; }
    }
    function unmarkTarget(){
      if(marked){ try { delete marked.__playwright_target__; } catch(e){} marked = null; }
    }
    function sheetText(sheet){
      var out = [], i;
      try {
        if(!sheet || !sheet.cssRules) return '';
        for(i = 0; i < sheet.cssRules.length; i++) out.push(sheet.cssRules[i].cssText);
      } catch(e) { return ''; }
      return out.join('\\n');
    }
    // textContent is the authored source and the primary reading; it is empty
    // for CSS-in-JS that only ever calls insertRule(), so fall back to cssRules.
    function styleText(el){
      var t = el.textContent || '';
      if(t.trim()) return t;
      return sheetText(el.sheet);
    }
    // Element state the viewer restores reactively. Mirrors the attribute set
    // playwright-core's snapshotterInjected writes, because snapshotRenderer
    // reads exactly these names: a missing marker is not a cosmetic loss —
    // canvases without a bounding rect are skipped outright, and a scroll
    // container without a scroll marker is pinned back to scrollTop 0.
    function applyLiveState(n, a){
      var tn = n.tagName;
      if(tn === 'INPUT'){
        var ty = (n.getAttribute('type') || '').toLowerCase();
        if(ty === 'checkbox' || ty === 'radio'){
          a['__playwright_checked_'] = n.checked ? 'true' : 'false';
        } else if(ty !== 'file' && ty !== 'submit' && ty !== 'button' && ty !== 'reset' && ty !== 'image'){
          a['__playwright_value_'] = n.value == null ? '' : String(n.value);
        }
      } else if(tn === 'TEXTAREA'){
        a['__playwright_value_'] = n.value == null ? '' : String(n.value);
      } else if(tn === 'OPTION'){
        a['__playwright_selected_'] = n.selected ? 'true' : 'false';
      }
      // Canvas contents are repainted from the screencast, but only when the
      // canvas carries where it sat on screen. iframe/frame carry it too: the
      // viewer accumulates these rects to place a nested frame's canvas.
      if(tn === 'CANVAS' || tn === 'IFRAME' || tn === 'FRAME'){
        try {
          var r = n.getBoundingClientRect();
          a['__playwright_bounding_rect_'] = JSON.stringify({
            left: r.left, top: r.top, right: r.right, bottom: r.bottom
          });
        } catch(e){}
      }
      // Scroll offset. Written only when non-zero, like the official recorder,
      // so unscrolled containers cost nothing.
      try {
        if(n.scrollTop) a['__playwright_scroll_top_'] = '' + n.scrollTop;
        if(n.scrollLeft) a['__playwright_scroll_left_'] = '' + n.scrollLeft;
      } catch(e){}
      // Popovers/dialogs are opened by script at runtime, so their visibility
      // cannot be inferred from markup alone.
      try {
        if(n.popover && n.matches && n.matches(':popover-open')){
          a['__playwright_popover_open_'] = 'true';
        }
        if(tn === 'DIALOG' && n.open){
          a['__playwright_dialog_open_'] = n.matches(':modal') ? 'modal' : 'true';
        }
      } catch(e){}
      // The element an action targeted, keyed by callId; the viewer outlines
      // every node matching the snapshot's own callId.
      try {
        if(n.__playwright_target__ != null && n.__playwright_target__ !== ''){
          a['__playwright_target__'] = String(n.__playwright_target__);
        }
      } catch(e){}
    }
    // Resource URLs must be absolute: the trace viewer serves resources by
    // exact absolute-URL string match, so a snapshot keeping "/img.png" can
    // never hit its resource table. Aligns with official snapshotterInjected.
    var KEEP_URL = /^(https?:|data:|blob:|about:|mailto:|tel:|sftp:|ftp:|ws:|wss:)/i;
    var JS_URL = /^\\s*(?:javascript|vbscript):/i;
    function sanitizeUrl(u){ if(u==null) return u; u=String(u); return JS_URL.test(u)?'':u; }
    function absolutize(u, base){
      if(u==null) return u; u=String(u).trim(); if(!u) return u;
      if(u.charAt(0)==='#') return u;
      if(KEEP_URL.test(u)) return sanitizeUrl(u);
      try{ return new URL(u, base).href; }catch(e){ return sanitizeUrl(u); }
    }
    function absolutizeSrcSet(v, base){
      if(!v) return v;
      return v.split(',').map(function(part){
        var t=part.trim(); if(!t) return '';
        var sp=t.lastIndexOf(' ');
        return sp===-1 ? absolutize(t,base) : absolutize(t.slice(0,sp),base)+t.slice(sp);
      }).join(', ');
    }
    function absolutizeCssUrls(text, base){   // inline style text and style attributes
      return String(text).replace(/url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/g, function(m,q,u){
        return 'url(' + absolutize(u, base) + ')';
      });
    }
    // Only string-typed IDL is accepted: HTML URL properties are already
    // absolute, while SVG's SVGAnimatedString (an object) falls back to
    // absolutize(). Keyed by attribute name so e.g. a video's poster never
    // picks up the element's (absolute) src value.
    function idlUrl(n, an){
      try{
        var v = (an === 'href' || an === 'src' || an === 'data') ? n[an] : null;
        if(typeof v === 'string' && v) return v;
      }catch(e){}
      return null;
    }
    function s(n,d){
      if(!n || d > 80) return null;
      if(nodes >= MAX_NODES){ truncated = true; return null; }
      if(n.nodeType === 3){
        var t = n.textContent; nodes++;
        if(t.length <= MAX_TEXT) return t;
        truncated = true;
        return t.slice(0, MAX_TEXT) + '\\u2026';
      }
      if(n.nodeType !== 1) return null;
      if(n.tagName === 'NOSCRIPT') return null;
      nodes++;
      var a = {}, i, ch = [], tn = n.tagName;
      var URL_ATTRS = { href:1, src:1, srcset:1, poster:1, data:1, 'xlink:href':1 };
      for(i = 0; i < n.attributes.length; i++){
        var an = n.attributes[i].name, av = n.attributes[i].value;
        if (an === 'style' && av && av.indexOf('url(') >= 0) { a[an] = absolutizeCssUrls(av, n.baseURI || document.baseURI); continue; }
        if (tn === 'IFRAME' || tn === 'FRAME') { a[an] = av; continue; }  // src is replaced by the #frameId/name route at export
        if (URL_ATTRS[an] !== 1) { a[an] = av; continue; }
        if (an === 'srcset') a[an] = absolutizeSrcSet(av, n.baseURI || document.baseURI);
        else if (an === 'xlink:href') a[an] = sanitizeUrl(absolutize(av, n.baseURI || document.baseURI));
        else { var idl = idlUrl(n, an); a[an] = sanitizeUrl(idl != null ? idl : absolutize(av, n.baseURI || document.baseURI)); }
      }
      // Script sources are retained (neutralized at export so they cannot run).
      if(tn === 'SCRIPT'){
        nodes++;
        return ['SCRIPT', a, n.textContent || ''];
      }
      if(tn === 'STYLE'){
        var css = absolutizeCssUrls(styleText(n), document.baseURI);
        nodes++;
        return css ? ['STYLE', a, css] : ['STYLE', a];
      }
      applyLiveState(n, a);
      // The URL the browser actually picked (srcset resolution included) — the
      // viewer promotes this marker to src and demotes the authored ones.
      if(tn === 'IMG' || tn === 'PICTURE'){
        var cs=''; try{ cs = n.currentSrc || ''; }catch(e){}
        a['__playwright_current_src__'] = sanitizeUrl(cs);
      }
      if(tn === 'IFRAME' || tn === 'FRAME'){
        var mapped = FRAME_MAP[frameIdx];
        if(mapped) a['__pw_frame__'] = mapped;
        frameIdx++;
      }
      for(i = 0; i < n.childNodes.length; i++){
        var c = s(n.childNodes[i], d + 1);
        if(c !== null) ch.push(c);
      }
      // Open shadow root: viewer attaches a fresh shadow root from this template.
      var sr = n.shadowRoot || null;
      if(sr){
        var sch = [], k;
        if(sr.adoptedStyleSheets){
          for(k = 0; k < sr.adoptedStyleSheets.length; k++){
            var stx = absolutizeCssUrls(sheetText(sr.adoptedStyleSheets[k]), document.baseURI);
            if(stx) sch.push(['STYLE', {}, stx]);
          }
        }
        for(k = 0; k < sr.childNodes.length; k++){
          var zc = s(sr.childNodes[k], d + 1);
          if(zc !== null) sch.push(zc);
        }
        if(sch.length) ch.push(['TEMPLATE', { '__playwright_shadow_root_': '' }].concat(sch));
      }
      var base = [tn, a];
      return ch.length ? base.concat(ch) : base;
    }
    function findTag(node, tag){
      if(!Array.isArray(node) || typeof node[0] !== 'string') return null;
      for(var i = 2; i < node.length; i++){
        if(Array.isArray(node[i]) && node[i][0] === tag) return node[i];
      }
      for(var j = 2; j < node.length; j++){
        var found = findTag(node[j], tag);
        if(found) return found;
      }
      return null;
    }
    var dt = document.doctype;
    var tree = s(document.documentElement, 0);
    unmarkTarget();
    if(!Array.isArray(tree)) return null;
    // Document-level adopted stylesheets: viewer replaces these via replaceSync.
    if(MAIN && document.adoptedStyleSheets && document.adoptedStyleSheets.length){
      var bodyNode = findTag(tree, 'BODY');
      if(bodyNode){
        for(var q = 0; q < document.adoptedStyleSheets.length; q++){
          var atx = absolutizeCssUrls(sheetText(document.adoptedStyleSheets[q]), document.baseURI);
          if(atx) bodyNode.push(['TEMPLATE', { '__playwright_style_sheet_': atx }]);
        }
      }
    }
    return JSON.stringify({
      doctype: dt ? dt.name : 'html',
      html: tree,
      url: window.location.href,
      frameId: FID,
      isMainFrame: MAIN,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      deviceScaleFactor: window.devicePixelRatio || 1,
      // Absolute capture instant. The emitted frame-snapshot's timestamp is a
      // relative offset, but the viewer pairs a snapshot with the screencast
      // frame that was on screen when it was taken by comparing wall clocks, so
      // this has to be a real epoch - as it is in the official recorder, which
      // stamps Date.now() in the page.
      wallTime: Date.now(),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      truncated: truncated
    });
  } catch(e){ unmarkTarget(); return null; }
})()`;
}

/**
 * Fetch stylesheet text for URLs we have not seen yet in this recording, store
 * it content-addressed, and remember the href -> resource mapping.
 *
 * Each stylesheet is fetched once per recording instead of once per snapshot.
 */
async function cacheStylesheets(rec, frame, hrefs) {
  if (!hrefs || hrefs.length === 0) return;
  const sessionId = frame.sessionId || '';

  for (const href of hrefs) {
    if (!href) continue;
    if (rec.cssRefs.has(href) || rec.cssFailed.has(href)) continue;
    if (rec.bytes.css >= LIMITS.maxCssBytes) {
      rec.dropped.css++;
      notifyLimit(rec, 'stylesheets');
      return;
    }

    let cssText = null;

    if (frame.cdpFrameId) {
      try {
        const res = await cdpSend(rec, sessionId, 'Page.getResourceContent', {
          frameId: frame.cdpFrameId, url: href
        });
        if (res && res.content) {
          cssText = res.base64Encoded ? atob(res.content) : res.content;
        }
      } catch (_) { /* try the next strategy */ }
    }

    if (!cssText) {
      const entry = rec.cssRequestIds.get(href);
      if (entry) {
        try {
          const body = await cdpSend(rec, entry.sessionId, 'Network.getResponseBody', {
            requestId: entry.requestId
          });
          if (body && body.body) {
            cssText = body.base64Encoded ? atob(body.body) : body.body;
          }
        } catch (_) { /* try the next strategy */ }
      }
    }

    if (!cssText) {
      try {
        cssText = await evaluateFrame(rec, frame, `(function(){
          return new Promise(function(resolve){
            var x = new XMLHttpRequest();
            x.onload = function(){ resolve(x.status >= 200 && x.status < 300 ? x.responseText : null); };
            x.onerror = function(){ resolve(null); };
            x.open('GET', ${JSON.stringify(href)});
            x.send();
          });
        })()`, true);
      } catch (_) { /* give up below */ }
    }

    if (!cssText) {
      rec.cssFailed.add(href);
      continue;
    }

    const bytes = new TextEncoder().encode(cssText);
    const name = await storeResource(rec, bytes, '.css', 'css', LIMITS.maxCssBytes);
    if (name) {
      rec.cssRefs.set(href, name);
      persistSession(rec);
    } else {
      rec.cssFailed.add(href);
    }
  }
}

/**
 * Waits until the page's DOM has stopped changing, so a snapshot taken right
 * after an action shows the settled result rather than a transitional frame.
 *
 * A click handler that starts framework work (re-render, fetch, animation)
 * returns long before that work lands. Playwright's own recorder sidesteps this
 * by capturing from the driver, which awaits the action; a CDP recorder never
 * sees that boundary, so it has to infer it from the DOM itself.
 *
 * Resolves as soon as the DOM has been mutation-free for SETTLE_SILENCE_MS,
 * counted from the first moment there is something to observe, with a hard
 * SETTLE_TIMEOUT_MS ceiling for a page that never stops mutating.
 *
 * Skipped when actions are already backed up: settling is a latency/accuracy
 * trade, and paying latency while behind makes the backlog worse — under load
 * the capture queue's own gate is what protects the recording. Settling then
 * applies exactly to the human-paced actions it was added for.
 *
 * @param {Object} rec Recorder state.
 * @returns {Promise<number|null>} The page's own reaction time in ms, or null
 *   when settling was skipped and no measurement was made. Never blocks a
 *   recording.
 */
async function settleDom(rec) {
  if (!rec.debuggeeTabId) return null;
  if (captureQueueDepth > 1) return null;   // another action is already waiting
  // Read the frame registry directly rather than through refreshFrames():
  // captureDomSnapshot() refreshes immediately afterwards, and the full refresh
  // can await frame attachment and owner-index resolution, which would make
  // every action pay for it twice.
  const main = mainFrameEntry(rec);
  if (!main) return null;
  try {
    const reaction = await evaluateFrame(rec, main, DOM_SETTLE_EXPR, true);
    return Number.isFinite(reaction) ? reaction : null;
  } catch (_) {
    return null;                            // settling is best-effort
  }
}

/** The main frame's registry entry, or null before the tree is known. */
function mainFrameEntry(rec) {
  for (const entry of rec.frames.values()) {
    if (entry.main) return entry;
  }
  return null;
}

// Quiet period for DOM_SETTLE_EXPR, and its hard ceiling.
const SETTLE_SILENCE_MS = 120;
const SETTLE_TIMEOUT_MS = 1200;

/**
 * Resolves with the page's own reaction time, in milliseconds.
 *
 * The resolved number is when the DOM last changed after the action (or when
 * the initial frame drain completed, if it never changed) — measured inside the
 * page, on the page's clock. That is the honest "how long did this action take"
 * value: the recorder's own settle window, snapshot capture and screenshot all
 * happen after it, and counting those would report the cost of *recording* the
 * action as if it were the cost of the action.
 *
 * Two frame drains run first, because the action's own handler may not have run
 * yet; observing from before it starts is what makes the quiet period mean
 * anything. A page that never mutates then settles after one quiet window, and
 * one that renders on a timer is bounded by the ceiling.
 */
const DOM_SETTLE_EXPR = `(function(){
  return new Promise(function(resolve){
    var SILENCE = ${SETTLE_SILENCE_MS}, CEILING = ${SETTLE_TIMEOUT_MS};
    var done = false, quietTimer = null, hardTimer = null, observer = null;
    var t0 = performance.now();
    // -1 until something is observed; a page with no observer is not a
    // reaction, so it reports 0 rather than the settle window.
    var lastChange = -1;
    var started = false;
    function finish(){
      if(done) return;
      done = true;
      clearTimeout(quietTimer); clearTimeout(hardTimer);
      if(observer){ try { observer.disconnect(); } catch(e){} }
      resolve(lastChange < 0 ? 0 : Math.max(0, lastChange));
    }
    function restarted(){
      lastChange = performance.now() - t0;
      // The quiet timer only arms once the initial drain has finished, so an
      // action's own first mutation is never mistaken for the drain itself.
      if(started) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, SILENCE);
    }
    try {
      observer = new MutationObserver(restarted);
      observer.observe(document.documentElement || document, {
        childList: true, subtree: true, attributes: true, characterData: true
      });
    } catch(e){ finish(); return; }
    hardTimer = setTimeout(finish, CEILING);
    // Drain two frames, then start counting quiet: without a mutation after
    // that, the action did not disturb the DOM and waiting longer is pointless.
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){ started = true; restarted(); });
    });
  });
})()`;

/**
 * Capture one DOM snapshot per frame, straight into IndexedDB.
 *
 * @param {Object} rec Recorder state.
 * @param {Object} [opts]
 * @param {string} [opts.targetSelector] Selector of the element the action
 *   addressed; the frame containing it stamps `__playwright_target__` so the
 *   viewer can outline it. Resolved per frame, so an iframe target marks the
 *   element in whichever frame owns it.
 * @param {string} [opts.targetCallId] callId to stamp (the snapshot line's own).
 * @returns {Object<string, {id:number, url:string, viewport:Object}>}
 *   ourFrameId -> snapshot record
 */
async function captureDomSnapshot(rec, opts = {}) {
  if (!rec.debuggeeTabId) return {};

  const frames = await refreshFrames(rec);
  const result = {};

  for (const frame of frames) {
    let pageInfo = null;
    try {
      const raw = await evaluateFrame(rec, frame, PAGE_INFO_EXPR);
      if (raw) pageInfo = JSON.parse(raw);
    } catch (_) { /* non-fatal */ }

    if (pageInfo && pageInfo.stylesheets) {
      await cacheStylesheets(rec, frame, pageInfo.stylesheets);
    }

    // Device pixel ratio is a property of the device, so the first frame that
    // reports one settles it for the whole recording. It is needed at export to
    // reconcile CSS-pixel viewports with device-pixel screencast frames.
    if (pageInfo && pageInfo.deviceScaleFactor && !rec.deviceScaleFactor) {
      rec.deviceScaleFactor = pageInfo.deviceScaleFactor;
    }

    // Locale and time zone are environment properties shared by every frame, so
    // the first frame that reports them settles them for the recording.
    if (pageInfo && pageInfo.locale && !rec.locale) rec.locale = pageInfo.locale;
    if (pageInfo && pageInfo.timezoneId && !rec.timezoneId) rec.timezoneId = pageInfo.timezoneId;

    if (rec.bytes.snapshots >= LIMITS.maxSnapshotBytes) {
      rec.dropped.snapshots++;
      notifyLimit(rec, 'DOM snapshots');
      break;
    }

    // ownerIndex (document order in the parent document) -> our frame id, for
    // only the direct children of THIS frame.
    const childMap = {};
    for (const child of frames) {
      if (child.parentCdp === frame.cdpFrameId &&
          typeof child.ownerIndex === 'number') {
        childMap[child.ownerIndex] = child.ourFrameId;
      }
    }

    let json;
    try {
      const expr = buildDomSnapshotExpr(
        JSON.stringify(childMap), frame.ourFrameId, !!frame.main,
        opts.targetSelector || '', opts.targetCallId || '');
      json = await evaluateFrame(rec, frame, expr);
    } catch (e) {
      console.warn(`Failed to capture DOM snapshot for frame ${frame.ourFrameId}:`, e.message);
      continue;
    }
    if (!json || typeof json !== 'string') continue;

    const byteLength = json.length;
    if (rec.bytes.snapshots + byteLength > LIMITS.maxSnapshotBytes) {
      rec.dropped.snapshots++;
      notifyLimit(rec, 'DOM snapshots');
      break;
    }

    let id;
    try {
      id = await putSnapshot(rec.session, json);
    } catch (e) {
      console.warn('Could not persist DOM snapshot:', isQuotaError(e) ? 'storage quota exceeded' : e.message);
      if (isQuotaError(e)) notifyLimit(rec, 'browser storage quota');
      continue;
    }
    rec.bytes.snapshots += byteLength;
    result[frame.ourFrameId] = {
      id,
      bytes: byteLength,
      url: pageInfo ? pageInfo.url : null,
      viewport: pageInfo ? pageInfo.viewport : null
    };
  }

  return result;
}

// ── Action recording ──────────────────────────────────────────────────────────

async function logEvent(rec, data) {
  if (rec.eventCount >= LIMITS.maxEvents) {
    rec.dropped.events++;
    notifyLimit(rec, 'event count');
    return;
  }
  try {
    await putEvent(rec.session, data);
    rec.eventCount++;
  } catch (err) {
    console.warn('Could not persist event:', err.message);
    if (isQuotaError(err)) notifyLimit(rec, 'browser storage quota');
  }
}

/**
 * Queue an interaction for recording. Captures run one at a time; when actions
 * arrive faster than snapshots can be taken, the excess is still recorded but
 * without its action-stage snapshot (the before stage references the previous
 * snapshot, the after stage is always captured) rather than piling up
 * concurrent CDP work.
 *
 * Consecutive fill events on the same element describe one typing burst and
 * are merged into a single Page.fill action (like Playwright codegen): their
 * capture job waits on the queue until the burst settles, and only the latest
 * value is recorded. A different interaction, switching fields, an idle gap or
 * stopping the recording settles the burst.
 */
const FILL_IDLE_MS = 400;
let pendingFill = null;

function settlePendingFill(reason) {
  const pending = pendingFill;
  if (!pending || pending.settled) return;
  pending.settled = true;
  pending.settleReason = reason;
  clearTimeout(pending.idleTimer);
  pending.resolve();
}

function enqueueAction(event) {
  if (!activeRecording) {
    console.warn('Received event while not recording');
    return;
  }
  const rec = activeRecording;

  // Stamp arrival before anything can queue: the viewer's action span must start
  // when the interaction reached us, not when the backlog let the job run.
  if (!Number.isFinite(event.arrivedAt)) event.arrivedAt = Date.now();
  if (!Number.isFinite(event.burstEndAt)) event.burstEndAt = event.arrivedAt;

  // Capture the action in full frame rate. Official does this for each of the
  // before/input/after calls; doing it on arrival plus from the recorder below
  // keeps every phase of the action inside one unthrottled window.
  unthrottleScreencast(rec);

  if (event.type === 'fill') {
    if (pendingFill && !pendingFill.settled &&
        pendingFill.selector === event.selector) {
      // Same burst: refresh the value its (already queued) job will record. The
      // burst's start stays the first keystroke's, so one merged Page.fill
      // action reports the whole typing burst rather than its last keystroke;
      // the page's reaction is measured from the LAST keystroke.
      const startedAt = pendingFill.event.arrivedAt;
      pendingFill.event = event;
      event.arrivedAt = startedAt;
      event.burstEndAt = Date.now();
      clearTimeout(pendingFill.idleTimer);
      pendingFill.idleTimer = setTimeout(() => settlePendingFill('idle'), FILL_IDLE_MS);
      return;
    }
    settlePendingFill('switch');

    const pending = {
      selector: event.selector,
      event,
      settled: false,
      settleReason: null,
      resolve: null,
      idleTimer: setTimeout(() => settlePendingFill('idle'), FILL_IDLE_MS)
    };
    pending.settledPromise = new Promise(resolve => { pending.resolve = resolve; });
    pendingFill = pending;

    // No capture slot is taken here: this job is only coalescing keystrokes and
    // will wait FILL_IDLE_MS before doing anything. Counting that wait as
    // backlog would make an idle typing burst look like capture pressure and
    // wrongly deny action snapshots to whatever the user does next. The slot is
    // acquired inside recordFillAction, when capturing actually starts.
    captureChain = captureChain
      .then(() => recordFillAction(rec, pending))
      .catch(err => console.warn('Failed to record fill action:', err));
    return;
  }

  settlePendingFill('interrupt');

  // Action-stage snapshot gate: bursts that outpace CDP capture skip only the
  // mid-action snapshot; their before/after stages still land.
  const withActionSnapshot = captureQueueDepth < LIMITS.maxQueuedCaptures &&
    rec.eventCount < LIMITS.maxEvents;
  captureQueueDepth++;
  captureChain = captureChain
    .then(() => recordAction(rec, event, { withActionSnapshot }))
    .catch(err => console.warn('Failed to record action:', err))
    .then(() => { captureQueueDepth--; });
}

async function recordFillAction(rec, pending) {
  await pending.settledPromise;
  // The recording may have been stopped while the burst was settling.
  if (rec !== activeRecording) return;
  // Capturing starts now, so only now does this job occupy a capture slot. The
  // action-stage decision is made against that same instant: the depth a job
  // sees when it is finally ready to capture is the honest measure of pressure,
  // not the depth left behind by an earlier job that was merely idle-waiting.
  const withActionSnapshot = captureQueueDepth < LIMITS.maxQueuedCaptures &&
    rec.eventCount < LIMITS.maxEvents;
  captureQueueDepth++;
  try {
    await recordAction(rec, pending.event, { withActionSnapshot });
  } finally {
    captureQueueDepth--;
  }
}

async function recordAction(rec, event, opts) {
  // The recording may have been stopped while this action sat in the queue.
  if (rec !== activeRecording) return;

  const callId = `call@${Date.now()}@${Math.floor(Math.random() * 1000)}`;
  // The action's start is when the interaction actually reached the recorder,
  // not when this queued job happened to run: under backlog the two differ by
  // the whole queue wait, and the viewer draws the span between them.
  const timestamp = Number.isFinite(event.arrivedAt) ? event.arrivedAt : Date.now();
  const attachments = [];

  const beforeSnapshotIds = { ...rec.lastSnapshotIds };

  // Re-arm the unthrottled window for this action's own capture phases. The
  // burst above may have happened a moment ago, and the page's visible reaction
  // to the action is exactly what must be recorded at full rate.
  unthrottleScreencast(rec);

  // captureDomSnapshot returns {frameId: {id, url, viewport}}; events reference
  // snapshots by id only, so flatten to {frameId: id}.
  const flatSnapshotIds = captured =>
    Object.fromEntries(Object.entries(captured).map(([fid, snap]) => [fid, snap.id]));

  // How long the PAGE took to react to this action, measured inside the page.
  // Everything the recorder does afterwards (settling, snapshot capture,
  // screenshots, IndexedDB writes) is our cost, not the action's, and must not
  // be reported as its duration.
  let reactionMs = null;

  let actionSnapshotIds = {};
  if (opts.withActionSnapshot) {
    // The action stage is captured after the page has reacted. A click handler
    // that triggers framework work (React/Vue re-render, data fetch) returns
    // before that work lands, so capturing immediately records the transitional
    // state — which is precisely the view the trace viewer opens on. Wait for
    // the DOM to go quiet first.
    reactionMs = await settleDom(rec);
    if (rec !== activeRecording) return;
    actionSnapshotIds = flatSnapshotIds(await captureDomSnapshot(rec, {
      targetSelector: event.selector,
      targetCallId: callId
    }));
    if (rec !== activeRecording) return;
  } else {
    // Burst overflow: only the action-stage snapshot is suppressed (counted
    // like the other budget drops); the after stage below is still captured so
    // every action keeps a post-state snapshot.
    rec.dropped.actionSnapshots++;
  }

  if (rec.debuggeeTabId && rec.bytes.screenshots < LIMITS.maxScreenshotBytes) {
    try {
      const { data } = await cdpSend(rec, '', 'Page.captureScreenshot', {
        format: 'jpeg', quality: 80
      });
      const bytes = base64ToUint8Array(data);
      const name = await storeResource(rec, bytes, '.jpeg', 'screenshots', LIMITS.maxScreenshotBytes);
      if (name) {
        // Declare the frame's true device-pixel size. CDP returns only the
        // encoded image, so the real dimensions are read back from the JPEG
        // itself; the CSS-pixel viewport times the device pixel ratio is the
        // fallback when the header cannot be parsed. (CDP's own screencast
        // reports real device pixels here too — never a scaled thumbnail.)
        const dsf = deviceScaleFactor(rec);
        const dims = jpegSize(bytes) || {
          width: Math.round((rec.viewport?.width || 0) * dsf),
          height: Math.round((rec.viewport?.height || 0) * dsf)
        };
        attachments.push({
          name: 'Action Screenshot',
          contentType: 'image/jpeg',
          resource: name,
          width: dims.width,
          height: dims.height
        });
      } else {
        notifyLimit(rec, 'screenshots');
      }
    } catch (e) {
      console.warn('Failed to capture screenshot:', e.message);
    }
    if (rec !== activeRecording) return;
  }

  await logEvent(rec, {
    type: 'before',
    callId,
    startTime: timestamp,
    method: event.type,
    // Official names a selector-addressed interaction after the object that owns
    // it: `Frame.click`, `Frame.fill`, `Frame.hover`, … The trace viewer resolves
    // an action's title from `class`+`method` against its own API metadata table
    // (only `Frame.*`/`ElementHandle.*` element actions are listed), so emitting
    // `Page.click` left every action rendering as the bare method name with no
    // title and no selector subtitle.
    class: 'Frame',
    params: {
      selector: event.selector || '',
      ...(event.value != null ? { value: event.value } : {}),
      ...(event.key != null ? { key: event.key } : {}),
      ...(event.options != null ? { options: event.options } : {}),
      ...(event.files != null ? { files: event.files } : {}),
      // Optional context the viewer/replayer uses: which element produced a
      // synthetic event (Task 4) and where a click landed (red-dot point).
      ...(event.sourceSelector ? { sourceSelector: event.sourceSelector } : {}),
      ...(Number.isFinite(event.x) && Number.isFinite(event.y)
        ? { point: { x: Math.round(event.x), y: Math.round(event.y) } } : {}),
      // The addressed element's rectangle, which the viewer outlines. Captured
      // in the page at event time: by the time this job runs the element may
      // have moved or been replaced by the action's own re-render.
      ...(event.box ? { box: event.box } : {})
    },
    pageId: 'page1',
    timestamp,
    beforeSnapshotIds,
    actionSnapshotIds
  });

  // The after snapshot is unconditional (debugger attached is the only
  // condition): a burst must never leave an action without its post-state.
  let afterSnapshotIds = {};
  if (rec.debuggeeTabId) {
    // Only wait out the render when no settle already happened for the action
    // stage; otherwise this is the tail of the same reaction.
    if (!opts.withActionSnapshot) {
      reactionMs = await settleDom(rec);
    }
    if (rec !== activeRecording) return;
    const afterResult = await captureDomSnapshot(rec);
    afterSnapshotIds = flatSnapshotIds(afterResult);
    for (const [fid, snap] of Object.entries(afterResult)) {
      rec.lastSnapshotIds[fid] = snap.id;
      // rec.url is owned by the initial snapshot backfill and (from Task 3)
      // the CDP navigation handler; only viewport is backfilled here.
      if (fid === rec.mainFrameId) {
        if (!rec.viewport && snap.viewport) rec.viewport = snap.viewport;
      }
    }
    persistSession(rec);
  }

  // The action's real duration: arrival to the page having reacted. Taking
  // Date.now() here instead would fold in settleDom's quiet window, the DOM
  // snapshot round trip and the screenshot — all recorder cost — and every
  // action would report a near-constant ~670 ms regardless of what the page
  // did. The viewer draws this span on the timeline, so it must describe the
  // page, not the recorder.
  //
  // A merged typing burst starts at its first keystroke but the page only
  // reacts to the last one, so its reaction is added to the burst's end.
  //
  // When the page never reacted (reactionMs === null: settling was skipped
  // under backlog, or the frame was not ready) the honest answer is the brief
  // moment we actually held the action, not an invented render time.
  const reactionBase = Math.max(
    timestamp, Number.isFinite(event.burstEndAt) ? event.burstEndAt : timestamp);
  const endTime = Number.isFinite(reactionMs) && reactionMs > 0
    ? reactionBase + Math.round(reactionMs)
    : Date.now();
  // Guard against a page clock that disagrees with ours: the span must never
  // run backwards, and must not swallow the recorder's own tail either.
  const clampedEnd = Math.min(Math.max(endTime, timestamp), Date.now());

  await logEvent(rec, {
    type: 'after',
    callId,
    endTime: clampedEnd,
    timestamp: clampedEnd,
    attachments,
    afterSnapshotIds
  });
}

// ── Network capture ───────────────────────────────────────────────────────────

function extensionForMime(mime) {
  if (!mime) return '';
  if (mime.includes('image/jpeg')) return '.jpeg';
  if (mime.includes('image/png')) return '.png';
  if (mime.includes('image/webp')) return '.webp';
  if (mime.includes('image/gif')) return '.gif';
  if (mime.includes('image/svg+xml')) return '.svg';
  if (mime.includes('font/woff2')) return '.woff2';
  if (mime.includes('font/woff')) return '.woff';
  if (mime.includes('font/ttf')) return '.ttf';
  if (mime.includes('css')) return '.css';
  if (mime.includes('javascript') || mime.includes('ecmascript')) return '.js';
  if (mime.includes('json')) return '.json';
  if (mime.includes('html')) return '.html';
  return '';
}

function frameIdForSession(rec, sessionId) {
  if (!sessionId) return rec.mainFrameId;
  const cdpFrameId = rec.frameBySession.get(sessionId);
  if (cdpFrameId) {
    const entry = rec.frames.get(cdpFrameId);
    if (entry) return entry.ourFrameId;
  }
  // Dedicated/shared/service workers: attribute to the main frame.
  return rec.mainFrameId;
}

/** Network events carry their frameId; same-process child frames share the
 *  main session and are only distinguishable through it. */
function frameIdForNetwork(rec, sessionId, params) {
  const cdpFrameId = params && params.frameId;
  if (cdpFrameId && rec.frames.has(cdpFrameId)) {
    return rec.frames.get(cdpFrameId).ourFrameId;
  }
  return frameIdForSession(rec, sessionId);
}

function enqueueRequestTask(rec, fn) {
  if (rec !== activeRecording) return;
  const job = rec.requestChain
    .then(() => { if (rec === activeRecording) return fn(); })
    .catch(err => console.warn('Network capture task failed:', err && err.message));
  rec.requestChain = job.catch(() => {});
  track(rec, job);
}

async function handleRequestWillBeSent(rec, sessionId, params, arrivalTs) {
  if (rec.trackedRequestCount >= LIMITS.maxTrackedRequests) {
    rec.dropped.requests++;
    return;
  }
  const rid = (sessionId || '') + '#' + params.requestId;

  // A redirect is not a new request from CDP's point of view: every hop of the
  // chain shares one requestId, and `redirectResponse` names the previous hop's
  // finished response. The viewer, however, renders each hop as its own row —
  // the 3xx with `redirectURL` pointing at its successor. Without a split, the
  // upsert below would overwrite the 3xx with the final 200 and the redirect
  // hop would vanish from the panel. So: finalize the previous hop under a
  // fresh key (pointing its `redirectURL` at this request's URL), then record
  // this hop under the original key. The redirected-to response stays under
  // the original key, so `responseReceived`/`loadingFinished` merge onto the
  // final hop exactly as before.
  let redirectHops = 0;
  if (params.redirectResponse) {
    const prior = await readRequest(rec.session, rid);
    if (prior && !prior.redirectSplit) {
      redirectHops = (prior.redirectHops || 0) + 1;
      // CDP never emits `responseReceived` for a redirect hop: the 3xx arrives as
      // this event's `redirectResponse`, which is a full `Network.Response` —
      // timing, remote address and TLS details included. Copying `...prior`
      // alone therefore leaves the hop with the placeholder protocol and no
      // timing at all, which is exactly what a HAR consumer sees as "this
      // request was never measured".
      const redirectResponse = params.redirectResponse;
      const redirectTiming = redirectResponse.timing || null;
      await putRequest(rec.session, rid + '@hop' + (prior.redirectHops || 0), {
        ...prior,
        rid: rid + '@hop' + (prior.redirectHops || 0),
        redirectHops,
        redirectSplit: true,
        url: redirectResponse.url || prior.url,
        status: redirectResponse.status || prior.status,
        statusText: redirectResponse.statusText || prior.statusText,
        mimeType: redirectResponse.mimeType || prior.mimeType,
        responseHeaders: Object.entries(redirectResponse.headers || {})
          .map(([n, v]) => ({ name: n, value: String(v) })),
        // The hop's own response metadata, straight off `redirectResponse`.
        protocol: redirectResponse.protocol || prior.protocol,
        remoteIPAddress: redirectResponse.remoteIPAddress || prior.remoteIPAddress,
        remotePort: typeof redirectResponse.remotePort === 'number'
          ? redirectResponse.remotePort : prior.remotePort,
        securityDetails: redirectResponse.securityDetails || prior.securityDetails,
        timing: redirectTiming,
        // The redirect response has been fully received by the time its
        // successor's requestWillBeSent fires, so this arrival stamps its end.
        // The header-arrival anchor cannot be observed directly (this hop never
        // gets its own `responseReceived`), so it is derived the way official
        // derives `receive`: `receiveHeadersEnd` is the header arrival measured
        // in MILLISECONDS from the request's start, so adding it to this hop's
        // own start places the headers on our wall clock and leaves
        // `finishedAt - responseReceivedAt` as the header-to-body span.
        //
        // Both ends are wall-clock milliseconds, so a hop that completes in
        // under a millisecond can leave the span negative; the generator falls
        // back to -1 (an unmeasured phase) rather than publishing a fabricated
        // positive. That is the honest answer at this clock resolution.
        responseReceivedAt: redirectTiming && Number.isFinite(redirectTiming.receiveHeadersEnd)
          ? (prior.timestamp || 0) + redirectTiming.receiveHeadersEnd
          : (arrivalTs || Date.now()),
        finishedAt: arrivalTs || Date.now(),
        redirectURL: params.request?.url || ''
      });
      rec.trackedRequestCount++;
    }
  }

  let postDataText = null;
  let postDataSha1 = null;
  const method = params.request?.method || 'GET';
  if (params.request?.postData != null) {
    postDataText = String(params.request.postData);
  } else if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
    try {
      const post = await cdpSend(rec, sessionId, 'Network.getRequestPostData', {
        requestId: params.requestId
      });
      if (post && post.postData != null) postDataText = String(post.postData);
    } catch (_) { /* not all requests expose post data */ }
  }

  if (postDataText && postDataText.length > LIMITS.maxInlinePostBytes) {
    const bytes = new TextEncoder().encode(postDataText);
    const name = await storeResource(rec, bytes, '', 'network', LIMITS.maxNetworkBytes);
    if (name) postDataSha1 = name;
    else rec.dropped.postData++;
    postDataText = null;
  }

  rec.trackedRequestCount++;
  await putRequest(rec.session, rid, {
    rid,
    frameId: frameIdForNetwork(rec, sessionId, params),
    url: params.request?.url || '',
    method,
    requestHeaders: Object.entries(params.request?.headers || {})
      .map(([n, v]) => ({ name: n, value: String(v) })),
    postDataText,
    postDataSha1,
    redirectHops,
    redirectSplit: false,
    status: 0,
    statusText: '',
    responseHeaders: [],
    mimeType: '',
    resourceType: rec.wsByRequestId.has(rid) ? 'websocket' : '',
    redirectURL: '',
    timestamp: arrivalTs || Date.now(),
    finishedAt: 0,
    encodedLength: 0,
    failed: false,
    errorText: '',
    bodyResource: null,
    bodySize: 0,
    // HTTP-version placeholder until `responseReceived` reports the protocol.
    // A redirect hop is copied with `...prior`, so a value set on the first hop
    // would otherwise survive onto the next one; seeding it here keeps every hop
    // honest if its own response never arrives.
    protocol: '',
    // Server address / TLS / timing: all only known once the response headers
    // arrive (see handleResponseReceived).
    remoteIPAddress: '',
    remotePort: -1,
    securityDetails: null,
    timing: null,
    responseReceivedAt: 0
  });
}

async function mergeRequest(rec, rid, patch) {
  const current = (await readRequest(rec.session, rid)) || {};
  await putRequest(rec.session, rid, { ...current, ...patch });
}

async function handleResponseReceived(rec, sessionId, params, arrivalTs) {
  const rid = (sessionId || '') + '#' + params.requestId;
  const existing = await readRequest(rec.session, rid);
  if (!existing) return;
  const response = params.response || {};
  const patch = {
    status: response.status || 0,
    statusText: response.statusText || '',
    responseHeaders: Object.entries(response.headers || {})
      .map(([n, v]) => ({ name: n, value: String(v) })),
    mimeType: response.mimeType || '',
    // CDP's own resource classification (document/stylesheet/script/image/xhr/
    // fetch/font/other). The viewer's network panel uses it to filter by type
    // and to render websocket rows specially. A websocket handshake must NOT be
    // reclassified by CDP's PascalCase type (it reports the handshake, not the
    // socket), so the wsByRequestId marker wins when present.
    resourceType: rec.wsByRequestId.has(rid) ? 'websocket' : (params.type || 'other'),

    // ── HAR fields the panel and HAR exporters read ──────────────────────────
    // CDP hands all of these over on `response`; without them the trace reports
    // a placeholder protocol, an empty server address and no timing breakdown.

    // CDP's wire protocol ("h2", "http/1.1", "blob"). Mapped to the HAR spelling
    // ("HTTP/2.0") at export, exactly as official does.
    protocol: response.protocol || '',

    // The resolved server address, surfaced as HAR `serverIPAddress`/`_serverPort`.
    remoteIPAddress: response.remoteIPAddress || '',
    remotePort: typeof response.remotePort === 'number' ? response.remotePort : -1,

    // TLS metadata (`{protocol, subjectName, issuer, validFrom, validTo, …}`).
    // Owned by the response; the panel and HAR consumers read the raw object.
    securityDetails: response.securityDetails || null,

    // CDP's `Network.ResourceTiming`: each phase in MILLISECONDS relative to
    // `requestTime`, with -1 for every phase that did not happen (cache hit,
    // reused connection). The HAR `timings` block is derived from it at export.
    timing: response.timing || null,

    // When the response HEADERS arrived, on the recorder's wall clock. This is
    // the only anchor for `timings.receive`, which measures header-arrival to
    // body-finished and therefore needs a timestamp comparable with
    // handleLoadingFinished's — CDP's own `timing` is relative to a per-request
    // origin and must never be mixed with wall-clock readings.
    responseReceivedAt: arrivalTs || Date.now()
  };
  if (!existing.url) patch.url = response.url || '';
  await mergeRequest(rec, rid, patch);

  // Remember which request served each stylesheet for CSS fetch fallback.
  const url = existing.url || patch.url;
  if (patch.mimeType.includes('css') && url) {
    rec.cssRequestIds.set(url, { sessionId: sessionId || '', requestId: params.requestId });
  }
}

async function captureResponseBody(rec, sessionId, rid) {
  const req = await readRequest(rec.session, rid);
  if (!req || req.bodyResource) return;
  if (rec.bytes.network >= LIMITS.maxNetworkBytes) {
    rec.dropped.network++;
    notifyLimit(rec, 'network bodies');
    return;
  }
  if ((req.encodedLength || 0) > LIMITS.maxSingleBodyBytes) {
    rec.dropped.oversize++;
    return;
  }

  let body;
  try {
    body = await cdpSend(rec, sessionId, 'Network.getResponseBody', {
      requestId: rid.slice(rid.indexOf('#') + 1)
    });
  } catch (_) {
    return;  // body already evicted from the CDP buffer
  }
  if (!body || !body.body) return;

  const bytes = body.base64Encoded
    ? base64ToUint8Array(body.body)
    : new TextEncoder().encode(body.body);

  if (bytes.byteLength > LIMITS.maxSingleBodyBytes) {
    rec.dropped.oversize++;
    return;
  }

  // Every content type is retained: css/js/api/media are all part of a complete
  // recording. Bounded only by the per-body cap and the network byte budget.
  const name = await storeResource(
    rec, bytes, extensionForMime(req.mimeType), 'network', LIMITS.maxNetworkBytes);
  if (name) {
    await mergeRequest(rec, rid, { bodyResource: name, bodySize: bytes.byteLength });
  } else {
    notifyLimit(rec, 'network bodies');
  }
}

async function handleLoadingFinished(rec, sessionId, params, timestamp) {
  const rid = (sessionId || '') + '#' + params.requestId;
  const existing = await readRequest(rec.session, rid);
  if (!existing) return;
  await mergeRequest(rec, rid, {
    encodedLength: params.encodedDataLength || existing.encodedLength || 0,
    // When the response finished. The trace's `time` field is a request
    // DURATION (the viewer draws start from `_monotonicTime` and width from
    // `time`), so the duration can only be computed once both ends are known.
    finishedAt: timestamp || Date.now()
  });
  await captureResponseBody(rec, sessionId, rid);
}

async function handleLoadingFailed(rec, sessionId, params) {
  const rid = (sessionId || '') + '#' + params.requestId;
  const existing = await readRequest(rec.session, rid);
  if (!existing) return;
  // A blocked request reports only `blockedReason`; a canceled one only the
  // flag. Both are still a failure with a human-readable cause.
  const reason = params.errorText ||
    (params.blockedReason ? `blocked:${params.blockedReason}` : 'failed');
  await mergeRequest(rec, rid, {
    failed: true,
    // The failure cause, exported as HAR `response._failureText`. It is kept
    // separate from `statusText` on purpose: official leaves statusText EMPTY
    // for a failed request (the panel derives "canceled"/"ERR" from the status
    // code, never from this text), so folding the reason into statusText would
    // display a transport error where the status belongs.
    errorText: params.canceled ? 'canceled' : reason,
    // Official's HAR scaffold starts at status -1 and only a real response
    // overwrites it, which is what makes the panel render a never-answered
    // request as "canceled" and flag the row as an error. A request that DID
    // get a response before failing (404 then aborted) keeps that status.
    ...(existing.status > 0 ? {} : { status: -1 }),
    // A failed request still consumed wall time; without this its duration
    // would be reported as zero and the bar would collapse.
    finishedAt: Date.now()
  });
}

/**
 * A WebSocket never travels as an ordinary requestWillBeSent/responseReceived
 * pair: CDP emits `webSocketCreated` (the URL), then
 * `webSocketHandshakeResponseReceived` (the 101), then frames, then close. So
 * the owning record is minted here and the later events merge onto it.
 */
function mintWebSocketRecord(rec, sessionId, rid, url, arrivalTs) {
  return {
    rid,
    frameId: frameIdForNetwork(rec, sessionId, { frameId: null }),
    url,
    method: 'GET',
    requestHeaders: [],
    postDataText: null,
    postDataSha1: null,
    redirectHops: 0,
    redirectSplit: false,
    status: 0,
    statusText: '',
    responseHeaders: [],
    mimeType: '',
    resourceType: 'websocket',
    redirectURL: '',
    timestamp: arrivalTs || Date.now(),
    finishedAt: 0,
    encodedLength: 0,
    failed: false,
    errorText: '',
    bodyResource: null,
    bodySize: 0
  };
}

/**
 * `webSocketCreated` is the first event of a socket's life and the only one
 * that carries its URL. It mints the owning record (a websocket row the panel
 * routes to the Messages tab) so the handshake response and the frames can
 * merge onto it; the URL is remembered so a frame that races the mint still
 * finds its row.
 */
async function handleWebSocketCreated(rec, sessionId, params, arrivalTs) {
  const rid = (sessionId || '') + '#' + params.requestId;
  const url = params.url || '';
  rec.wsByRequestId.set(rid, url);

  const existing = await readRequest(rec.session, rid);
  if (existing) {
    await mergeRequest(rec, rid, { resourceType: 'websocket' });
    return;
  }
  await putRequest(rec.session, rid, mintWebSocketRecord(rec, sessionId, rid, url, arrivalTs));
}

/**
 * The 101 Switching Protocols response. This is the socket's real status; CDP
 * reports it as `response` on `webSocketHandshakeResponseReceived`, never as an
 * ordinary responseReceived.
 */
async function handleWebSocketHandshake(rec, sessionId, params) {
  const rid = (sessionId || '') + '#' + params.requestId;
  const existing = await readRequest(rec.session, rid);
  if (!existing) return;
  const response = params.response || {};
  await mergeRequest(rec, rid, {
    resourceType: 'websocket',
    status: response.status || 101,
    statusText: response.statusText || 'Switching Protocols',
    responseHeaders: Object.entries(response.headers || {})
      .map(([n, v]) => ({ name: n, value: String(v) }))
  });
}

/**
 * Fold one WebSocket frame onto its handshake's record. Binary payloads arrive
 * base64-encoded; text arrives as UTF-8. Both are stored as the viewer expects
 * them (opcode 1 = text, 2 = binary, …), with a wall-clock offset so the
 * Messages tab can place each frame on the timeline. A frame is dropped — never
 * the socket — when the per-socket cap or the per-frame byte cap is hit.
 */
async function handleWebSocketFrame(rec, sessionId, params, type, arrivalTs) {
  const rid = (sessionId || '') + '#' + params.requestId;
  let existing = await readRequest(rec.session, rid);

  // A frame can race webSocketCreated; mint the row from the remembered URL.
  if (!existing) {
    const url = rec.wsByRequestId.get(rid);
    if (!url) return;
    await putRequest(rec.session, rid, mintWebSocketRecord(rec, sessionId, rid, url, arrivalTs));
    existing = await readRequest(rec.session, rid);
  }

  const frames = existing._webSocketMessages || [];
  if (frames.length >= LIMITS.maxWebSocketFrames) {
    rec.dropped.webSocketFrames++;
    return;
  }

  // CDP nests the frame under `response` (a WebSocketFrame: {opcode, mask,
  // payloadData}); the error event instead carries a bare `errorMessage`.
  const frame = params.response || {};
  const opcode = typeof frame.opcode === 'number' ? frame.opcode : 1;
  const data = frame.payloadData != null ? String(frame.payloadData) : '';

  // Guard the inline storage cost: a single giant frame would otherwise blow
  // past the network budget by sneaking in through the message list.
  if (data.length > LIMITS.maxWebSocketFrameBytes) {
    rec.dropped.webSocketFrames++;
    return;
  }

  const message = {
    type: type === 'error' ? 'error' : type,
    time: arrivalTs || Date.now(),
    opcode,
    data
  };
  await mergeRequest(rec, rid, { _webSocketMessages: [...frames, message] });
}

/**
 * Mark the socket's record as closed so the viewer can render the connection's
 * terminal state; the close frame itself is an ordinary webSocketFrameReceived
 * (opcode 8) and is captured there.
 */
async function handleWebSocketClosed(rec, sessionId, params, arrivalTs) {
  const rid = (sessionId || '') + '#' + params.requestId;
  const existing = await readRequest(rec.session, rid);
  if (!existing) return;
  await mergeRequest(rec, rid, {
    finishedAt: arrivalTs || Date.now(),
    webSocketClosed: true
  });
  rec.wsByRequestId.delete(rid);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const rec = activeRecording;
  if (!rec) return;
  if (rec.debuggeeTabId && source.tabId !== rec.debuggeeTabId) return;

  const timestamp = Date.now();
  const sessionId = params && params.sessionId ? params.sessionId : '';

  // The continuous screencast. This must be handled before anything that can
  // await: a frame left unacked stalls the stream, and CDP sends exactly one
  // frame at a time, so a slow handler directly becomes a dropped frame rate.
  if (method === 'Page.screencastFrame') {
    handleScreencastFrame(rec, params);
    return;
  }

  if (method === 'Target.attachedToTarget') {
    const job = handleAttached(rec, params.sessionId, params.targetInfo)
      .catch(err => console.warn('attach handling failed:', err.message));
    rec.attachJobs.add(job);
    job.finally(() => rec.attachJobs.delete(job));
    return;
  }

  if (method === 'Target.detachedFromTarget') {
    // A cross-process navigation reports a fresh attach for the same frame; the
    // stale mapping is reconciled in refreshFrames, so just mark the CDP session
    // dead here.
    rec.liveSessions.delete(params.sessionId);
    rec.workerSessions.delete(params.sessionId);
    const cdpFrameId = rec.frameBySession.get(params.sessionId);
    if (cdpFrameId) {
      rec.frameBySession.delete(params.sessionId);
      rec.sessionByCdp.delete(cdpFrameId);
    }
    return;
  }

  // Default execution contexts for same-process child frames arrive on the main
  // session; they are how a same-origin iframe's document gets evaluated.
  if (method === 'Runtime.executionContextCreated') {
    const c = params.context;
    if (c && c.auxData && c.auxData.isDefault && c.auxData.frameId) {
      rec.contexts.set(`${sessionId}|${c.auxData.frameId}`, c.id);
    }
    return;
  }

  if (method === 'Runtime.executionContextDestroyed') {
    for (const [key, id] of rec.contexts) {
      if (id === params.executionContextId) rec.contexts.delete(key);
    }
    return;
  }

  if (method === 'Runtime.executionContextsCleared') {
    const prefix = `${sessionId}|`;
    for (const key of [...rec.contexts.keys()]) {
      if (key.startsWith(prefix)) rec.contexts.delete(key);
    }
    return;
  }

  if (method === 'Runtime.consoleAPICalled') {
    enqueueRequestTask(rec, async () => {
      if (rec.eventCount >= LIMITS.maxEvents) { rec.dropped.events++; return; }
      await logEvent(rec, {
        type: 'console',
        messageType: params.type,
        text: (params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 4096),
        location: { url: '', lineNumber: 0, columnNumber: 0 },
        time: timestamp,
        pageId: 'page1'
      });
    });
    return;
  }

  if (method === 'Runtime.exceptionThrown') {
    // An uncaught page exception. The viewer renders this from
    // `event`/`method:"pageError"` and counts it toward the action's error
    // stats, so it must travel as a first-class event rather than as console
    // text (which the viewer would show as an ordinary log line, if at all).
    enqueueRequestTask(rec, async () => {
      if (rec.eventCount >= LIMITS.maxEvents) { rec.dropped.events++; return; }
      const d = params.exceptionDetails || {};
      const ex = d.exception || {};
      await logEvent(rec, {
        type: 'pageError',
        error: {
          name: ex.className || d.type || 'Error',
          message: ex.description || d.text || 'Uncaught error',
          stack: (ex.description || '').slice(0, 8192)
        },
        location: {
          url: d.url || '',
          line: d.lineNumber || 0,
          column: d.columnNumber || 0
        },
        time: timestamp,
        pageId: 'page1'
      });
    });
    return;
  }

  if (method === 'Log.entryAdded') {
    enqueueRequestTask(rec, async () => {
      if (rec.eventCount >= LIMITS.maxEvents) { rec.dropped.events++; return; }
      await logEvent(rec, {
        type: 'console',
        messageType: params.entry.level,
        text: String(params.entry.text || '').slice(0, 4096),
        time: timestamp,
        pageId: 'page1'
      });
    });
    return;
  }

  // Navigation events are the only Frame.navigated source for the timeline and,
  // after the initial snapshot backfill, the sole runtime owner of rec.url.
  // frameNavigated covers full-page loads (a new main frame id arrives here
  // before any getFrameTree call has seen it — hence the resync), and
  // navigatedWithinDocument covers SPA route changes (pushState/replaceState).
  // Every frame session reports here, but worker targets never enable the Page
  // domain, so no worker noise reaches this branch.
  if (method === 'Page.frameNavigated' || method === 'Page.navigatedWithinDocument') {
    const cdpFrameId = params.frame ? params.frame.id : params.frameId;
    if (cdpFrameId) enqueueRequestTask(rec, async () => {
      if (!rec.frames.has(cdpFrameId)) await syncFrameTree(rec);
      const frameId = frameIdForNetwork(rec, sessionId, { frameId: cdpFrameId });
      const url = (params.frame && params.frame.url) || params.url || '';
      const name = (params.frame && params.frame.name) || '';
      if (!url) return;
      const entry = rec.frames.get(cdpFrameId);
      if (entry) entry.url = url;
      if (frameId === rec.mainFrameId && url !== rec.url) { rec.url = url; persistSession(rec); }
      await logEvent(rec, { type: 'navigation', frameId, url, name: name || '', timestamp: Date.now() });
    });
    return;
  }

  // Only the handful of Network events the trace format actually consumes are
  // retained; every frame/worker session reports into the same stores.
  if (method === 'Network.requestWillBeSent') {
    enqueueRequestTask(rec, () => handleRequestWillBeSent(rec, sessionId, params, timestamp));
    return;
  }

  if (method === 'Network.responseReceived') {
    enqueueRequestTask(rec, () => handleResponseReceived(rec, sessionId, params, timestamp));
    return;
  }

  if (method === 'Network.loadingFinished') {
    enqueueRequestTask(rec, () => handleLoadingFinished(rec, sessionId, params, timestamp));
    return;
  }

  if (method === 'Network.loadingFailed') {
    enqueueRequestTask(rec, () => handleLoadingFailed(rec, sessionId, params));
    return;
  }

  // WebSocket frames. The handshake itself arrives as an ordinary
  // Network.requestWillBeSent whose response carries status 101, but the frames
  // are separate webSocket* events reusing the handshake's requestId. They fold
  // onto that already-tracked record as `_webSocketMessages`.
  if (method === 'Network.webSocketCreated') {
    enqueueRequestTask(rec, () => handleWebSocketCreated(rec, sessionId, params, timestamp));
    return;
  }

  if (method === 'Network.webSocketHandshakeResponseReceived') {
    enqueueRequestTask(rec, () => handleWebSocketHandshake(rec, sessionId, params));
    return;
  }

  if (method === 'Network.webSocketFrameSent') {
    enqueueRequestTask(rec, () => handleWebSocketFrame(rec, sessionId, params, 'send', timestamp));
    return;
  }

  if (method === 'Network.webSocketFrameReceived') {
    enqueueRequestTask(rec, () => handleWebSocketFrame(rec, sessionId, params, 'receive', timestamp));
    return;
  }

  if (method === 'Network.webSocketFrameError') {
    enqueueRequestTask(rec, () => handleWebSocketFrame(rec, sessionId, params, 'error', timestamp));
    return;
  }

  if (method === 'Network.webSocketClosed') {
    enqueueRequestTask(rec, () => handleWebSocketClosed(rec, sessionId, params, timestamp));
  }
});

// ── Teardown safety nets ──────────────────────────────────────────────────────

chrome.debugger.onDetach.addListener((source) => {
  if (!activeRecording || source.tabId !== activeRecording.debuggeeTabId) return;
  console.warn('Debugger detached externally — finalizing recording');
  activeRecording.debuggeeTabId = null;
  stopRecording().catch(err => console.warn('Could not finalize recording:', err.message));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!activeRecording || tabId !== activeRecording.debuggeeTabId) return;
  console.warn('Recorded tab closed — finalizing recording');
  activeRecording.debuggeeTabId = null;
  stopRecording().catch(err => console.warn('Could not finalize recording:', err.message));
});
