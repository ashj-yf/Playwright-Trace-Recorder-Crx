import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { startServer, PORT } from './support/testPage';
import {
  openSidePanel, attachWorkerCdp, stopAndDownload, readEntry
} from './support/recorder';

/**
 * Gesture parity with the official recorder.
 *
 * Playwright records each of these as its own action, and the trace viewer has
 * a dedicated title for every one of them (`Frame.hover` -> "Hover",
 * `Frame.check` -> "Check", `Frame.selectOption` -> "Select option",
 * `Frame.setInputFiles` -> "Set input files", `Frame.tap` -> "Tap"). A recorder
 * that folds them into a generic click/change loses the action's identity: the
 * viewer renders the bare method name with no title and no selector subtitle.
 *
 * Two properties are asserted for each gesture:
 *   1. it is recorded as its OWN method (not folded into click/change), and
 *   2. the action line is shaped so the viewer can actually title it —
 *      `class: "Frame"`, no `apiName` (which the modernizer copies into
 *      `title`, overriding the metadata lookup), and the params the title
 *      template interpolates.
 *
 * The file names are asserted rather than file contents: the trace format
 * carries paths, not bytes, and the page cannot be handed files back on replay.
 */
test('records hover, selectOption, check, setInputFiles and tap as distinct actions', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    // ── hover: dwell on the target without pressing anything ──────────────
    // The dwell window is what distinguishes a hover from the pointer simply
    // travelling towards a click, so the pointer is parked and left alone.
    const hoverBox = await page.locator('#hover-target').boundingBox();
    expect(hoverBox).toBeTruthy();
    await page.mouse.move(hoverBox!.x + hoverBox!.width / 2, hoverBox!.y + hoverBox!.height / 2);
    await page.waitForTimeout(1200);

    // ── selectOption: pick a non-default option ───────────────────────────
    await page.selectOption('#sel', 'a');
    await page.waitForTimeout(1500);

    // ── check / uncheck: one of each, so both spellings are covered ───────
    await page.check('#check2');
    await page.waitForTimeout(1500);
    await page.uncheck('#check2');
    await page.waitForTimeout(1500);

    // ── setInputFiles: a real file through the real chooser path ──────────
    const uploadPath = path.join(__dirname, '..', 'test-results', 'gesture-parity', 'upload-probe.txt');
    fs.mkdirSync(path.dirname(uploadPath), { recursive: true });
    fs.writeFileSync(uploadPath, 'gesture-parity upload probe\n');
    await page.setInputFiles('#file-input', uploadPath);
    await page.waitForTimeout(1500);

    // ── tap: a real trusted touch, dispatched through CDP ─────────────────
    // The fixture's context does not enable `hasTouch`, so Playwright's own
    // `touchscreen.tap()` refuses to run. Driving `Input.dispatchTouchEvent`
    // directly produces genuine trusted touch events, which is what the
    // content script's listeners actually see.
    const tapBox = await page.locator('#btn1').boundingBox();
    expect(tapBox).toBeTruthy();
    const tapX = tapBox!.x + tapBox!.width / 2;
    const tapY = tapBox!.y + tapBox!.height / 2;
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent' as any, {
      type: 'touchStart', touchPoints: [{ x: tapX, y: tapY }]
    });
    await cdp.send('Input.dispatchTouchEvent' as any, {
      type: 'touchEnd', touchPoints: []
    });
    await page.waitForTimeout(1500);

    // A genuine mouse click, issued immediately after the tap. It must survive
    // as its own click: suppressing the tap's synthesized echo must depend on
    // the touch signal, never on "a click arrived soon after a tap".
    await page.click('#btn2');
    await page.waitForTimeout(1500);

    const outDir = path.join(__dirname, '..', 'test-results', 'gesture-parity');
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const befores = lines.filter(l => l.type === 'before');
    const methods = befores.map(b => b.method);
    console.log('action methods:', methods.join(','));

    /** The single recorded action for a selector, asserting there is exactly one. */
    const actionFor = (method: string, selector: string) => {
      const hits = befores.filter(b => b.method === method && b.params.selector === selector);
      expect(
        hits.map((h: any) => `${h.method}:${h.params.selector}`),
        `expected exactly one ${method} action for ${selector}`
      ).toHaveLength(1);
      return hits[0];
    };

    // ── Every action must be viewer-titleable ─────────────────────────────
    // `apiName` is deleted here rather than asserted absent per-gesture: the
    // v6->v8 modernizer turns it into `title`, which then wins over the
    // metadata table and renders the raw API string instead.
    for (const b of befores) {
      expect(
        b.class,
        `${b.method} carries class "${b.class}"; the viewer resolves titles from ` +
        `Frame.<method>, so anything else renders as the bare method name`
      ).toBe('Frame');
      expect(
        b.apiName,
        'apiName overrides the viewer\'s title lookup once modernized'
      ).toBeUndefined();
    }

    // ── 1. hover ──────────────────────────────────────────────────────────
    const hover = actionFor('hover', '#hover-target');
    expect(hover.class).toBe('Frame');

    // ── 2. selectOption ───────────────────────────────────────────────────
    const select = actionFor('selectOption', '#sel');
    // The viewer's "Select option" template interpolates `{options}`.
    expect(
      select.params.options,
      'the selected value must ride the action: the viewer\'s title and the ' +
      'Payload tab both read `options`'
    ).toEqual(['a']);

    // ── 3. check / uncheck ────────────────────────────────────────────────
    // Both spellings must appear, and neither may leave a click/change behind:
    // the toggle is one action, not a burst.
    expect(methods).toContain('check');
    expect(methods).toContain('uncheck');
    const toggles = befores.filter(b => b.params.selector === '#check2');
    expect(
      toggles.map((t: any) => t.method).sort(),
      'the checkbox must surface as exactly one check and one uncheck'
    ).toEqual(['check', 'uncheck']);
    expect(
      befores.some(b => b.method === 'click' && b.params.selector === '#check2'),
      'a checkbox click must not also record a plain click'
    ).toBe(false);

    // ── 4. setInputFiles ──────────────────────────────────────────────────
    const upload = actionFor('setInputFiles', '#file-input');
    expect(
      upload.params.files,
      'the chosen file name must ride the action (the trace format carries ' +
      'names, never contents)'
    ).toEqual(['upload-probe.txt']);

    // ── 5. tap ────────────────────────────────────────────────────────────
    // A real touch makes the browser synthesize a click afterwards. The tap
    // must be recorded ONCE, as `tap`: leaving the synthesized click through
    // would record the same gesture twice, once under the wrong name.
    const taps = befores.filter(b => b.method === 'tap');
    expect(
      taps.map((t: any) => t.params.selector),
      'the touch was not recorded as a tap'
    ).toContain('#btn1');
    expect(
      befores.filter(b => b.method === 'click' && b.params.selector === '#btn1'),
      'the click synthesized after a tap must be swallowed, or the same gesture ' +
      'is recorded twice'
    ).toHaveLength(0);

    // A GENUINE mouse click issued right after the tap must still be recorded.
    // Dropping the synthesized click has to key off the touch signal itself, not
    // off "a click arrived shortly after a tap" — the latter would swallow this
    // real one, which is exactly the regression this assertion guards.
    expect(
      befores.filter(b => b.method === 'click' && b.params.selector === '#btn2'),
      'a real mouse click after a tap was swallowed as if it were the tap\'s ' +
      'synthesized echo'
    ).toHaveLength(1);
  } finally {
    // `server.close()` only invokes its callback once every open connection has
    // ended, and Chromium holds keep-alive sockets to this origin until its
    // context is torn down — which happens AFTER this block. Without dropping
    // them explicitly the teardown can outlive the test's own timeout.
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
