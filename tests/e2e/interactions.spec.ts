import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { startServer, PORT } from './support/testPage';
import {
  openSidePanel, attachWorkerCdp, stopAndDownload, readEntry
} from './support/recorder';

/**
 * Mouse gestures beyond the plain left click. A double click must surface as
 * one dblclick action (its second click strike swallowed), a right click as a
 * contextmenu action, and a drag as one dragTo carrying the source element and
 * the drop point instead of the raw click trail. Toggling a checkbox must
 * collapse the click+input+change burst into the single click action — the
 * checked state already rides on the DOM snapshot's __playwright_checked_
 * marker — and that click still pins its red-dot point for the viewer.
 */
test('records dblclick, contextmenu and dragTo, merges checkbox triple events', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    // Real mouse input, the way a user drives the page. Gestures are spaced
    // like a human's so each action's capture round (and therefore its action
    // stage + input line with the point) completes before the next enqueues —
    // a sub-second gesture burst would overflow maxQueuedCaptures and lose the
    // action-stage snapshot that carries the point.
    await page.dblclick('#dbl-target');
    await page.waitForTimeout(1500);
    await page.click('#ctx-target', { button: 'right' });
    await page.waitForTimeout(1500);

    const src = await page.locator('#drag-source').boundingBox();
    const dst = await page.locator('#drop-zone').boundingBox();
    expect(src).toBeTruthy();
    expect(dst).toBeTruthy();
    await page.mouse.move(src!.x + src!.width / 2, src!.y + src!.height / 2);
    await page.mouse.down();
    await page.mouse.move(dst!.x + dst!.width / 2, dst!.y + dst!.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(1500);

    // Dragging across text to SELECT it: a selection, not a drag - must not
    // surface as an additional dragTo.
    const cell = page.locator('table tr').first().locator('td').nth(0);
    const cellBox = await cell.boundingBox();
    expect(cellBox).toBeTruthy();
    await page.mouse.move(cellBox!.x + 6, cellBox!.y + cellBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(cellBox!.x + cellBox!.width + 30, cellBox!.y + cellBox!.height / 2, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    
await page.click('#check2');
    await page.waitForTimeout(1500);

    const outDir = path.join(__dirname, '..', 'test-results', 'interactions');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const befores = lines.filter(l => l.type === 'before');
    const methods = befores.map(b => b.method);
    console.log('action methods:', methods.join(','));

    expect(methods).toContain('dblclick');
    expect(methods).toContain('contextmenu');
    expect(methods).toContain('dragTo');
    expect(befores.filter(b => b.method === 'dragTo')).toHaveLength(1);   // selection drag adds none

    const dbl = befores.find(b => b.method === 'dblclick');
    // The double click's second strike is swallowed; only the first survives.
    expect(befores.filter(b => b.method === 'click' && b.params.selector === dbl!.params.selector))
      .toHaveLength(1);

    const drag = befores.find(b => b.method === 'dragTo');
    expect(drag!.params.sourceSelector).toBeTruthy();
    expect(drag!.params.point).toEqual({ x: expect.any(Number), y: expect.any(Number) });

    // Checkbox: one click action, no input/change stragglers behind it.
    expect(befores.filter(b => b.params.selector === '#check2')).toHaveLength(1);
    expect(befores.some(b => b.method === 'input' && b.params.selector === '#check2')).toBe(false);

    const click = befores.find(b => b.method === 'click' && b.params.selector === '#check2');
    const inputLine = lines.find(l => l.type === 'input' && l.callId === click!.callId);
    expect(inputLine!.point).toBeTruthy();  // viewer red circle
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
