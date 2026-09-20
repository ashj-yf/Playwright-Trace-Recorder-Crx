import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { startServer, PORT } from './support/testPage';
import {
  openSidePanel, attachWorkerCdp, stopAndDownload, readEntry
} from './support/recorder';

/**
 * The content script must run in every frame, not just the top one: the user's
 * interactions land inside the iframe document, so its own listeners are the
 * only ones that see them (DOM events never cross the frame boundary). The
 * selector is resolved against the iframe's document, where `#frame-btn` is a
 * plain id hit — the same shape codegen produces for a top-frame button.
 */
test('records a click inside an iframe', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();
    // The child frame document must have loaded (and therefore be attached as a
    // flattened CDP target) before recording starts.
    await expect(page.frameLocator('#childFrame').locator('#frame-title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    await page.frameLocator('#childFrame').locator('#frame-btn').click();
    await page.waitForTimeout(1500);

    const outDir = path.join(__dirname, '..', 'test-results', 'iframe-interactions');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const befores = lines.filter(l => l.type === 'before');
    console.log('action methods:', befores.map(b => b.method).join(','));

    expect(befores.some(b => b.method === 'click' && b.params.selector === '#frame-btn')).toBe(true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
