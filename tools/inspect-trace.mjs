#!/usr/bin/env node
/**
 * Inspects a recorded trace archive and reports on the two things that used to be
 * broken: whether stylesheets were captured whole, and whether repeated DOM was
 * stored by reference instead of duplicated.
 *
 * Usage:  node tools/inspect-trace.mjs <recording.zip>
 *
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

// ── Stylesheets ───────────────────────────────────────────────────────────────
// A <style> whose text is exactly 5001 chars and ends in an ellipsis is the
// signature of the old per-text-node cap chopping the stylesheet.
const styles = [];
const walkStyles = node => {
  if (typeof node === 'string' || !Array.isArray(node)) return;
  if (typeof node[0] !== 'string') return;              // back-reference
  if (node[0] === 'STYLE')
    styles.push(node.slice(2).filter(c => typeof c === 'string').join(''));
  for (let i = 2; i < node.length; i++) walkStyles(node[i]);
};
for (const s of snapshots) walkStyles(s.snapshot.html);

const truncated = styles.filter(t => t.endsWith('…'));
const cssTotal = styles.reduce((a, t) => a + t.length, 0);
console.log('STYLESHEETS');
console.log(`  materialized <style> elements   ${styles.length}`);
console.log(`  total CSS captured             ${kb(cssTotal)}`);
if (styles.length) {
  const sorted = [...styles].sort((a, b) => b.length - a.length);
  console.log(`  largest / smallest            ${sorted[0].length} / ${sorted[sorted.length - 1].length} chars`);
}
console.log(truncated.length
  ? `  ❌ ${truncated.length} stylesheet(s) TRUNCATED (end in "…") — layout rules are missing`
  : `  ✅ none truncated`);

// ── Snapshot referencing ──────────────────────────────────────────────────────
const hasRef = node => Array.isArray(node) &&
  (Array.isArray(node[0]) || node.slice(2).some(hasRef));
const sizes = snapshots.map(s => JSON.stringify(s).length);
const withRefs = snapshots.filter(s => hasRef(s.snapshot.html)).length;
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
  console.log(withRefs > 0
    ? `  ✅ referencing active — full dumps would cost roughly ${kb(naive)}`
    : `  ❌ no back-references found — every snapshot is a full DOM dump`);
}

// ── Where the archive weight actually is ──────────────────────────────────────
const screencastSha1 = new Set(lines.filter(l => l.type === 'screencast-frame').map(l => l.sha1));
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

const verdict = truncated.length === 0 && (snapshots.length < 2 || withRefs > 0);
console.log(`\n${verdict ? '✅ both fixes are active in this build' :
  '❌ this trace came from a build without both fixes'}\n`);
process.exit(verdict ? 0 : 1);
