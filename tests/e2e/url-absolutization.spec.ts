import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { startServer, PORT } from './support/testPage';
import {
  openSidePanel, attachWorkerCdp, driveInteractions, stopAndDownload,
  readEntry, listEntries
} from './support/recorder';
import { renderSnapshots, buildResourceOracle } from './support/snapshotOracle';

/**
 * The trace viewer serves snapshot resources by exact absolute-URL string
 * matching, so a DOM snapshot that keeps relative paths (`/small.png`) can
 * never hit the resource table — every stylesheet and image 404s in the viewer.
 * This asserts the recorder serializes URL-bearing attributes (and inline
 * style url()) as absolute URLs, and checks the result against Playwright's own
 * SnapshotStorage — the code the viewer runs — instead of a re-implementation.
 */
test('absolutizes resource URLs so the viewer can serve them', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();
    await expect(page.frameLocator('#childFrame').locator('#frame-title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    await driveInteractions(page, 2);
    await page.waitForTimeout(4000);

    const outDir = path.join(__dirname, '..', 'test-results', 'url-absolutization');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const snapshots = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l))
      .filter(l => l.type === 'frame-snapshot');
    expect(snapshots.length).toBeGreaterThan(5);

    const mainFrameId = snapshots[0].snapshot.frameId;
    // The first snapshot of a frame is fully materialized; later ones may
    // compress unchanged subtrees into back-references, so literal attribute
    // strings are asserted on the first line, and the every-snapshot guarantee
    // on the renderer's expanded HTML and on the negative pattern below.
    const rawMain = snapshots
      .filter(s => s.snapshot.frameId === mainFrameId)
      .map(s => JSON.stringify(s.snapshot.html));
    expect(rawMain.length).toBeGreaterThan(2);

    // ── Raw serialization: URL attributes are absolute (or cleared) ─────────
    expect(rawMain[0]).toContain('"href":"http://localhost:8153/big.css"');
    expect(rawMain[0]).toContain('"src":"http://localhost:8153/small.png"');
    expect(rawMain[0]).toContain('"href":"http://localhost:8153/frame.html"');
    expect(rawMain[0]).toContain('"poster":"http://localhost:8153/small.png"');
    expect(rawMain[0]).toContain('"data":"http://localhost:8153/small.png"');
    expect(rawMain[0]).toContain('"__playwright_current_src__":"http://localhost:8153/small.png"');
    expect(rawMain[0]).toContain('url(http://localhost:8153/small.png)');   // inline style url()
    expect(rawMain[0]).toContain('__playwright_style_sheet_":".adopted-sentinel { color: rgb(6, 5, 4); background: url(http://localhost:8153/small.png)');   // adopted sheet url()
    expect(rawMain[0]).toContain('"srcset":"http://localhost:8153/small.png 1x');
    expect(rawMain[0]).toContain('"href":"#sym"');                          // fragment kept
    expect(rawMain[0]).toContain('"href":""');                              // javascript: cleared
    // No relative URL-bearing attribute survives anywhere (the iframe's src is
    // rewritten to the viewer's snapshot route at export time).
    for (const json of rawMain) {
      expect(json).not.toMatch(/"(?:href|src|poster|srcset)":"\//);
    }

    // ── Rendered output: every main snapshot serves absolute URLs ───────────
    const rendered = renderSnapshots(snapshots);
    const mainRendered = rendered.filter(r => r.frameId === mainFrameId);
    expect(mainRendered.length).toBeGreaterThan(2);
    for (const { name, html } of mainRendered) {
      expect(html, `${name}: stylesheet href not absolute`)
        .toContain('href="http://localhost:8153/big.css"');
      expect(html, `${name}: image src not absolute`)
        .toContain('src="http://localhost:8153/small.png"');
    }

    // ── Official resource matching (the viewer's own SnapshotStorage) ───────
    const networkLines = readEntry(zipPath, 'trace.network').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const oracle = buildResourceOracle(snapshots, networkLines);
    // A late snapshot: resources loaded at page reload (monotonic time ~0) must
    // resolve from it, which is exactly what the viewer does per snapshot.
    let mainIdx = -1;
    snapshots.forEach((l, i) => { if (l.snapshot.frameId === mainFrameId) mainIdx = i; });
    expect(mainIdx).toBeGreaterThanOrEqual(0);

    const cssRes = oracle.resourceByUrl(mainIdx, 'http://localhost:8153/big.css');
    expect(cssRes).toBeTruthy();
    expect(cssRes.response.content._sha1).toBeTruthy();
    expect(oracle.resourceByUrl(mainIdx, 'http://localhost:8153/small.png')).toBeTruthy();
    expect(listEntries(zipPath)).toContain('resources/' + cssRes.response.content._sha1);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
