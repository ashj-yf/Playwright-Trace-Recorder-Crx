import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { startServer, PORT } from './support/testPage';
import {
  openSidePanel, attachWorkerCdp, stopAndDownload, readEntry
} from './support/recorder';
import { renderSnapshots } from './support/snapshotOracle';

/**
 * One typing burst used to produce one keydown action PER KEYSTROKE, each with
 * a full before/action/after DOM snapshot round and a screenshot. Playwright
 * codegen collapses a burst into a single fill; the recorder must do the same,
 * while special keys (Enter, modifier chords) survive as press actions.
 */
test('coalesces a typing burst into one fill action', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    await page.locator('#field').click();
    // Character-by-character input: 15 keydowns + 15 input events.
    await page.keyboard.type('HelloPlaywright', { delay: 10 });
    // Special keys are not part of the text value and must stay press actions.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+a');

    // Interrupt the burst with a click, reset the field, then type a second
    // burst — it must become a second fill, not be folded into the first.
    await page.locator('#btn1').click();
    await page.locator('#field').fill('');
    await page.keyboard.type('second burst', { delay: 10 });
    await page.waitForTimeout(1500);

    const outDir = path.join(__dirname, '..', 'test-results', 'fill-coalescing');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const befores = lines.filter(l => l.type === 'before');
    const methods = befores.map(b => b.method);
    console.log('action methods:', methods.join(','));

    // No per-keystroke legacy events leak through.
    expect(methods).not.toContain('keydown');
    expect(methods).not.toContain('input');

    const fills = befores.filter(b => b.method === 'fill');
    expect(fills.length).toBe(2);
    expect(fills[0].params.selector).toBe('#field');
    expect(fills[0].params.value).toBe('HelloPlaywright');
    expect(fills[1].params.value).toBe('second burst');

    const presses = befores.filter(b => b.method === 'press');
    expect(presses.some(p => p.params.key === 'Enter')).toBe(true);
    expect(presses.some(p => p.params.key === 'Control+a')).toBe(true);

    // Every coalesced fill/press still carries all three snapshot stages.
    const snapshotNames = new Set(
      lines.filter(l => l.type === 'frame-snapshot').map(l => l.snapshot.snapshotName));
    for (const action of [...fills, ...presses]) {
      for (const stage of ['before', 'action', 'after']) {
        expect(snapshotNames.has(`${stage}@${action.callId}`),
          `missing ${stage} snapshot for ${action.method} ${action.callId}`).toBe(true);
      }
    }

    // The final live value rides on the second fill's DOM snapshots. The INPUT
    // node is usually a back-reference to a subtree serialized in an earlier
    // snapshot, so references must be resolved via the Playwright renderer.
    const secondFillCallId = fills[1].callId;
    const finalStages = renderSnapshots(
      lines.filter(l => l.type === 'frame-snapshot')
    ).filter(r =>
      [`action@${secondFillCallId}`, `after@${secondFillCallId}`].includes(r.name));
    expect(finalStages.some(r => r.html.includes('second burst'))).toBe(true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
