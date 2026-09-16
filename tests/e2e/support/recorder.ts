import { expect, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';

/** Open the extension side panel the same way the toolbar action does. */
export async function openSidePanel(page: Page, context: BrowserContext, extensionId: string): Promise<Page> {
  await page.evaluate(() => {
    window.postMessage({ type: 'playwrightTraceViewer:openSidePanel' }, '*');
  });
  await expect.poll(
    () => context.pages().some(p => p.url().includes(extensionId)),
    { timeout: 10_000, message: 'Expected the side panel to open' }
  ).toBe(true);

  const panel = context.pages().find(p => p.url().includes(extensionId))!;
  await panel.waitForLoadState('domcontentloaded');
  return panel;
}

/**
 * performance.memory does not exist in a worker scope, so read the service
 * worker's V8 heap through browser-level CDP instead.
 */
export async function attachWorkerCdp(context: BrowserContext, extensionId: string) {
  const session = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await session.send('Target.getTargets');
  const target = (targetInfos as any[]).find(
    t => t.type === 'service_worker' && t.url.includes(extensionId)
  );
  if (!target) throw new Error('Service worker target not found');
  const { sessionId } = await session.send('Target.attachToTarget' as any, {
    targetId: target.targetId,
    flatten: false
  } as any) as any;

  let nextId = 1;
  const pending = new Map<number, (result: any) => void>();
  session.on('Target.receivedMessageFromTarget' as any, (event: any) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);

    // Tee the service worker's own console/exceptions into the test output so a
    // hang or a rejected promise leaves a trace in the worker's last log line.
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args || [])
        .map((a: any) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' ');
      process.stdout.write(`[SW console.${message.params.type}] ${text}\n`);
    } else if (message.method === 'Runtime.exceptionThrown') {
      const d = message.params.exceptionDetails;
      process.stdout.write(`[SW exception] ${d && (d.exception?.description || d.text)}\n`);
    }

    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(message.result);
  });

  const send = (method: string, params?: any) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out`));
    }, 30_000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    session.send('Target.sendMessageToTarget' as any, {
      sessionId,
      message: JSON.stringify({ id, method, params: params || {} })
    } as any).catch(reject);
  });

  await send('HeapProfiler.enable');
  await send('Runtime.enable');

  return {
    /** Retained heap in MB, after a forced collection. */
    async heapMb(): Promise<number> {
      await send('HeapProfiler.collectGarbage');
      const usage = await send('Runtime.getHeapUsage');
      return usage.usedSize / (1024 * 1024);
    }
  };
}

/** Click through the test page enough times to expose per-action retention. */
export async function driveInteractions(page: Page, rounds: number) {
  await page.bringToFront();
  for (let round = 0; round < rounds; round++) {
    await page.locator('#btn1').click();
    await page.locator('#btn2').click();
    await page.locator('#field').fill(`round ${round}`);
    await page.locator('#btn3').click();
  }
}

export async function stopAndDownload(panel: Page, zipPath: string) {
  await panel.getByRole('button', { name: 'Stop Recording' }).click();
  try {
    await expect(panel.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 90_000 });
  } catch (err) {
    // Surface the panel log + recording status so a hung worker is diagnosable.
    const log = await panel.locator('#output').innerText().catch(() => '(no log)');
    const status = await panel.locator('#statusBadge').innerText().catch(() => '(no status)');
    const traces = await panel.locator('#traces-list').innerText().catch(() => '(no traces)');
    throw new Error(
      `Trace did not become downloadable (status: ${status}).\n--- panel log ---\n${log}\n--- traces ---\n${traces}\n${err.stack || err}`
    );
  }
  const downloadPromise = panel.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  await download.saveAs(zipPath);
}

/** Read a zip entry via the system unzip, which also validates the archive. */
export function readEntry(zipPath: string, entry: string): Buffer {
  return execFileSync('unzip', ['-p', zipPath, entry], { maxBuffer: 512 * 1024 * 1024 });
}

export function listEntries(zipPath: string): string[] {
  const out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}
