import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import {
  startServer, PORT, SCROLLED_INTO_VIEW_TEXT, CANVAS_ID,
  SCROLL_VIEWPORT_PX, SCROLL_CONTENT_PX, DIALOG_ID
} from './support/testPage';
import {
  openSidePanel, attachWorkerCdp, stopAndDownload, readEntry
} from './support/recorder';

/**
 * The trace viewer restores a snapshot through a set of attributes that
 * playwright-core both writes and reads. Recording without them produced traces
 * that looked like they had lost content: scrolled containers snapped back to
 * the top (so everything below the fold was unreachable), canvases could never
 * be repainted from the screencast, the interacted element was not outlined, and
 * every snapshot was paired with the wrong screencast frame because wallTime was
 * written in the wrong unit.
 *
 * This asserts the contract from the recorded archive, so it fails if any of
 * those markers stops being emitted.
 */

/** Depth-first visit of every materialized element in a snapshot tree. */
function eachElement(node: any, visit: (tag: string, attrs: any) => void): void {
  if (typeof node === 'string' || !Array.isArray(node)) return;
  if (Array.isArray(node[0])) return;                 // back-reference
  if (typeof node[0] !== 'string') return;
  visit(node[0], node[1]);
  for (let i = 2; i < node.length; i++) eachElement(node[i], visit);
}

function collectMarkers(frameSnapshots: any[]) {
  const markers: Record<string, any[]> = {};
  for (const line of frameSnapshots) {
    eachElement(line.snapshot.html, (tag, attrs) => {
      if (!attrs) return;
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith('__playwright_')) (markers[key] ||= []).push({ tag, value });
      }
    });
  }
  return markers;
}

test('snapshots carry the markers the viewer needs to restore what was on screen', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();
    await expect(page.locator('#childFrame').contentFrame().locator('#frame-title')).toBeVisible();

    // Scroll the container, then interact with something INSIDE it: the action
    // snapshot has to remember the offset, not just the element.
    await page.locator('#scroll-viewport').evaluate(
      (el, px) => { (el as HTMLElement).scrollTop = px as number; },
      SCROLL_CONTENT_PX - SCROLL_VIEWPORT_PX);
    await page.locator('#folded-content').scrollIntoViewIfNeeded();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    // Keep the container scrolled while the recording captures it.
    await page.locator('#scroll-viewport').evaluate(
      (el, px) => { (el as HTMLElement).scrollTop = px as number; },
      SCROLL_CONTENT_PX - SCROLL_VIEWPORT_PX);
    await page.locator('#btn1').click();
    await page.waitForTimeout(1_500);

    // A dialog whose open state exists only at runtime.
    await page.locator('#dialog-open').click();
    await expect(page.locator(`#${DIALOG_ID}`)).toBeVisible();
    await page.waitForTimeout(1_500);

    const outDir = path.join(__dirname, '..', 'test-results', 'snapshot-markers');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const frameSnapshots = lines.filter(l => l.type === 'frame-snapshot');
    const markers = collectMarkers(frameSnapshots);
    const markerNames = Object.keys(markers).sort();
    console.log('markers present:', markerNames.join(', ') || '(none)');

    // Scroll position: without this the viewer pins every container to the top.
    expect(markers['__playwright_scroll_top_']?.length).toBeGreaterThan(0);
    const scrollTop = Number(markers['__playwright_scroll_top_'][0].value);
    expect(scrollTop).toBe(SCROLL_CONTENT_PX - SCROLL_VIEWPORT_PX);

    // Canvas bounding rect: without it the viewer skips canvas repaint entirely.
    expect(markers['__playwright_bounding_rect_']?.length).toBeGreaterThan(0);
    const canvasRect = markers['__playwright_bounding_rect_']
      .find(m => m.tag === 'CANVAS');
    expect(canvasRect, `canvas #${CANVAS_ID} needs a bounding rect`).toBeTruthy();
    const rect = JSON.parse(canvasRect!.value);
    for (const key of ['left', 'top', 'right', 'bottom'])
      expect(typeof rect[key]).toBe('number');
    expect(rect.right).toBeGreaterThan(rect.left);

    // Target highlight: the element an action addressed is outlined by callId.
    expect(markers['__playwright_target__']?.length).toBeGreaterThan(0);
    const targetCallIds = new Set(markers['__playwright_target__'].map(m => m.value));
    const actionCallIds = new Set(lines.filter(l => l.type === 'before').map(l => l.callId));
    for (const id of targetCallIds) expect(actionCallIds.has(id)).toBe(true);

    // Runtime dialog visibility cannot be inferred from markup.
    expect(markers['__playwright_dialog_open_']?.length).toBeGreaterThan(0);

    // wallTime must be an absolute epoch, or the viewer pairs every snapshot
    // with the same screencast frame.
    for (const line of frameSnapshots) {
      expect(typeof line.snapshot.wallTime).toBe('number');
      expect(line.snapshot.wallTime).toBeGreaterThan(1e11);
      // timestamp stays a relative offset within the recording.
      expect(line.snapshot.timestamp).toBeLessThan(1e11);
    }

    // Action duration is measured, not a constant.
    const befores = lines.filter(l => l.type === 'before');
    const afters = lines.filter(l => l.type === 'after');

    // ── Screencast density ───────────────────────────────────────────────────
    // The filmstrip is drawn from `screencast-frame` lines. Emitting one per
    // action (a screenshot) instead of streaming them left the strip near-empty
    // and the recording visibly less smooth than an official one, even though
    // every individual frame was valid — so frame COUNT alone proves nothing.
    //
    // The structural property is that frames arrive on the page's own schedule,
    // not the recorder's: a per-action capture can only ever be stamped with an
    // action's start or end instant. Measured on real traces, official
    // recordings land ~0-14% of frames on a boundary; a per-action recorder
    // scores a deterministic 100%.
    const screencastFrames = lines.filter(l => l.type === 'screencast-frame');
    console.log(`screencast frames: ${screencastFrames.length}`);
    expect(screencastFrames.length).toBeGreaterThan(0);

    const contextOptions = lines.find(l => l.type === 'context-options')!;
    const baseWall = contextOptions.wallTime as number;
    const boundaries = [
      ...befores.map(b => (b.wallTime as number) ?? baseWall + (b.startTime as number)),
      ...afters.map(a => (a.wallTime as number) ?? baseWall + (a.endTime as number))
    ];
    const onBoundary = screencastFrames.filter(f =>
      boundaries.some(b => Math.abs((f.frameSwapWallTime as number) - b) <= 5));
    console.log(`screencast frames on an action boundary: ${onBoundary.length}/${screencastFrames.length}`);
    expect(onBoundary.length).toBeLessThan(screencastFrames.length);

    // Frame timing must be usable as a timeline: absolute wall clock the viewer
    // pairs snapshots against, plus a trace-relative offset.
    for (const f of screencastFrames) {
      expect(f.frameSwapWallTime).toBeGreaterThan(1e11);
      expect(typeof f.timestamp).toBe('number');
      expect(f.timestamp).toBeLessThan(1e11);
      expect(f.width).toBeGreaterThan(0);
      expect(f.height).toBeGreaterThan(0);
    }

    // The stream must actually span the recording rather than bunching at one
    // end — that is what makes scrubbing feel continuous.
    const frameTimes = screencastFrames.map(f => f.timestamp).sort((a, b) => a - b);
    const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
    console.log(`screencast span: ${span} ms across ${screencastFrames.length} frames`);
    if (frameTimes.length > 1) expect(span).toBeGreaterThan(200);

    // Action duration is measured, not a constant.
    const durations = befores
      .map(b => {
        const a = afters.find(x => x.callId === b.callId);
        return a ? a.endTime - b.startTime : null;
      })
      .filter((d): d is number => d !== null);
    expect(durations.length).toBeGreaterThan(0);
    expect(durations.every(d => d >= 0)).toBe(true);
    console.log('action durations (ms):', durations.join(', '));

    // The device scale factor must agree with the real screenshot pixels.
    const metadata = JSON.parse(readEntry(zipPath, 'metadata.json').toString());
    const screencast = lines.filter(l => l.type === 'screencast-frame');
    if (screencast.length) {
      const sha1 = screencast[0].sha1;
      const jpeg = readEntry(zipPath, `resources/${sha1}`);
      // SOF marker: dimensions are at offset +5/+7 from the marker prefix.
      let width = 0;
      let i = 2;
      while (i + 9 < jpeg.length) {
        if (jpeg[i] !== 0xff) { i++; continue; }
        const marker = jpeg[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf &&
            marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          width = jpeg.readUInt16BE(i + 7);
          break;
        }
        const len = jpeg.readUInt16BE(i + 2);
        if (len <= 0) break;
        i += 2 + len;
      }
      expect(width).toBeGreaterThan(0);
      // Declared size must match the real pixels, or the declared scale factor
      // must explain the difference.
      const declared = Number(screencast[0].width);
      const declaredDsf = Number(metadata.options.deviceScaleFactor);
      const explained = Math.abs(declared - width) <= 2 ||
        Math.abs(declared * declaredDsf - width) <= 2;
      expect(explained,
        `screencast declares ${declared}px but the JPEG is ${width}px ` +
        `(deviceScaleFactor ${declaredDsf})`).toBe(true);
    }

    // The scrolled-away text is still in the DOM: the snapshot must contain it,
    // so what the viewer "hides" is purely the missing scroll offset.
    const allText = JSON.stringify(frameSnapshots);
    expect(allText).toContain(SCROLLED_INTO_VIEW_TEXT);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
