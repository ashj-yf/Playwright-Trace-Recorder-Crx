import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Test: GitHub Navigation with Playwright Tracing (Baseline)
 * Uses Playwright's built-in tracing to capture navigation as a baseline.
 * This test does NOT use the extension - it generates a standard Playwright trace
 * that can be compared against traces recorded by the extension.
 */
test('should navigate GitHub (baseline with Playwright tracing)', async ({ page }) => {
  // Start tracing
  await page.context().tracing.start({ screenshots: true, snapshots: true });

  // Navigate to GitHub
  await page.goto('https://github.com/GeorgeSutaru/Playwright-Trace-Recorder-Crx');

  // Verify page loaded
  await expect(page.getByRole('link', { name: 'Issues' })).toBeVisible();

  // Navigate through GitHub pages
  await page.getByRole('link', { name: 'Issues' }).click();
  await expect(page).toHaveURL(/.*\/issues/);

  await page.getByRole('link', { name: 'Pull requests', exact: true }).click();
  await expect(page).toHaveURL(/.*\/pulls/);
  await page.getByRole('link', { name: 'Code', exact: true }).click();

  // Stop tracing and save the trace
  const outputPath = path.join(__dirname, '..', 'test-results', 'playwright-trace', 'trace.zip');
  
  // Ensure directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  await page.context().tracing.stop({ path: outputPath });
  console.log(`Playwright baseline trace saved to: ${outputPath}`);
});
