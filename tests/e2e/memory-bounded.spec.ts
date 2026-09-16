import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { startServer, PORT, BIG_MEDIA_BYTES, BIG_IMAGE_BYTES } from './support/testPage';
import {
  openSidePanel, attachWorkerCdp, driveInteractions, stopAndDownload,
  readEntry, listEntries
} from './support/recorder';

/**
 * Recording used to accumulate every DOM snapshot, screenshot and network
 * response body in the service worker heap, which crashed the extension on long
 * sessions. This asserts the heap now stays flat while the archive stays valid.
 */
test('keeps worker memory bounded while producing a valid trace', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    const cdp = await attachWorkerCdp(context, extensionId);

    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    const heapAfterStart = await cdp.heapMb();
    await driveInteractions(page, 12);
    // Let the capture queue drain before sampling.
    await page.waitForTimeout(4000);
    const heapBeforeStop = await cdp.heapMb();

    const growthMb = heapBeforeStop - heapAfterStart;
    console.log(`Worker heap: ${heapAfterStart.toFixed(1)} MB -> ${heapBeforeStop.toFixed(1)} MB ` +
      `(growth ${growthMb.toFixed(1)} MB across 48 interactions)`);
    // Snapshots, screenshots and response bodies now live in IndexedDB. Holding
    // them in the heap instead cost ~89 MB for exactly this workload.
    expect(growthMb).toBeLessThan(25);

    const outDir = path.join(__dirname, '..', 'test-results', 'memory-bounded');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    // ── Archive integrity ────────────────────────────────────────────────────
    execFileSync('unzip', ['-t', zipPath]);
    const entries = listEntries(zipPath);
    console.log(`Trace archive: ${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB, ${entries.length} entries`);

    expect(entries).toContain('metadata.json');
    expect(entries).toContain('trace.trace');
    expect(entries).toContain('trace.network');

    const metadata = JSON.parse(readEntry(zipPath, 'metadata.json').toString());
    expect(metadata.version).toBe(6);
    expect(metadata.pages?.[0]?.pageId).toMatch(/^page@/);

    // ── Trace stream ─────────────────────────────────────────────────────────
    const traceLines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const byType = new Map<string, number>();
    for (const line of traceLines) byType.set(line.type, (byType.get(line.type) || 0) + 1);
    console.log('trace.trace line types:', Object.fromEntries(byType));

    expect(traceLines[0].type).toBe('context-options');
    expect(byType.get('before')).toBeGreaterThan(10);
    expect(byType.get('after')).toBe(byType.get('before'));
    expect(byType.get('frame-snapshot')).toBeGreaterThan(10);
    expect(byType.get('screencast-frame')).toBeGreaterThan(10);

    const snapshot = traceLines.find(l => l.type === 'frame-snapshot');
    expect(Array.isArray(snapshot.snapshot.html)).toBe(true);
    expect(snapshot.snapshot.html[0]).toBe('HTML');
    const overrides = snapshot.snapshot.resourceOverrides || [];
    expect(overrides.some((o: any) => o.url.includes('big.css'))).toBe(true);

    // Every referenced resource must actually exist in the archive.
    const resourceEntries = new Set(
      entries.filter(e => e.startsWith('resources/')).map(e => e.slice('resources/'.length))
    );
    for (const override of overrides) expect(resourceEntries.has(override.sha1)).toBe(true);
    for (const line of traceLines) {
      if (line.type === 'screencast-frame') expect(resourceEntries.has(line.sha1)).toBe(true);
    }

    // ── Retention policy ─────────────────────────────────────────────────────
    const sizes = [...resourceEntries].map(name => ({
      name,
      size: readEntry(zipPath, `resources/${name}`).length
    }));
    const largest = Math.max(...sizes.map(s => s.size));
    console.log(`Largest stored resource: ${(largest / 1024).toFixed(0)} KB of ${sizes.length} resources`);

    // Only the per-body safety cap bounds a single resource; the archive must
    // keep the multi-megabyte media and the script bundle instead of dropping
    // them on the floor.
    expect(largest).toBeLessThan(64 * 1024 * 1024);
    expect(sizes.some(s => s.size >= BIG_MEDIA_BYTES)).toBe(true);
    expect(sizes.some(s => s.size >= BIG_IMAGE_BYTES)).toBe(true);
    // Every retained body is deflated into the zip; the raw entries validate.
    execFileSync('unzip', ['-t', zipPath]);

    // The stylesheet is fetched once per recording rather than once per snapshot,
    // and is content-addressed — so exactly one copy exists however many
    // snapshots reference it.
    const cssEntries = sizes.filter(s => s.name.endsWith('.css'));
    expect(cssEntries.length).toBeLessThanOrEqual(2);
    expect(byType.get('frame-snapshot')!).toBeGreaterThan(10 * cssEntries.length);

    const networkLines = readEntry(zipPath, 'trace.network').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    console.log(`trace.network entries: ${networkLines.length}`);
    expect(networkLines.length).toBeGreaterThan(0);

    // Script and media bodies are part of a complete recording and must be
    // stored as resources referenced by _sha1.
    const jsEntry = networkLines.find(l => l.snapshot.request.url.includes('app.js'));
    expect(jsEntry, 'app.js request missing').toBeTruthy();
    expect(jsEntry.snapshot.response.content._sha1).toBeTruthy();
    const videoEntry = networkLines.find(l => l.snapshot.request.url.includes('huge.mp4'));
    expect(videoEntry, 'huge.mp4 request missing').toBeTruthy();
    expect(videoEntry.snapshot.response.content._sha1).toBeTruthy();
    for (const line of networkLines) {
      const sha1 = line.snapshot.response.content?._sha1;
      if (sha1) expect(resourceEntries.has(sha1)).toBe(true);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
