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

// ── Viewer contract: action duration ──────────────────────────────────────────
const befores = lines.filter(l => l.type === 'before');
const afters = lines.filter(l => l.type === 'after');
const durations = [];
for (const b of befores) {
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
