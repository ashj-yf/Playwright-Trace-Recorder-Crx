import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import {
  startServer, PORT, DEAD_PORT, REDIRECT_FROM, REDIRECT_TO, WS_GREETING, WS_REPLY_PREFIX
} from './support/testPage';
import { openSidePanel, stopAndDownload, readEntry } from './support/recorder';

/**
 * Network capture beyond one-row-per-URL.
 *
 * Two things the viewer renders that a naive "key the record by CDP requestId"
 * recorder cannot produce:
 *
 *  1. Redirect chains. CDP reports every hop of a redirect under the SAME
 *     `requestId`, so an upsert-by-requestId keeps only the last hop and the
 *     302 disappears from the panel. The official recorder splits the chain:
 *     the 3xx hop stays as its own entry with `response.redirectURL` pointing
 *     at the next URL.
 *  2. WebSocket frames. The panel's "Messages" tab renders `_webSocketMessages`
 *     (or a jsonl side-file) for an entry whose `_resourceType` is `websocket`.
 *     No WebSocket CDP events were handled, so the tab was permanently empty.
 *
 * The assertions below therefore check the TRACE, not the page: a page-side
 * assertion would pass even while the recorder wrote nothing.
 */
test('records redirect chains and websocket frames', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    // Both probes must run AFTER recording starts, or CDP never reports them.
    await page.evaluate(() => (window as any).__triggerRedirect());
    await page.waitForTimeout(600);

    await page.evaluate(() => (window as any).__wsOpen());
    await expect.poll(
      () => page.evaluate(() => (window as any).__wsOpenState),
      { timeout: 10_000, message: 'the probe WebSocket never opened' }
    ).toBe('open');
    await page.evaluate(() => (window as any).__wsSend('probe-outbound-1'));
    await expect.poll(
      () => page.evaluate(() => (window as any).__wsFrames || []),
      { timeout: 10_000, message: 'the echo server never replied' }
    ).toContain(WS_REPLY_PREFIX + 'probe-outbound-1');
    await page.waitForTimeout(1200);

    // A transport-level failure, so `_failureText` has something real to carry.
    await page.evaluate(() => (window as any).__triggerFailure());
    await page.waitForTimeout(1200);

    const outDir = path.join(__dirname, '..', 'test-results', 'network-capture');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const net = readEntry(zipPath, 'trace.network').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l))
      .filter(l => l.type === 'resource-snapshot')
      .map(l => l.snapshot);

    expect(net.length).toBeGreaterThan(0);

    // ── 1. Redirect chain ────────────────────────────────────────────────
    const redirectHop = net.find(n => n.request.url.includes(REDIRECT_FROM));
    const finalHop = net.find(n => n.request.url.includes(REDIRECT_TO));

    expect(
      redirectHop,
      `the ${REDIRECT_FROM} hop is missing: CDP reports every redirect under one ` +
      `requestId, so an upsert-by-requestId overwrites the 3xx with the final response`
    ).toBeTruthy();
    expect(
      redirectHop!.response.status,
      'the redirect hop must keep its own 3xx status rather than the final 200'
    ).toBe(302);
    expect(
      redirectHop!.response.redirectURL,
      'the 3xx entry must name its successor: the panel shows it as the redirect target'
    ).toContain(REDIRECT_TO);
    expect(
      finalHop,
      'the post-redirect response must be its own entry'
    ).toBeTruthy();
    expect(finalHop!.response.status).toBe(200);

    // ── 2. WebSocket frames ──────────────────────────────────────────────
    const wsEntry = net.find(n => n._resourceType === 'websocket');
    expect(
      wsEntry,
      'no entry is marked _resourceType=websocket: the panel routes such rows to ' +
      'the Messages tab and no other entry can render frames'
    ).toBeTruthy();

    const frames = wsEntry!._webSocketMessages || [];
    expect(
      frames.length,
      'the websocket entry carries no frames, so the Messages tab renders ' +
      '"No messages captured"'
    ).toBeGreaterThanOrEqual(2);

    const received = frames.filter((f: any) => f.type === 'receive');
    const sent = frames.filter((f: any) => f.type === 'send');
    expect(
      received.map((f: any) => f.data),
      'the server greeting must appear as a received frame'
    ).toContain(WS_GREETING);
    expect(
      sent.map((f: any) => f.data),
      'the page-sent frame must appear as a sent frame'
    ).toContain('probe-outbound-1');
    for (const f of frames) {
      expect(typeof f.opcode, 'a frame without an opcode cannot be labelled').toBe('number');
      expect(typeof f.time, 'a frame without a time cannot be placed on the timeline').toBe('number');
    }

    // ── 3. HAR fidelity: timings / httpVersion / server address / failure ──
    // These are the fields the official HAR exporter writes from the same CDP
    // response payload. They were previously placeholders (`timings` all -1,
    // `httpVersion` pinned to HTTP/1.1, no address), so a trace exported from
    // this recorder could not be told apart from one that observed nothing.
    const withTiming = net.filter(n => n.timings && n.timings.wait > 0);
    expect(
      withTiming.length,
      'no entry reports a real `timings.wait`: the timing block is still the ' +
      'all-placeholder {send:-1,wait:-1,receive:-1} scaffold'
    ).toBeGreaterThan(0);
    for (const n of withTiming) {
      expect(typeof n.timings.dns, 'timings.dns must be a number (-1 = absent phase)')
        .toBe('number');
      expect(n.timings.send, 'official pins timings.send to 0').toBe(0);
    }

    // A redirect hop is the case a naive implementation misses: CDP never emits
    // `responseReceived` for it, so unless the hop is finalized from
    // `redirectResponse` it keeps the placeholder protocol AND the placeholder
    // timings — a row that claims nothing was ever measured.
    expect(
      redirectHop!.timings?.wait,
      'the redirect hop reports no wait time: its response was never read from ' +
      '`redirectResponse`, so the hop keeps the placeholder timing scaffold'
    ).toBeGreaterThan(0);

    const withIp = net.filter(n => n.serverIPAddress);
    expect(
      withIp.length,
      'no entry carries `serverIPAddress`: the response\'s remote address is ' +
      'never read, so the panel has no server details to show'
    ).toBeGreaterThan(0);
    for (const n of withIp) {
      expect(
        typeof n._serverPort,
        'official always writes `_serverPort` alongside `serverIPAddress`'
      ).toBe('number');
    }

    // A same-origin response over a local server is HTTP/1.1 either way, so the
    // version must be the mapped HAR spelling rather than an empty or CDP value.
    for (const n of net) {
      expect(
        n.request.httpVersion,
        'request.httpVersion must carry the mapped protocol'
      ).toMatch(/^HTTP\/[\d.]+$|^blob$/);
    }

    const failed = net.filter(n => n.response._failureText);
    expect(
      failed.length,
      'the refused connection produced no `_failureText`: the loadingFailed ' +
      'reason is recorded but never exported, so the failure cause is invisible'
    ).toBeGreaterThan(0);
    for (const n of failed) {
      expect(typeof n.response._failureText).toBe('string');
      expect(n.response._failureText.length).toBeGreaterThan(0);
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
