import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { startServer, PORT } from './support/testPage';
import {
  openSidePanel, attachWorkerCdp, stopAndDownload, readEntry
} from './support/recorder';

/**
 * A burst of clicks dispatched from one macro task used to outrun the capture
 * queue: maxQueuedCaptures gated the whole capture round, so overflow actions
 * lost BOTH their action and after snapshots, while the exporter still wrote an
 * input line pointing at a snapshot that was never taken. Overflow actions must
 * keep their before stage (a reference to the last snapshot) and always land an
 * after stage; only the action stage may be skipped — and a skipped action
 * stage must not leave a dangling inputSnapshot reference behind.
 */
test('burst actions always carry after snapshots and never dangle input lines', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();
    // The child frame must be attached before recording starts so the burst
    // competes with multi-frame captures, not frame attachment.
    await expect(page.frameLocator('#childFrame').locator('#frame-title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    // One macro task enqueues every click, reproducing the 567ms/8-action burst.
    await page.evaluate(() => document.querySelectorAll('.burst').forEach(b => b.click()));
    // Let the capture queue drain so every action's after snapshot lands.
    await page.waitForTimeout(10_000);

    const outDir = path.join(__dirname, '..', 'test-results', 'burst-actions');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const befores = lines.filter(l => l.type === 'before');
    const afters = lines.filter(l => l.type === 'after');
    const frameSnapshotLines = lines.filter(l => l.type === 'frame-snapshot');

    const clicks = befores.filter(b => b.method === 'click');
    expect(clicks).toHaveLength(8);
    expect(afters).toHaveLength(befores.length);

    // The after snapshot is unconditional: no burst action may lose it.
    for (const a of afters) expect(a.afterSnapshot).toBeTruthy();
    const names = new Set(frameSnapshotLines.map(l => l.snapshot.snapshotName));
    for (const a of afters) expect(names.has(a.afterSnapshot)).toBe(true);

    // The action stage is gated by maxQueuedCaptures: the first clicks keep it,
    // the suppressed ones must not emit a dangling inputSnapshot reference.
    const inputs = lines.filter(l => l.type === 'input');
    expect(inputs.length).toBeGreaterThanOrEqual(4);
    expect(inputs.length).toBeLessThanOrEqual(8);
    for (const inp of inputs) expect(names.has(inp.inputSnapshot)).toBe(true);

    // Click coordinates are passed through so the viewer can pin the red dot.
    // Synthetic element.click() carries clientX/clientY = 0.
    for (const inp of inputs) expect(inp.point).toEqual({ x: 0, y: 0 });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
