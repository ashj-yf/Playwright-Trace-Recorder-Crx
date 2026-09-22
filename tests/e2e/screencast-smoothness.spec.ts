import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { startServer, PORT } from './support/testPage';
import {
  openSidePanel, attachWorkerCdp, stopAndDownload, readEntry, listEntries
} from './support/recorder';

/**
 * The trace viewer draws its filmstrip, and repaints canvases, from
 * `screencast-frame` lines. The recorder used to produce those by taking one
 * Page.captureScreenshot per action, so frames existed only at action
 * boundaries: a session measured at ~1.5 fps with a ~980 ms median frame gap,
 * against ~15 fps for an official recording. The result looked "less smooth"
 * in the viewer even though every individual frame was valid.
 *
 * The decisive test is to ANIMATE THE PAGE AND PERFORM NO ACTIONS AT ALL. A
 * per-action recorder is structurally incapable of producing a single frame
 * under those conditions, so this cannot pass by accident — it only passes if
 * frames are streamed from the page's own rendering, which is what
 * Page.startScreencast provides.
 */
test('streams screencast frames continuously, not one per action', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    // A continuously repainting page, with no user interaction whatsoever.
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'animating-box';
      box.style.cssText =
        'position:fixed;left:0;top:0;width:160px;height:160px;background:lime;z-index:2147483000';
      document.body.appendChild(box);
      let x = 0;
      const step = () => {
        x = (x + 9) % Math.max(1, window.innerWidth - 160);
        box.style.transform = `translateX(${x}px)`;
        box.style.background = `hsl(${x % 360}, 90%, 50%)`;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    // Long enough that a streamed capture accumulates many frames.
    await page.waitForTimeout(5_000);

    const outDir = path.join(__dirname, '..', 'test-results', 'screencast-smoothness');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const frames = lines.filter(l => l.type === 'screencast-frame');
    const actions = lines.filter(l => l.type === 'before');

    console.log(`actions: ${actions.length}, screencast frames: ${frames.length}`);

    // The whole point: frames must exist even though nothing was clicked.
    expect(actions.length).toBe(0);
    expect(frames.length).toBeGreaterThan(0);

    const times = frames.map(f => f.timestamp).sort((a, b) => a - b);
    const span = times[times.length - 1] - times[0];
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];

    console.log(`screencast: ${frames.length} frames over ${Math.round(span)} ms ` +
      `(${(frames.length / (span / 1000)).toFixed(1)} fps, median gap ${Math.round(median)} ms)`);

    // A streamed capture of an animating page is dense. The per-action recorder
    // produced 0 frames here; a regression to a slower polling capture would
    // show up as a handful of very widely spaced frames.
    if (gaps.length) {
      expect(median).toBeLessThan(250);
    }

    // Every frame must be a real, resolvable image: the viewer renders a blank
    // tile for a frame whose resource is absent from the archive.
    const resources = new Set(
      listEntries(zipPath)
        .filter(e => e.startsWith('resources/'))
        .map(e => e.slice('resources/'.length))
    );
    for (const f of frames) {
      expect(resources.has(f.sha1), `frame resource ${f.sha1} missing`).toBe(true);
      expect(f.width).toBeGreaterThan(0);
      expect(f.height).toBeGreaterThan(0);
      // frameSwapWallTime is the absolute instant the viewer pairs snapshots by.
      expect(f.frameSwapWallTime).toBeGreaterThan(1e11);
      // timestamp stays a trace-relative offset.
      expect(f.timestamp).toBeLessThan(1e11);
    }

    // Frames must be spread across the recording rather than bunched at one end.
    expect(span).toBeGreaterThan(1_000);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

/**
 * The other half of the rate policy: an idle page is throttled to ~5 fps, but
 * an ACTION must be captured at full frame rate. Throttling without the
 * unthrottle window would make every action look choppy, which is the same
 * complaint from the opposite direction.
 *
 * Verified by frame density: frames around the action must be denser than the
 * idle baseline (the official recorder's `unthrottleDuration` window).
 */
test('captures an action at a higher frame rate than an idle page', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    // A page that repaints continuously, so the screencast always has something
    // to send and the only limiter is our own policy.
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'animating-box';
      box.style.cssText =
        'position:fixed;left:0;top:0;width:160px;height:160px;background:lime;z-index:2147483000';
      document.body.appendChild(box);
      let x = 0;
      const step = () => {
        x = (x + 9) % Math.max(1, window.innerWidth - 160);
        box.style.transform = `translateX(${x}px)`;
        box.style.background = `hsl(${x % 360}, 90%, 50%)`;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    // A long idle stretch first, to establish the throttled baseline.
    await page.waitForTimeout(3_000);
    const idleEnd = Date.now();
    await page.locator('#btn1').click();
    const actionAt = Date.now();
    await page.waitForTimeout(3_000);

    const outDir = path.join(__dirname, '..', 'test-results', 'screencast-action-rate');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const frames = lines.filter(l => l.type === 'screencast-frame');
    const actions = lines.filter(l => l.type === 'before');
    expect(actions.length).toBeGreaterThan(0);

    // Frames are stamped on the trace-relative clock; the action's own instant
    // is the anchor. Compare frame density inside the unthrottle window against
    // the whole recording.
    const action = actions[0];
    const actionTs = action.startTime as number;
    const WINDOW = 500;                       // SCREENCAST_UNTHROTTLE_MS
    const inWindow = frames.filter(
      f => Math.abs((f.timestamp as number) - actionTs) <= WINDOW);
    const times = frames.map(f => f.timestamp as number).sort((a, b) => a - b);
    const span = times[times.length - 1] - times[0];
    const overallRate = frames.length / (span / 1000);
    const windowSpan = Math.min(WINDOW * 2, span);
    const windowRate = inWindow.length / (windowSpan / 1000);

    console.log(`overall ${overallRate.toFixed(1)} fps · around action ` +
      `${windowRate.toFixed(1)} fps (${inWindow.length} frames in ±${WINDOW} ms)`);

    // The action window must be measurably denser than the idle baseline.
    expect(windowRate).toBeGreaterThan(overallRate);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
