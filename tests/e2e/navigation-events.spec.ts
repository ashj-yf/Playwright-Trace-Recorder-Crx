import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { startServer, PORT } from './support/testPage';
import {
  openSidePanel, attachWorkerCdp, stopAndDownload, readEntry
} from './support/recorder';

/**
 * SPA routing (history.pushState) and full-page navigations used to leave the
 * trace with zero navigation events: the CDP whitelist had no Page.* branch and
 * rec.url was only backfilled once at recording start. Both navigation kinds
 * must land as Frame.navigated lines, metadata must carry the FINAL url (the
 * CDP navigation handler owns rec.url now — behavior change: it used to be the
 * first url), and consecutive same-URL duplicates for one frame — e.g. the
 * Page.reload echo at recording start — must be deduplicated at export.
 */
test('records SPA pushState and full-page navigations as Frame.navigated', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    // SPA route change: same-document navigation via history.pushState.
    await page.locator('#spa-push').click();
    await expect(page).toHaveURL(/\/spa-route$/);
    // Let the click's snapshot round finish before tearing the document down.
    await page.waitForTimeout(1_500);

    // Full-page navigation: the main frame swaps its CDP frame id.
    await page.goto(`http://localhost:${PORT}/frame.html`);
    await expect(page.locator('#frame-title')).toBeVisible();

    const outDir = path.join(__dirname, '..', 'test-results', 'navigation-events');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const navs = lines.filter(l => l.type === 'event' && l.class === 'Frame' && l.method === 'navigated');
    console.log('navigations:', navs.map(n => `[${n.params.name || ''}] ${n.params.url}`).join(' | '));
    expect(navs.length).toBeGreaterThanOrEqual(3);                    // 初始合成 + pushState + 整页
    expect(navs.some(n => n.params.url.endsWith('/spa-route'))).toBe(true);
    expect(navs.some(n => n.params.url.endsWith('/frame.html'))).toBe(true);
    expect(navs.every(n => typeof n.params.name === 'string')).toBe(true);
    const urls = navs.map(n => n.params.url);
    expect(new Set(urls).size).toBe(urls.length);                     // 同 frame 连续同 URL 去重
    expect(JSON.parse(readEntry(zipPath, 'metadata.json').toString()).pages[0].url)
      .toContain('/frame.html');                                      // rec.url 最终 URL（行为变更：原为首 URL）
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
