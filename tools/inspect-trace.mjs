#!/usr/bin/env node
/**
 * Audits a recorded trace archive against the parts of Playwright's snapshot
 * contract the trace viewer actually reads.
 *
 * Two families of check:
 *  - storage health (were stylesheets captured whole, is repeated DOM stored by
 *    reference),
 *  - viewer contract (does each snapshot carry the markers the viewer needs to
 *    restore scroll position, repaint canvases, highlight the clicked element,
 *    and pair a snapshot with the right screencast frame).
 *
 * The second family is why this tool exists: the first family passed on traces
 * whose viewer rendering was visibly wrong. Every check below is derived from
 * playwright-core's own recorder/renderer source, so a green run means the
 * archive satisfies the same contract the official recorder produces.
 *
 * Usage:  node tools/inspect-trace.mjs <recording.zip>
 * Needs nothing but node and the system `unzip`.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';

const zipPath = process.argv[2];
if (!zipPath || !fs.existsSync(zipPath)) {
  console.error('usage: node tools/inspect-trace.mjs <recording.zip>');
  process.exit(2);
}

const read = entry => execFileSync('unzip', ['-p', zipPath, entry], { maxBuffer: 1 << 30 });
const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  .split('\n').map(s => s.trim()).filter(Boolean);

const lines = read('trace.trace').toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
const snapshots = lines.filter(l => l.type === 'frame-snapshot');
const kb = n => (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';

// trace.network is optional: a recording that captured no requests still yields a
// valid archive, so every check below degrades rather than throwing.
let netLines = [];
if (entries.includes('trace.network')) {
  netLines = read('trace.network').toString().split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(l => l.type === 'resource-snapshot');
}

console.log(`\n${zipPath}`);
console.log(`archive ${kb(fs.statSync(zipPath).size)} · ${entries.length} entries · ` +
  `${snapshots.length} snapshots\n`);

const failures = [];
const warnings = [];
const fail = msg => failures.push(msg);
const warn = msg => warnings.push(msg);

// ── Snapshot tree walking ─────────────────────────────────────────────────────
// A node is `[tag, attrs, ...children]`; `[[delta, index]]` is a back-reference
// into an earlier snapshot, and a bare string is text.

const isElement = n => Array.isArray(n) && typeof n[0] === 'string';
const isRef = n => Array.isArray(n) && Array.isArray(n[0]);

/** Visits every materialized element of one snapshot tree. */
function eachElement(node, visit) {
  if (typeof node === 'string' || !Array.isArray(node)) return;
  if (isRef(node)) return;                    // attributes live at the target
  if (!isElement(node)) return;
  visit(node[0], node[1], node);
  for (let i = 2; i < node.length; i++) eachElement(node[i], visit);
}

function styleTexts(node, out = []) {
  if (typeof node === 'string' || !Array.isArray(node)) return out;
  if (typeof node[0] !== 'string') return out;      // back-reference
  if (node[0] === 'STYLE')
    out.push(node.slice(2).filter(c => typeof c === 'string').join(''));
  for (let i = 2; i < node.length; i++) styleTexts(node[i], out);
  return out;
}

function containsBackReference(node) {
  if (!Array.isArray(node)) return false;
  if (Array.isArray(node[0])) return true;
  return node.slice(2).some(child => containsBackReference(child));
}

// ── Stylesheet health ─────────────────────────────────────────────────────────
// A <style> whose text is exactly 5001 chars and ends in an ellipsis is the
// signature of a per-text-node cap chopping the stylesheet.

const styles = [];
for (const s of snapshots) styleTexts(s.snapshot.html, styles);

const truncated = styles.filter(t => t.endsWith('…'));
const cssTotal = styles.reduce((a, t) => a + t.length, 0);
console.log('STYLESHEETS');
console.log(`  materialized <style> elements   ${styles.length}`);
console.log(`  total CSS captured             ${kb(cssTotal)}`);
if (styles.length) {
  const sorted = [...styles].sort((a, b) => b.length - a.length);
  console.log(`  largest / smallest            ${sorted[0].length} / ${sorted[sorted.length - 1].length} chars`);
}
if (truncated.length) {
  console.log(`  ❌ ${truncated.length} stylesheet(s) TRUNCATED (end in "…") — layout rules are missing`);
  fail(`${truncated.length} stylesheet(s) truncated`);
} else {
  console.log('  ✅ none truncated');
}

// ── Snapshot referencing ──────────────────────────────────────────────────────
const sizes = snapshots.map(s => JSON.stringify(s).length);
const withRefs = snapshots.filter(s => containsBackReference(s.snapshot.html)).length;
const wholeTreeRefs = snapshots.filter(s => Array.isArray(s.snapshot.html[0])).length;
const total = sizes.reduce((a, b) => a + b, 0);

console.log('\nSNAPSHOT STORAGE');
if (snapshots.length) {
  console.log(`  first (always complete)        ${kb(sizes[0])}`);
  const rest = sizes.slice(1);
  if (rest.length) {
    const median = [...rest].sort((a, b) => a - b)[Math.floor(rest.length / 2)];
    console.log(`  median of the rest            ${kb(median)}`);
  }
  console.log(`  all snapshots together        ${kb(total)}`);
  console.log(`  using back-references         ${withRefs}/${snapshots.length}` +
    ` (${wholeTreeRefs} reference a whole tree)`);
  const naive = sizes[0] * snapshots.length;
  if (withRefs > 0) {
    console.log(`  ✅ referencing active — full dumps would cost roughly ${kb(naive)}`);
  } else if (snapshots.length >= 2) {
    console.log('  ❌ no back-references found — every snapshot is a full DOM dump');
    fail('no back-references: every snapshot is a full DOM dump');
  }
}

// ── Viewer contract: marker census ────────────────────────────────────────────
// These attribute names are the interface between the recorder and the viewer
// (playwright-core `snapshotterInjected.js` writes them, `snapshotRenderer.js`
// reads them). A canvas with no bounding rect is skipped outright, and a
// snapshot with no scroll marker restores to scrollTop 0.

const MARKERS = [
  '__playwright_scroll_top_',
  '__playwright_scroll_left_',
  '__playwright_bounding_rect_',
  '__playwright_target__',
  '__playwright_current_src__',
  '__playwright_value_',
  '__playwright_checked_',
  '__playwright_selected_',
  '__playwright_shadow_root_',
  '__playwright_popover_open_',
  '__playwright_dialog_open_',
];

const census = Object.fromEntries(MARKERS.map(m => [m, 0]));
const tagCounts = new Map();
const targetCallIds = new Set();

for (const line of snapshots) {
  eachElement(line.snapshot.html, (tag, attrs) => {
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    if (!attrs) return;
    for (const m of MARKERS) if (m in attrs) census[m]++;
    if (attrs.__playwright_target__) targetCallIds.add(String(attrs.__playwright_target__));
  });
}

const countTag = t => tagCounts.get(t) || 0;
const canvasCount = countTag('CANVAS');
const frameElCount = countTag('IFRAME') + countTag('FRAME');
const pointerActions = lines.filter(l => l.type === 'before' &&
  ['click', 'dblclick', 'contextmenu', 'dragTo'].includes(l.method)).length;

console.log('\nVIEWER CONTRACT (snapshot markers)');
for (const m of MARKERS) console.log(`  ${m.padEnd(30)} ${census[m]}`);

// Scroll position: without it the viewer pins every scroll container to the
// top, so content below the fold is invisible in the snapshot.
if (census.__playwright_scroll_top_ === 0 && census.__playwright_scroll_left_ === 0) {
  console.log('\n  ❌ no scroll position captured anywhere — any scrolled container');
  console.log('     renders at scrollTop 0 in the viewer, hiding content below the fold');
  fail('no __playwright_scroll_top_/_left_ markers: scroll position is lost');
} else {
  console.log('\n  ✅ scroll position captured');
}

// Canvas contents can only be repainted from the screencast when the canvas
// carries its bounding rect; the viewer `continue`s past canvases without one.
if (canvasCount > 0 && census.__playwright_bounding_rect_ === 0) {
  console.log(`  ❌ ${canvasCount} canvas element(s) but no bounding rect —`);
  console.log('     the viewer skips canvas repaint even with "populate canvas from screenshot" on');
  fail('canvases present but no __playwright_bounding_rect_: canvas can never be repainted');
} else if (canvasCount > 0) {
  console.log(`  ✅ bounding rect present (${canvasCount} canvas element(s))`);
} else if (frameElCount > 0 && census.__playwright_bounding_rect_ === 0) {
  warn(`${frameElCount} iframe/frame element(s) without a bounding rect`);
}

// The red highlight around the element an action targeted is keyed by callId.
if (pointerActions > 0 && targetCallIds.size === 0) {
  warn(`no __playwright_target__ marker: the viewer draws no target outline ` +
    `for ${pointerActions} pointer action(s)`);
}

// ── Viewer contract: frame-snapshot timing ────────────────────────────────────
// Official recorder writes `timestamp` as a monotonic offset and `wallTime` as
// an absolute epoch (Date.now()). The viewer pairs a snapshot with a screencast
// frame by wallTime, falling back to timestamp: mixing the two units makes every
// snapshot resolve to the same frame.

const EPOCH_FLOOR = 1e11;   // year 5138 in ms; a relative offset never reaches it
const frameSnapWall = snapshots.map(s => s.snapshot.wallTime);
const absFrameWall = frameSnapWall.filter(w => typeof w === 'number' && w >= EPOCH_FLOOR);
const screencastLines = lines.filter(l => l.type === 'screencast-frame');

console.log('\nVIEWER CONTRACT (snapshot ↔ screencast pairing)');
console.log(`  frame-snapshot lines           ${snapshots.length}`);
console.log(`  with absolute wallTime         ${absFrameWall.length}/${snapshots.length}`);
console.log(`  screencast frames              ${screencastLines.length}`);

if (snapshots.length && absFrameWall.length < snapshots.length) {
  console.log('  ❌ frame-snapshot.wallTime is not an absolute epoch — snapshots do not map');
  console.log('     to the screencast frame that was on screen when they were taken');
  fail('frame-snapshot.wallTime is relative, not an absolute epoch');
} else if (snapshots.length) {
  console.log('  ✅ wallTime is absolute');
}

// Reproduce the viewer's own pairing (snapshotRenderer.js `closestScreenshot`)
// to show how many distinct frames the snapshots actually resolve to.
if (screencastLines.length && snapshots.length) {
  const pickClosest = (arr, value, project) => arr.find((el, i) => {
    if (i === arr.length - 1) return true;
    return Math.abs(project(el) - value) < Math.abs(project(arr[i + 1]) - value);
  });
  // Mirrors the viewer's branch exactly: it uses the wall clock whenever both
  // `wallTime` and the first frame's `frameSwapWallTime` are *truthy* — it does
  // not check that wallTime looks like an epoch. A relative wallTime therefore
  // takes the wall branch and is compared against absolute frame times.
  const useWall = !!frameSnapWall[0] && !!screencastLines[0].frameSwapWallTime;
  const key = useWall ? 'frameSwapWallTime' : 'timestamp';
  const picked = snapshots.map(s => {
    const value = useWall ? s.snapshot.wallTime : s.snapshot.timestamp;
    const frame = pickClosest(screencastLines, value, f => f[key]);
    return frame && frame.sha1;
  });
  const distinct = new Set(picked.filter(Boolean));
  console.log(`  pairing key used by viewer     ${key}`);
  console.log(`  distinct frames resolved       ${distinct.size}/${screencastLines.length}`);
  if (screencastLines.length > 1 && distinct.size === 1) {
    console.log('  ❌ every snapshot resolves to the same screencast frame');
    fail('all snapshots resolve to a single screencast frame');
  }
}

// ── Viewer contract: screencast density ──────────────────────────────────────
// The filmstrip and the "what was on screen" track are drawn from
// `screencast-frame` lines, which the official recorder emits CONTINUOUSLY for
// the whole session (Page.startScreencast). Emitting one per action instead
// yields frames only at action boundaries: the strip is nearly empty, scrubbing
// jumps between a handful of stills, and the recording feels far less smooth
// than an official one even though every individual frame is valid.
//
// Density, not frame count, is the property that was missing — a trace with 3
// flawless frames still renders as 3 stills.

const beforeActions = lines.filter(l => l.type === 'before');
const afters = lines.filter(l => l.type === 'after');
console.log('\nVIEWER CONTRACT (screencast density)');
if (screencastLines.length) {
  const ts = screencastLines.map(l => l.timestamp).filter(t => typeof t === 'number');
  const sorted = [...ts].sort((a, b) => a - b);
  const span = sorted.length > 1 ? sorted[sorted.length - 1] - sorted[0] : 0;
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  const median = gaps.length
    ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
    : 0;

  console.log(`  frames                        ${screencastLines.length}`);
  console.log(`  covered span                  ${Math.round(span)} ms`);
  console.log(`  frame interval median / max   ${Math.round(median)} / ${Math.round(Math.max(0, ...gaps))} ms`);
  if (span > 0) {
    console.log(`  effective rate                ${(screencastLines.length / (span / 1000)).toFixed(1)} fps`);
  }

  // The decisive property is not how MANY frames exist — CDP emits a frame only
  // when the page actually changes, so a static page legitimately produces few,
  // and an official trace of 10 actions held just 7 frames. What distinguishes a
  // real screencast is that frames arrive on the PAGE's own schedule: they land
  // at instants the recorder did not choose.
  //
  // A per-action screenshot can only ever be stamped with an action's start or
  // end instant. So if every frame sits exactly on an action boundary, frames
  // are being triggered by actions rather than streamed. Measured on real
  // traces: official ~0-14% of frames land on a boundary; a per-action recorder
  // scores 100%, deterministically.
  const contextOptions = lines.find(l => l.type === 'context-options') || {};
  const baseWall = typeof contextOptions.wallTime === 'number' ? contextOptions.wallTime : 0;
  const absBoundary = (e, key) =>
    typeof e.wallTime === 'number' ? e.wallTime : baseWall + (e[key] || 0);
  // Absolute wall-clock instants of every action boundary.
  const boundaries = [
    ...beforeActions.map(b => absBoundary(b, 'startTime')),
    ...afters.map(a => absBoundary(a, 'endTime'))
  ];
  const frameWalls = screencastLines
    .map(l => l.frameSwapWallTime)
    .filter(w => typeof w === 'number' && w > 0);
  const onBoundary = frameWalls.filter(w => boundaries.some(b => Math.abs(w - b) <= 5));
  const independent = frameWalls.length - onBoundary.length;

  if (frameWalls.length && boundaries.length && independent === 0) {
    console.log(`  ❌ all ${frameWalls.length} frame(s) sit exactly on an action boundary —`);
    console.log('     frames are triggered by actions, not streamed, so the viewer has');
    console.log('     only stills to scrub through however many frames there are');
    fail(`all ${frameWalls.length} screencast frame(s) coincide with an action boundary: ` +
      'the screencast is captured per action, not continuously');
  } else if (frameWalls.length && boundaries.length) {
    console.log(`  frames off any action boundary ${independent}/${frameWalls.length}`);
    console.log("  ✅ streamed on the page's own schedule");
  } else {
    console.log('  ✅ streamed continuously');
  }

  // Every frame must be an actual image. A declared frame whose resource is
  // missing renders as a blank tile in the strip.
  const missing = screencastLines.filter(l => !entries.includes(`resources/${l.sha1}`));
  if (missing.length) {
    console.log(`  ❌ ${missing.length} frame(s) reference a resource absent from the archive`);
    fail(`${missing.length} screencast frame(s) reference missing resources`);
  }
} else if (beforeActions.length) {
  console.log('  ❌ no screencast frames at all — the viewer shows no filmstrip');
  fail('no screencast-frame lines: the viewer has no filmstrip to draw');
} else {
  console.log('  (no actions recorded, nothing to stream)');
}

// ── Viewer contract: action duration ──────────────────────────────────────────
const durations = [];
for (const b of beforeActions) {
  const a = afters.find(x => x.callId === b.callId);
  if (a && typeof a.endTime === 'number' && typeof b.startTime === 'number')
    durations.push(a.endTime - b.startTime);
}
console.log('\nVIEWER CONTRACT (action timing)');
if (durations.length) {
  const distinctDurations = new Set(durations);
  console.log(`  actions                        ${durations.length}`);
  console.log(`  duration min/max               ${Math.min(...durations)} / ${Math.max(...durations)} ms`);
  if (distinctDurations.size === 1) {
    console.log(`  ❌ every action reports exactly ${durations[0]} ms — a hard-coded`);
    console.log('     duration, not the measured one');
    fail(`every action duration is the hard-coded ${durations[0]} ms`);
  } else {
    console.log('  ✅ durations vary');
  }
} else {
  console.log('  (no paired before/after actions found)');
}

// ── Viewer contract: device scale ─────────────────────────────────────────────
// Screencast frames are captured at device pixels; the trace declares a CSS-pixel
// viewport. If the declared scale factor disagrees with the real ratio between
// the two, the filmstrip and the snapshot disagree about the page's geometry.

let metadata = null;
try { metadata = JSON.parse(read('metadata.json').toString()); } catch (_) { /* optional */ }

/** JPEG intrinsic size, read from the SOF marker (no dependencies). */
function jpegSize(buf) {
  let i = 2;                                  // skip SOI
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (len <= 0) break;
    i += 2 + len;
  }
  return null;
}

const uniqueShots = [...new Set(screencastLines.map(l => l.sha1))];
const shotDims = [];
for (const sha1 of uniqueShots) {
  const entry = `resources/${sha1}`;
  if (!entries.includes(entry)) continue;
  const size = jpegSize(read(entry));
  const decl = screencastLines.find(l => l.sha1 === sha1);
  if (size) shotDims.push({ sha1, ...size, declaredW: decl.width, declaredH: decl.height });
}

console.log('\nDEVICE SCALE');
const opts = (metadata && metadata.options) || {};
console.log(`  metadata.deviceScaleFactor     ${opts.deviceScaleFactor}`);
console.log(`  metadata viewport              ${opts.viewport &&
  `${opts.viewport.width}×${opts.viewport.height}`}`);
if (shotDims.length) {
  const s = shotDims[0];
  const ratio = s.declaredW ? s.width / s.declaredW : null;
  console.log(`  screencast declared / actual   ${s.declaredW}×${s.declaredH} / ${s.width}×${s.height}`);
  if (ratio && Math.abs(ratio - 1) > 0.01) {
    if (typeof opts.deviceScaleFactor === 'number' &&
        Math.abs(opts.deviceScaleFactor - ratio) > 0.01) {
      console.log(`  ❌ frames are ${ratio}× the declared size but deviceScaleFactor is ` +
        `${opts.deviceScaleFactor}`);
      fail(`deviceScaleFactor ${opts.deviceScaleFactor} disagrees with the real ${ratio}× frame scale`);
    } else {
      console.log(`  ✅ declared scale factor matches the ${ratio}× frames`);
    }
  } else {
    console.log('  ✅ declared frame size matches the pixels');
  }
} else {
  console.log('  (no screencast resources to measure)');
}

// ── Viewer contract: snapshot declaration order and phase ─────────────────────
// Playwright's trace modernizer derives each frame-snapshot's `phase` from the
// action event that NAMES it: `_modernize_8_to_9` runs
// `snapshot.phase = _snapshotPhases.get(snapshot.snapshotName)`, and that map is
// only populated while the declaring event is being processed. So the declaring
// line must be emitted BEFORE the snapshot line it references. Emit the snapshot
// first and the lookup misses, `phase` becomes undefined, SnapshotStorage never
// registers a renderer, and every action renders a blank frame.
//
// This is invisible to the older viewer (up to v8), which resolves snapshots by
// `snapshotName` instead — hence a trace can look fine locally and be broken on
// trace.playwright.dev.

const REF_FIELDS = [
  ['beforeSnapshot', 'before'],
  ['inputSnapshot', 'action'],
  ['afterSnapshot', 'after'],
];

const snapshotNames = new Set();
const snapshotIndexByName = new Map();
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.type !== 'frame-snapshot') continue;
  const name = l.snapshot.snapshotName;
  if (!name) continue;
  if (!snapshotIndexByName.has(name)) snapshotIndexByName.set(name, i);
  snapshotNames.add(name);
}

const declarations = [];       // { name, phase, line, declaredAt }
const danglingRefs = [];       // declared but never emitted
const outOfOrderRefs = [];     // emitted before its declaring line
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  for (const [field, phase] of REF_FIELDS) {
    const name = l[field];
    if (!name) continue;
    declarations.push({ name, phase, declaredAt: i });
    if (!snapshotNames.has(name)) {
      danglingRefs.push({ name, phase, declaredAt: i });
    } else if (snapshotIndexByName.get(name) < i) {
      outOfOrderRefs.push({ name, phase, declaredAt: i, emittedAt: snapshotIndexByName.get(name) });
    }
  }
}

console.log('\nVIEWER CONTRACT (snapshot phase + declaration order)');
console.log(`  frame-snapshot lines           ${snapshots.length}`);
console.log(`  snapshot name declarations     ${declarations.length}`);
console.log(`  emitted before declaration     ${outOfOrderRefs.length}`);
console.log(`  declared but never emitted     ${danglingRefs.length}`);

if (outOfOrderRefs.length) {
  console.log('  ❌ a snapshot is emitted before the action event that names it —');
  console.log('     the modernizer\'s snapshotName→phase map is still empty at that point,');
  console.log('     so `phase` is assigned undefined and the viewer registers no renderer');
  console.log(`     (${outOfOrderRefs.length} reference(s), e.g. ${outOfOrderRefs[0].name})`);
  fail(`${outOfOrderRefs.length} snapshot(s) emitted before their declaring event: ` +
    'phase is lost and no renderer is registered (blank frames in viewer >= 1.63)');
} else if (declarations.length) {
  console.log('  ✅ every declaring event precedes the snapshot it references');
}

if (danglingRefs.length) {
  console.log(`  ❌ ${danglingRefs.length} dangling snapshot reference(s) — the viewer asks for a`);
  console.log('     snapshot that does not exist and falls back to a blank frame');
  for (const d of danglingRefs.slice(0, 3)) console.log(`     ${d.phase}: ${d.name}`);
  fail(`${danglingRefs.length} dangling snapshot reference(s): ` +
    danglingRefs.slice(0, 3).map(d => d.name).join(', '));
} else if (declarations.length) {
  console.log('  ✅ no dangling snapshot references');
}

// ── Viewer contract: console channel ──────────────────────────────────────────
// The viewer reads console output from a top-level `type: "console"` line with a
// `messageType`. Official 1.5-era traces carried console text as
// `type:"event", class:"Page", method:"console"`; that shape is NOT rendered by
// the current viewer, so those messages are silently lost from the Console panel.

const nativeConsole = lines.filter(l => l.type === 'console');
const legacyConsole = lines.filter(l =>
  l.type === 'event' && l.class === 'Page' && l.method === 'console');

console.log('\nVIEWER CONTRACT (console channel)');
console.log(`  native console lines           ${nativeConsole.length}`);
console.log(`  legacy Page.console events     ${legacyConsole.length}`);

if (legacyConsole.length) {
  console.log('  ❌ console output uses the legacy Page.console event shape —');
  console.log('     the viewer renders only top-level type:"console" lines, so these');
  console.log('     messages never appear in the Console panel');
  fail(`${legacyConsole.length} console message(s) use the legacy Page.console shape ` +
    'the viewer does not render');
} else if (nativeConsole.length) {
  const missingType = nativeConsole.filter(l => !l.messageType).length;
  if (missingType) {
    console.log(`  ❌ ${missingType} console line(s) without messageType`);
    fail(`${missingType} native console line(s) lack messageType`);
  } else {
    console.log('  ✅ native console channel with messageType');
  }
} else {
  console.log('  (no console output captured)');
}

// ── Viewer contract: network semantics ────────────────────────────────────────
// The viewer draws a request bar as
//   start    = _monotonicTime - (minimum across resources)
//   duration = time
// so `time` is a DURATION and `_monotonicTime` is the request's start offset.
// Writing the start offset into `time` makes every bar span from its own start to
// the same absolute point, pushing the waterfall far past the recording's end.

console.log('\nVIEWER CONTRACT (network timing + fields)');

if (!netLines.length) {
  console.log('  (no resource-snapshot lines found)');
} else {
  const sameAsStart = netLines.filter(l => l.snapshot.time === l.snapshot._monotonicTime);
  const notNumber = netLines.filter(l => typeof l.snapshot.time !== 'number');
  const negative = netLines.filter(l => typeof l.snapshot.time === 'number' && l.snapshot.time < 0);

  console.log(`  resource-snapshot lines        ${netLines.length}`);
  console.log(`  time === _monotonicTime        ${sameAsStart.length}`);

  if (notNumber.length) {
    console.log(`  ❌ ${notNumber.length} request(s) have a non-numeric time`);
    fail(`${notNumber.length} resource-snapshot line(s) have a non-numeric time`);
  } else if (negative.length) {
    console.log(`  ❌ ${negative.length} request(s) have a negative duration`);
    fail(`${negative.length} resource-snapshot line(s) have a negative time`);
  } else if (sameAsStart.length === netLines.length && netLines.length > 1) {
    console.log('  ❌ `time` equals `_monotonicTime` on every request — the start offset is');
    console.log('     being written where the viewer expects the request DURATION, so the');
    console.log('     waterfall draws every bar to the same absolute point');
    fail('network `time` duplicates `_monotonicTime`: viewer treats it as duration, ' +
      'so request bars extend past the recording end');
  } else {
    // The waterfall must stay inside the recording. Compare the furthest bar end
    // against the span the trace actually covers.
    const ends = netLines.map(l => (l.snapshot._monotonicTime || 0) + (l.snapshot.time || 0));
    const maxEnd = Math.max(...ends);
    const traceEnd = Math.max(
      ...lines.filter(l => typeof l.time === 'number').map(l => l.time),
      ...afters.map(a => a.endTime).filter(t => typeof t === 'number'),
      0);
    console.log(`  furthest bar end               ${Math.round(maxEnd)} ms`);
    console.log(`  recording span                 ${Math.round(traceEnd)} ms`);
    if (traceEnd > 0 && maxEnd > traceEnd * 1.5) {
      console.log(`  ❌ a request bar ends ${Math.round(maxEnd - traceEnd)} ms past the recording —`);
      console.log('     `time` is a start offset, not a duration');
      fail(`network waterfall overruns the recording by ${Math.round(maxEnd - traceEnd)} ms: ` +
        '`time` is being written as a start offset instead of a duration');
    } else {
      console.log('  ✅ request bar durations stay within the recording');
    }
  }

  // Field-level contract: the network list shows a size and offers a resource-type
  // filter; both read fields the official recorder always writes.
  const missingType = netLines.filter(l => !l.snapshot._resourceType);
  const noSize = netLines.filter(l => {
    const r = l.snapshot.response || {};
    const shown = r._transferSize > 0 ? r._transferSize : r.bodySize;
    return typeof shown !== 'number';
  });

  console.log(`  with _resourceType             ${netLines.length - missingType.length}/${netLines.length}`);
  console.log(`  with a displayable size        ${netLines.length - noSize.length}/${netLines.length}`);

  if (missingType.length) {
    console.log(`  ❌ ${missingType.length} request(s) lack _resourceType — the network`);
    console.log('     panel\'s resource-type filter cannot classify them');
    fail(`${missingType.length} resource-snapshot line(s) lack _resourceType`);
  } else {
    console.log('  ✅ resource type present');
  }

  if (noSize.length) {
    console.log(`  ❌ ${noSize.length} request(s) have no displayable size — the network`);
    console.log('     list shows "undefined" instead of the transfer size');
    fail(`${noSize.length} resource-snapshot line(s) expose no _transferSize/bodySize`);
  } else {
    console.log('  ✅ transfer size present');
  }
}

// ── Viewer contract: action target box ────────────────────────────────────────
// The viewer draws a translucent highlight over the element an action addressed
// (`setScreencastAnnotation` reads `box`). It is only used for the `action`
// phase, so a trace without it shows the click point but no element outline.
//
// Only pointer actions are expected to carry one: a keyboard action has no
// element rectangle, and official traces leave `box` absent for those too. So
// the check is scoped to the input lines of pointer actions rather than to every
// input line, which would raise false alarms on keyboard-driven traces.

const POINTER_METHODS = new Set(['click', 'dblclick', 'contextmenu', 'dragTo']);
const pointerCallIds = new Set(
  beforeActions.filter(l => POINTER_METHODS.has(l.method)).map(l => l.callId));

const inputLines = lines.filter(l => l.type === 'input');
const pointerInputs = inputLines.filter(l => pointerCallIds.has(l.callId));
const pointerBoxes = pointerInputs.filter(l => l.box && typeof l.box.width === 'number').length;
const keyboardInputs = inputLines.length - pointerInputs.length;

console.log('\nVIEWER CONTRACT (action target box)');
console.log(`  input lines                    ${inputLines.length}`);
console.log(`  of pointer actions             ${pointerInputs.length} (${keyboardInputs} other)`);
console.log(`  pointer inputs with a box      ${pointerBoxes}`);

if (pointerInputs.length && pointerBoxes === 0) {
  console.log('  ❌ no pointer action carries a box — the viewer draws the click point');
  console.log('     but never outlines the element the action addressed');
  fail(`${pointerInputs.length} pointer action(s) carry no box: ` +
    'the viewer shows no element highlight for them');
} else if (pointerInputs.length) {
  console.log(`  ✅ ${pointerBoxes}/${pointerInputs.length} pointer action(s) carry a box`);
  if (pointerBoxes < pointerInputs.length) {
    warn(`${pointerInputs.length - pointerBoxes} pointer action(s) without a box: ` +
      'no element highlight for those');
  }
}

// ── Viewer contract: action titles ────────────────────────────────────────────
// The viewer titles an action as
//   `title ?? actionMetadata[class + "." + method]?.title ?? method`
// and its metadata table keys element actions as `Frame.*` / `ElementHandle.*`
// only. Two independent ways to lose the title (both observed in this project's
// output before the fix):
//   - a `Page.*` class has no metadata entry, so the row renders as the bare
//     method name ("click") with no selector subtitle, and
//   - `apiName` is copied verbatim into `title` by the v6 -> v8 modernizer,
//     which then SHORT-CIRCUITS the metadata lookup and renders the raw API
//     string (e.g. "Page.click") instead of a human title.
// A gesture that the viewer has a dedicated title for (Hover, Check, Select
// option, Set input files) is only actually labelled if its method survives.

const ACTION_TITLES = {
  click: 'Click', dblclick: 'Double click', fill: 'Fill', press: 'Press',
  hover: 'Hover', check: 'Check', uncheck: 'Uncheck',
  selectOption: 'Select option', setInputFiles: 'Set input files',
  dragAndDrop: 'Drag and drop', goto: 'Navigate', screenshot: 'Screenshot',
  setContent: 'Set content', tap: 'Tap'
};

console.log('\nVIEWER CONTRACT (action titles)');
if (!beforeActions.length) {
  console.log('  (no actions recorded)');
} else {
  const badClass = beforeActions.filter(l => l.class !== 'Frame');
  const withApiName = beforeActions.filter(l => l.apiName);
  const untitled = beforeActions.filter(l => !(l.method in ACTION_TITLES));
  const titled = beforeActions.length - untitled.length;

  console.log(`  actions                        ${beforeActions.length}`);
  console.log(`  with a viewer title            ${titled}`);
  if (untitled.length) {
    const names = [...new Set(untitled.map(l => l.method))].join(', ');
    console.log(`  without a metadata title       ${untitled.length} (${names})`);
  }

  if (badClass.length) {
    console.log(`  ❌ ${badClass.length} action(s) use class "${badClass[0].class}" — the viewer's`);
    console.log('     metadata table lists element actions as Frame.*, so these render');
    console.log('     as the bare method name with no selector subtitle');
    fail(`${badClass.length} action(s) carry class "${badClass[0].class}" instead of "Frame": ` +
      'the viewer cannot resolve a title for them');
  } else {
    console.log('  ✅ every action uses the Frame class');
  }

  if (withApiName.length) {
    console.log(`  ❌ ${withApiName.length} action(s) carry apiName — the modernizer turns it`);
    console.log('     into `title`, which overrides the metadata table entirely');
    fail(`${withApiName.length} action(s) carry apiName, which overrides the viewer title lookup`);
  }

  if (untitled.length) {
    warn(`${untitled.length} action(s) have no viewer title: ` +
      [...new Set(untitled.map(l => l.method))].join(', '));
  }
}

// ── Where the archive weight actually is ──────────────────────────────────────
const screencastSha1 = new Set(screencastLines.map(l => l.sha1));
let shots = 0, res = 0;
for (const e of entries) {
  if (!e.startsWith('resources/')) continue;
  const size = read(e).length;
  if (screencastSha1.has(e.slice('resources/'.length))) shots += size; else res += size;
}
console.log('\nARCHIVE WEIGHT (uncompressed)');
console.log(`  trace.trace                   ${kb(read('trace.trace').length)}`);
console.log(`  screencast frames             ${kb(shots)} (${screencastSha1.size} frames)`);
console.log(`  page resources                ${kb(res)}`);

// ── Verdict ───────────────────────────────────────────────────────────────────
if (warnings.length) {
  console.log('\nWARNINGS');
  for (const w of warnings) console.log(`  ⚠️  ${w}`);
}
if (failures.length) {
  console.log('\nFAILURES');
  for (const f of failures) console.log(`  ❌ ${f}`);
  console.log(`\n❌ ${failures.length} fidelity problem(s) found\n`);
  process.exit(1);
}
console.log('\n✅ stylesheet, reference and viewer-contract checks all pass\n');
process.exit(0);
