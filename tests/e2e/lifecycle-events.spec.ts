import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { startServer, PORT } from './support/testPage';
import {
  openSidePanel, attachWorkerCdp, stopAndDownload, readEntry
} from './support/recorder';
import { inspectPhases } from './support/viewerOracle';

/**
 * Page lifecycle markers, folded to ONE point per navigation.
 *
 * "页面加载完成 / 所有请求完成"在 Playwright 语义里对应 lifecycle 状态
 * DOMContentLoaded、load、networkIdle（0 连接持续 500ms，与
 * waitUntil:'networkidle' 同口径）。但 Chromium 会为每个 loader 重放
 * lifecycle —— 开启时补发旧 loader、重定向链每个中间 loader 都发 ——
 * 一次录制开头就能冒出十几个 waitForLoadState。
 *
 * 归并规则：以主 frame 每次导航（frameNavigated/SPA 路由）为一轮，只收
 * loaderId 与该文档一致的 lifecycle，每轮输出一个 Frame.waitForLoadState
 * 点事件（零时长、无快照），state 取该文档实际到达的最深状态，时间取
 * 该状态最后一次达成时刻。本例中两次导航都到达 networkidle。
 */
test('folds lifecycle events into one waitForLoadState per navigation', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await expect(page.locator('#title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    // Recording start issues a Page.reload and waits a fixed 2s; the heavy
    // page (6MB media fetch, big image, big CSS/JS) needs a little longer to
    // drain to networkIdle on localhost. This is the first marker round.
    await page.waitForTimeout(5_000);

    // A second, light full-page navigation: another complete marker round.
    await page.goto(`http://localhost:${PORT}/frame.html`);
    await expect(page.locator('#frame-title')).toBeVisible();
    await page.waitForTimeout(3_000);

    const outDir = path.join(__dirname, '..', 'test-results', 'lifecycle-events');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const befores = lines.filter(l => l.type === 'before');
    const afters = lines.filter(l => l.type === 'after');
    const logs = lines.filter(l => l.type === 'log');

    const markerBefores = befores
      .filter(b => b.method === 'waitForLoadState')
      .sort((a, b) => a.startTime - b.startTime);
    const states = markerBefores.map(b => b.params.state);
    const navs = lines.filter(l => l.type === 'event' && l.class === 'Frame' && l.method === 'navigated');
    console.log('load-state markers:', states.join(','));

    // ── Exactly one marker per navigation ────────────────────────────────
    // Two navigations (the start reload + frame.html); the enable-time
    // replay and any other loader noise must not add markers.
    expect(
      markerBefores.length,
      `expected 2 folded markers, got states: ${states.join(',')}`
    ).toBe(2);
    // Both documents drain to networkIdle within the waits above.
    expect(states).toEqual(['networkidle', 'networkidle']);

    // The second marker must not precede the navigation it completes.
    const frameNav = navs.find(n => n.params.url.endsWith('/frame.html'));
    expect(frameNav).toBeTruthy();
    expect(markerBefores[1].startTime).toBeGreaterThanOrEqual(frameNav!.time);

    // ── Point events: zero duration, before/after paired ─────────────────
    for (const before of markerBefores) {
      const pair = afters.filter(a => a.callId === before.callId);
      expect(pair.map(a => a.callId), `before ${before.callId} has one matching after`).toHaveLength(1);
      expect(pair[0].endTime).toBe(before.startTime);
      expect(
        before.params,
        'state is the only param: keeps Payload tab truthful'
      ).toEqual({ state: before.params.state });
      expect(before.class).toBe('Frame');
      expect(before.apiName).toBeUndefined();
    }

    // ── No dangling snapshot references ──────────────────────────────────
    // A snapshot name declared but never written makes the viewer ask for a
    // snapshot it cannot find. Markers are snapshot-less BY DESIGN.
    const markerCallIds = new Set(markerBefores.map(b => b.callId));
    expect(
      markerBefores.some(b => b.beforeSnapshot != null),
      'markers declare no before snapshot'
    ).toBe(false);
    expect(
      afters.filter(a => markerCallIds.has(a.callId)).some(a => a.afterSnapshot != null),
      'markers declare no after snapshot'
    ).toBe(false);
    expect(
      lines.filter(l => l.type === 'frame-snapshot' && markerCallIds.has(l.snapshot.callId)),
      'no frame snapshot is written for a marker callId'
    ).toHaveLength(0);
    expect(
      lines.filter(l => l.type === 'input' && markerCallIds.has(l.callId)),
      'no input line is written for a marker callId'
    ).toHaveLength(0);

    // ── Each marker carries an explanatory log line ──────────────────────
    for (const before of markerBefores) {
      const markerLogs = logs.filter(l => l.callId === before.callId);
      expect(markerLogs).toHaveLength(1);
      expect(markerLogs[0].message).toContain(before.params.state);
    }

    // ── Navigations still recorded, metadata owns the final url ──────────
    expect(navs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(readEntry(zipPath, 'metadata.json').toString()).pages[0].url)
      .toContain('/frame.html');

    // ── Playwright's own TraceLoader must accept the trace ───────────────
    // Snapshot-less actions must not break loading or steal phases from
    // other actions. This recording has no interaction actions, so every
    // action the loader sees is a marker and none resolves a DOM snapshot.
    const extractDir = path.join(outDir, 'extracted');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', extractDir]);

    const report = await inspectPhases(extractDir);
    if (!report.available) {
      test.info().annotations.push({
        type: 'warning',
        description: `phase oracle unavailable (${report.reason}); static assertions stand alone`,
      });
    } else {
      expect(report.totalActions).toBe(markerBefores.length);
      expect(report.renderableActions).toBe(0);
      for (const callId of markerCallIds) expect(report.perAction[callId]).toEqual([]);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
