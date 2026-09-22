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
 * The artifact contract that makes a recorded trace REPLAYABLE in the real
 * viewer, as opposed to merely well-formed. Each assertion here corresponds to
 * a defect that produced a trace which looked fine in an older viewer and was
 * broken in the current one:
 *
 *  1. Declaration order. The modernizer derives a snapshot's `phase` from the
 *     action event that names it, so the declaring line must precede the
 *     snapshot line. Reversed, `phase` is undefined, no renderer is registered,
 *     and every action renders blank.
 *  2. No dangling references. An `afterSnapshot` naming a snapshot that was
 *     never written sends the viewer looking for something that cannot exist.
 *  3. Console channel. Only top-level `type:"console"` lines are rendered; the
 *     legacy `event`/`Page.console` shape is silently dropped.
 *  4. Network timing. `time` is a request DURATION (the viewer computes start
 *     from `_monotonicTime` and width from `time`); writing the start offset
 *     into it draws every bar to the same absolute point.
 *  5. Network fields. The panel's size column and type filter read
 *     `_transferSize`/`bodySize` and `_resourceType`.
 *  6. Target box. The element highlight comes from `box` on the input line.
 *
 * The final assertion loads the archive with Playwright's own TraceLoader so the
 * contract is checked against the viewer's code, not this test's assumptions.
 */
test('exported trace satisfies the viewer replay contract', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000);
  const server = await startServer();

  try {
    await page.goto(`http://localhost:${PORT}/index.html?probe=1&flavour=contract`);
    await expect(page.locator('#title')).toBeVisible();

    const panel = await openSidePanel(page, context, extensionId);
    await attachWorkerCdp(context, extensionId);
    await panel.getByRole('button', { name: 'Start Recording' }).click();
    await expect(panel.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 });

    // Pointer interactions (which must carry a `box`) plus one console message
    // and one uncaught page error, spaced so each action's capture round
    // completes. The error is thrown from a timer callback rather than from
    // evaluate(), so it is genuinely uncaught and surfaces as a page error
    // instead of propagating back to the test as a rejected promise.
    await page.click('#btn1');
    await page.waitForTimeout(1200);
    await page.click('#btn2');
    await page.waitForTimeout(1200);
    await page.locator('#field').fill('contract-check');
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      setTimeout(() => { throw new Error('artifact-contract uncaught probe'); }, 0);
    });
    await page.waitForTimeout(800);
    await page.click('#btn3');
    await page.waitForTimeout(1500);

    const outDir = path.join(__dirname, '..', 'test-results', 'artifact-contract');
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, 'trace.zip');
    await stopAndDownload(panel, zipPath);

    const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
    const lines = readEntry(zipPath, 'trace.trace').toString()
      .split('\n').filter(Boolean).map(l => JSON.parse(l));

    // ── 1. Declaration order and 2. dangling references ────────────────────
    const snapshotIndex = new Map<string, number>();
    lines.forEach((l, i) => {
      if (l.type === 'frame-snapshot' && l.snapshot?.snapshotName && !snapshotIndex.has(l.snapshot.snapshotName))
        snapshotIndex.set(l.snapshot.snapshotName, i);
    });

    const REF_FIELDS = ['beforeSnapshot', 'inputSnapshot', 'afterSnapshot'] as const;
    const dangling: string[] = [];
    const outOfOrder: string[] = [];
    let declarations = 0;

    lines.forEach((l, i) => {
      for (const field of REF_FIELDS) {
        const name = l[field];
        if (!name) continue;
        declarations++;
        if (!snapshotIndex.has(name)) dangling.push(name);
        else if (snapshotIndex.get(name)! < i) outOfOrder.push(name);
      }
    });

    expect(declarations).toBeGreaterThan(0);
    expect(
      outOfOrder,
      'a frame-snapshot is emitted before the event that names it: the modernizer ' +
      'assigns phase=undefined and the viewer registers no renderer for it'
    ).toEqual([]);
    expect(
      dangling,
      'a snapshot is declared that was never emitted: the viewer falls back to a blank frame'
    ).toEqual([]);

    // ── 3. Console channel ─────────────────────────────────────────────────
    const legacyConsole = lines.filter(
      l => l.type === 'event' && l.class === 'Page' && l.method === 'console');
    expect(
      legacyConsole,
      'the legacy Page.console event shape is not rendered by the current viewer'
    ).toEqual([]);

    // Page errors travel as their own event, not as console text: the viewer
    // counts them toward the action's error stats and renders them with an
    // error level. The nested shape mirrors official `serializeError`.
    const pageErrors = lines.filter(
      l => l.type === 'event' && l.method === 'pageError');
    expect(
      pageErrors.length,
      'the uncaught page error was not recorded as a pageError event'
    ).toBeGreaterThan(0);
    for (const pe of pageErrors) {
      expect(pe.class, 'pageError carries the official BrowserContext class').toBe('BrowserContext');
      expect(
        pe.params?.error?.error?.message,
        'pageError must nest the serialized error one level deep, as official does'
      ).toBeTruthy();
    }

    // ── 4./5. Network timing and fields ────────────────────────────────────
    if (entries.includes('trace.network')) {
      const net = readEntry(zipPath, 'trace.network').toString()
        .split('\n').filter(Boolean).map(l => JSON.parse(l))
        .filter(l => l.type === 'resource-snapshot');

      expect(net.length).toBeGreaterThan(0);

      for (const n of net) {
        expect(typeof n.snapshot.time, 'network time must be numeric').toBe('number');
        expect(n.snapshot.time, 'network time is a duration and cannot be negative')
          .toBeGreaterThanOrEqual(0);
        expect(typeof n.snapshot._monotonicTime, 'network start offset must be numeric')
          .toBe('number');
        expect(n.snapshot._resourceType, 'network entry must carry a resource type')
          .toBeTruthy();
        const size = n.snapshot.response?._transferSize > 0
          ? n.snapshot.response._transferSize
          : n.snapshot.response?.bodySize;
        expect(typeof size, 'network entry must expose a displayable size').toBe('number');
      }

      // The viewer reads these WITHOUT a guard: the Payload tab dereferences
      // `request.queryString.length` and "Copy as Fetch"/cURL dereferences
      // `request.cookies.length`. They must be present even when empty —
      // absent, the panel throws a TypeError and React unmounts the whole
      // viewer, leaving a blank page.
      for (const n of net) {
        expect(
          Array.isArray(n.snapshot.request?.queryString),
          'request.queryString is dereferenced as `.length` by the Payload tab; ' +
          'when absent the whole viewer crashes to a blank page'
        ).toBe(true);
        expect(
          Array.isArray(n.snapshot.request?.cookies),
          'request.cookies is dereferenced as `.length` by Copy as Fetch/cURL'
        ).toBe(true);
        expect(
          Array.isArray(n.snapshot.response?.cookies),
          'response.cookies must be an array for the same reason'
        ).toBe(true);
      }

      // The query string must reflect the URL, not be a stub. The document
      // request above carries `?probe=1&flavour=contract`, so at least one
      // entry must report non-empty params — otherwise this loop would pass
      // vacuously on an all-empty field.
      const withQuery = net.filter(
        n => n.snapshot.request.queryString.length > 0);
      expect(
        withQuery.length,
        'no entry reported any query parameter even though the recorded URL ' +
        'carries ?probe=1&flavour=contract: queryString is a stub'
      ).toBeGreaterThan(0);
      for (const n of withQuery) {
        const url = new URL(n.snapshot.request.url);
        const expected = [...url.searchParams].length;
        expect(
          n.snapshot.request.queryString.length,
          `queryString does not match the URL's search params for ${n.snapshot.request.url}`
        ).toBe(expected);
      }

      const documentEntry = net.find(
        n => n.snapshot.request.url.includes('flavour=contract'));
      expect(
        documentEntry,
        'the document request with query parameters was not recorded'
      ).toBeTruthy();
      expect(
        documentEntry!.snapshot.request.queryString,
        'queryString must carry the URL\'s name/value pairs'
      ).toEqual([{ name: 'probe', value: '1' }, { name: 'flavour', value: 'contract' }]);

      // The recorder must not write the start offset where the duration belongs.
      //
      // The defect makes `time` and `_monotonicTime` equal on EVERY row, so that
      // is what is asserted — rather than "no row has them equal", which has a
      // false positive: a request that begins at the trace's own base time has
      // `_monotonicTime === 0`, and a legitimately zero duration is also 0, so
      // an innocent row can read 0 === 0. Comparing across rows states the same
      // rule without depending on that coincidence.
      const allIdentical = net.length > 1 && net.every(
        n => n.snapshot.time === n.snapshot._monotonicTime);
      expect(
        allIdentical,
        'network `time` duplicates `_monotonicTime` on every request: the viewer ' +
        'treats `time` as a duration, so every request bar is drawn to the same ' +
        'absolute point'
      ).toBe(false);

      // ...and no request may pair a NON-zero start with an equal duration, which
      // can only happen if the start offset leaked into `time`.
      const nonZeroCollisions = net.filter(n => n.snapshot._monotonicTime !== 0
        && n.snapshot.time === n.snapshot._monotonicTime);
      expect(
        nonZeroCollisions.map(n => n.snapshot.request.url),
        'these requests report a non-zero `time` equal to their `_monotonicTime`: ' +
        'the start offset is being written where the viewer expects a duration'
      ).toEqual([]);

      // A request that finished must report a real duration. Start and finish
      // are sampled on different clock reads, so a start sampled late (inside
      // the queued task, after awaits) can land AFTER the finish and clamp the
      // duration to zero — collapsing the waterfall bar.
      const finished = net.filter(n => n.snapshot.response?.status > 0
        && n.snapshot.response?.bodySize > 0);
      const collapsed = finished.filter(n => n.snapshot.time === 0);
      expect(
        collapsed.map(n => n.snapshot.request.url),
        'a completed response reports a zero duration: the start time was ' +
        'sampled after the finish event, so the waterfall bar collapses'
      ).toEqual([]);

      // ── HAR fidelity: the fields official exports from the same CDP payload.
      // These were placeholders before: `timings` was the all -1 scaffold,
      // `httpVersion` was pinned to HTTP/1.1, and no server address or TLS
      // detail was written at all. A trace full of placeholders is
      // indistinguishable from one that observed nothing.
      for (const n of net) {
        const t = n.snapshot.timings;
        expect(t, 'every resource-snapshot must carry a timings block').toBeTruthy();
        for (const phase of ['dns', 'connect', 'ssl', 'send', 'wait', 'receive']) {
          expect(typeof t[phase], `timings.${phase} must be a number (-1 = absent phase)`)
            .toBe('number');
        }
        expect(t.send, 'official pins timings.send to 0, not -1').toBe(0);
        expect(
          n.snapshot.request.httpVersion,
          'request.httpVersion must be the mapped protocol (HTTP/1.1, HTTP/2.0, blob)'
        ).toMatch(/^HTTP\/[\d.]+$|^blob$/);
        expect(
          n.snapshot.response.httpVersion,
          'response.httpVersion must be the mapped protocol'
        ).toMatch(/^HTTP\/[\d.]+$|^blob$/);
      }

      // The placeholder triple was the signature of the unfixed generator. It is
      // only illegitimate for a request that actually RECEIVED a response: a
      // request that failed before any timing existed legitimately has no
      // timings at all (official traces keep the same scaffold for those), so
      // the check is scoped to answered requests rather than to every entry.
      const answered = net.filter(n => n.snapshot.response?.status > 0);
      expect(answered.length, 'expected at least one answered request').toBeGreaterThan(0);
      const placeholder = answered.filter(n =>
        n.snapshot.timings.send === -1 && n.snapshot.timings.wait === -1
        && n.snapshot.timings.receive === -1);
      expect(
        placeholder.map(n => n.snapshot.request.url),
        'these answered requests still carry the all-placeholder timings triple'
      ).toEqual([]);
    }

    // ── 6. Target box on pointer actions ───────────────────────────────────
    const POINTER = new Set(['click', 'dblclick', 'contextmenu', 'dragTo']);
    const pointerIds = new Set(
      lines.filter(l => l.type === 'before' && POINTER.has(l.method)).map(l => l.callId));
    const inputs = lines.filter(l => l.type === 'input');

    expect(pointerIds.size, 'expected at least one pointer action').toBeGreaterThan(0);
    const pointerInputs = inputs.filter(l => pointerIds.has(l.callId));
    expect(
      pointerInputs.length,
      'every pointer action that reached the action stage should emit an input line'
    ).toBeGreaterThan(0);
    for (const input of pointerInputs) {
      expect(
        input.box,
        'a pointer action without `box` renders no element highlight in the viewer'
      ).toBeTruthy();
      expect(typeof input.box.width).toBe('number');
    }

    // ── 7. Action lines the viewer can actually title ──────────────────────
    // The viewer resolves a title as `title ?? metadata[class + "." + method]
    // ?? method`, and its metadata table keys element actions as `Frame.*`.
    // Two ways to lose a title, both checked here:
    //   - a non-Frame class (e.g. "Page") has no metadata entry, and
    //   - `apiName` is copied verbatim into `title` by the v6->v8 modernizer,
    //     which then SHORT-CIRCUITS the metadata lookup entirely.
    const actions = lines.filter(l => l.type === 'before');
    expect(actions.length, 'expected at least one action').toBeGreaterThan(0);
    for (const a of actions) {
      expect(
        a.class,
        `${a.method} carries class "${a.class}": the viewer only titles Frame.* actions, ` +
        `so this renders as the bare method name with no selector subtitle`
      ).toBe('Frame');
      expect(
        a.apiName,
        'apiName becomes `title` once modernized and overrides the viewer\'s metadata lookup'
      ).toBeUndefined();
    }

    // ── Loaded by Playwright's own loader ──────────────────────────────────
    // This is the assertion that would have caught the phase regression: the
    // static order check above states the rule, this proves the real loader
    // derives a phase for every action.
    const extractDir = path.join(outDir, 'extracted');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', extractDir]);

    const report = await inspectPhases(extractDir);
    if (!report.available) {
      test.info().annotations.push({
        type: 'warning',
        description: `phase oracle unavailable (${report.reason}); static order check stands alone`,
      });
      return;
    }

    expect(report.totalActions).toBeGreaterThan(0);
    expect(
      report.renderableActions,
      `no action resolved a DOM snapshot phase through Playwright's TraceLoader ` +
      `(${report.renderableActions}/${report.totalActions}); the viewer would render blank frames. ` +
      `Phases found: ${report.phases.join(', ') || '(none)'}`
    ).toBe(report.totalActions);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
