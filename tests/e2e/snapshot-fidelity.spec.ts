import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import {
  startServer, PORT,
  INLINE_CSS_SENTINEL, CSSOM_SENTINEL,
  IFRAME_SENTINEL, SHADOW_SENTINEL, INLINE_SCRIPT_SENTINEL
} from './support/testPage';
import { openSidePanel, attachWorkerCdp, driveInteractions, stopAndDownload, readEntry } from './support/recorder';
import { renderSnapshots } from './support/snapshotOracle';

/** Collects the text of every materialized <style> element in a snapshot tree. */
function styleTexts(node: any, out: string[] = []): string[] {
  if (typeof node === 'string' || !Array.isArray(node)) return out;
  // An array whose head is an array is a back-reference, not an element.
  if (typeof node[0] !== 'string') return out;
  if (node[0] === 'STYLE')
    out.push(node.slice(2).filter((c: any) => typeof c === 'string').join(''));
  for (let i = 2; i < node.length; i++) styleTexts(node[i], out);
  return out;
}

function containsBackReference(node: any): boolean {
  if (!Array.isArray(node)) return false;
  if (Array.isArray(node[0])) return true;
  return node.slice(2).some((child: any) => containsBackReference(child));
}

/**
 * Asserts the four fidelity branches together, because they interact:
 *  - stylesheets are captured whole (never text-truncated),
 *  - repeated DOM collapses to back-references (keeps whole CSS affordable),
 *  - iframe documents, shadow roots, adopted stylesheets, live form values and
 *    inline script sources all survive the serializer/renderer round trip.
 */
test('captures whole stylesheets, frames, shadow DOM, forms and references', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();
    // The child frame document must have loaded (and therefore be attached as a
    // flattened CDP target) before recording starts.
    await expect(page.frameLocator('#childFrame').locator('#frame-title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    // Tee worker console/exceptions into the test output for flake diagnosis.
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    await driveInteractions(page, 6);
    // Let the capture queue drain so the last actions carry snapshots.
    await page.waitForTimeout(4000);

    const outDir = path.join(__dirname, '..', 'test-results', 'snapshot-fidelity');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const snapshots = lines.filter(l => l.type === 'frame-snapshot');
    expect(snapshots.length).toBeGreaterThan(10);

    // All three action stages must carry snapshots — a regression that stores
    // snapshot objects instead of ids silently drops action/after while leaving
    // before snapshots (and most of these assertions) intact.
    const namePrefixes = new Set(snapshots.map(s =>
      String(s.snapshot.snapshotName).split('@')[0]));
    expect(namePrefixes.has('before')).toBe(true);
    expect(namePrefixes.has('action')).toBe(true);
    expect(namePrefixes.has('after')).toBe(true);

    // ── Stylesheets survive intact ───────────────────────────────────────────
    const styles = styleTexts(snapshots[0].snapshot.html);
    expect(styles.length).toBeGreaterThan(1);
    expect(styles.some(t => t.includes(INLINE_CSS_SENTINEL))).toBe(true);
    expect(styles.some(t => t.includes(CSSOM_SENTINEL))).toBe(true);
    for (const text of styles) expect(text).not.toContain('…');

    // ── Repeated DOM is stored by reference ─────────────────────────────────
    const sizes = snapshots.map(s => JSON.stringify(s).length);
    const [firstSize, ...laterSizes] = sizes;
    const median = [...laterSizes].sort((a, b) => a - b)[Math.floor(laterSizes.length / 2)];

    console.log(`snapshots: ${snapshots.length}, first ${(firstSize / 1024).toFixed(0)} KB, ` +
      `median of the rest ${(median / 1024).toFixed(1)} KB, ` +
      `total ${(sizes.reduce((a, b) => a + b, 0) / 1024).toFixed(0)} KB`);

    expect(snapshots[0].snapshot.html[0]).toBe('HTML');
    expect(median).toBeLessThan(firstSize / 10);
    expect(snapshots.filter(s => containsBackReference(s.snapshot.html)).length)
      .toBeGreaterThan(laterSizes.length / 2);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(firstSize * 5);

    // ── References resolve to the complete document (Playwright's renderer) ──
    const rendered = renderSnapshots(snapshots);
    expect(rendered.length).toBe(snapshots.length);

    const mainFrameId = snapshots[0].snapshot.frameId;
    const mainRendered = rendered.filter(r => r.frameId === mainFrameId);
    expect(mainRendered.length).toBeGreaterThan(5);

    for (const { name, html } of mainRendered) {
      expect(html, `${name}: lost the tail of the inline stylesheet`).toContain(INLINE_CSS_SENTINEL);
      expect(html, `${name}: lost the CSSOM-only rules`).toContain(CSSOM_SENTINEL);
      expect(html, `${name}: lost the page heading`).toContain('Memory Test Page');
      expect(html, `${name}: lost the end of the 1200-row table`).toContain('row 1199');
    }

    // Rendered size spread is checked per frame: child frames have a different
    // baseline and must not be mixed into the main-frame ratio.
    const renderedSizes = mainRendered.map(r => r.html.length);
    const spread = Math.max(...renderedSizes) / Math.min(...renderedSizes);
    console.log(`main frame rendered ${Math.min(...renderedSizes)}..${Math.max(...renderedSizes)} ` +
      `chars (spread ${spread.toFixed(3)}x)`);
    expect(spread).toBeLessThan(1.5);

    // ── iframe document captured as its own frame ────────────────────────────
    const frameIds = new Set(snapshots.map(s => s.snapshot.frameId));
    expect(frameIds.size, 'expected main + at least one iframe frame').toBeGreaterThanOrEqual(2);
    const childRendered = rendered.filter(r => r.frameId !== mainFrameId);
    expect(childRendered.some(r => r.html.includes(IFRAME_SENTINEL))).toBe(true);
    // The iframe element routes to the viewer's per-frame snapshot URL.
    expect(mainRendered.some(r => r.html.includes('__playwright_src__'))).toBe(true);
    const routedIframe = snapshots.find(s =>
      s.snapshot.frameId === mainFrameId &&
      JSON.stringify(s.snapshot.html).includes('#frame'));
    expect(routedIframe, 'iframe src was not rewritten to a snapshot route').toBeTruthy();

    // ── Shadow DOM, adopted sheet, live form state, inline script ────────────
    const rawMain = snapshots
      .filter(s => s.snapshot.frameId === mainFrameId)
      .map(s => JSON.stringify(s.snapshot.html));

    // Open shadow root encoded as TEMPLATE[__playwright_shadow_root_].
    expect(rawMain.some(json => json.includes('__playwright_shadow_root_'))).toBe(true);
    expect(mainRendered.some(r => r.html.includes(SHADOW_SENTINEL))).toBe(true);

    // Document-level constructable stylesheet encoded for replaceSync.
    expect(rawMain.some(json => json.includes('__playwright_style_sheet_'))).toBe(true);

    // Live form state rides the __playwright_* marker attributes.
    expect(rawMain.some(json => json.includes('"__playwright_checked_":"true"'))).toBe(true);
    expect(rawMain.some(json => json.includes('"__playwright_selected_":"true"'))).toBe(true);
    expect(rawMain.some(json => /"__playwright_value_":"round/.test(json))).toBe(true);

    // Inline script source is retained as a non-executable X-SCRIPT element.
    expect(rawMain.some(json => json.includes('"X-SCRIPT"'))).toBe(true);
    expect(mainRendered.some(r => r.html.includes(INLINE_SCRIPT_SENTINEL))).toBe(true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
