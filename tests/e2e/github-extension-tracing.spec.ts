import { test, expect } from './fixtures';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Test: GitHub Navigation with Extension Tracing
 * Starts recording directly from the extension UI without Playwright tracing
 */
test('should navigate GitHub and record with extension tracing', async ({ page, context, extensionId }) => {
  // Disable Playwright tracing for this test
  await context.tracing.stop();
  
  // Navigate to GitHub first
  await page.goto('https://github.com/GeorgeSutaru/Playwright-Trace-Recorder-Crx');
  
  // Verify page loaded
  await expect(page.getByRole('link', { name: 'Issues' })).toBeVisible();
  
  // Open side panel using postMessage (same as Ventriloquist)
  await page.evaluate(() => {
    window.postMessage({ type: 'playwrightTraceViewer:openSidePanel' }, '*');
  });
  
  // Wait for side panel to open
  await expect.poll(() => {
    return context.pages().some(browserPage => browserPage.url().includes(extensionId));
  }, {
    timeout: 5000,
    message: 'Expected side panel to open',
  }).toBe(true);
  
  const sidePanelPage = context.pages().find(browserPage => browserPage.url().includes(extensionId));
  if (!sidePanelPage) {
    throw new Error('Expected side panel page to be open');
  }
  
  // Start recording from extension
  await sidePanelPage.waitForLoadState('domcontentloaded');
  await sidePanelPage.getByRole('button', { name: 'Start Recording' }).click();
  
  // Verify recording started
  await expect(sidePanelPage.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 5000 });
  
  // Navigate through GitHub pages during recording
  await page.getByRole('link', { name: 'Issues' }).click();
  await expect(page).toHaveURL(/.*\/issues/);
  
  await page.getByRole('link', { name: 'Pull requests', exact: true }).click();
  await expect(page).toHaveURL(/.*\/pulls/);

  await page.getByRole('link', { name: 'Code', exact: true }).click();
  // Stop recording
  await sidePanelPage.getByRole('button', { name: 'Stop Recording' }).click();
  
  // Wait for trace to be saved
  await expect(sidePanelPage.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 10000 });
  
  // Download the trace file
  const downloadPromise = sidePanelPage.waitForEvent('download');
  await sidePanelPage.getByRole('button', { name: 'Download' }).click();
  
  const download = await downloadPromise;
  const path = require('path');
  const fs = require('fs');
  
  // Save to test output directory
  const outputPath = path.join(__dirname, '..', 'test-results', 'extension-trace', 'trace.zip');
  
  // Ensure directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  await download.saveAs(outputPath);
  console.log(`Extension trace saved to: ${outputPath}`);
});
