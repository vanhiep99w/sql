import { test, expect } from '@playwright/test';
import { readdir } from 'node:fs/promises';

const concurrency = '/fundamentals/application-concurrency-locking/';
const patterns = '/optimization/query-optimization-patterns/';
const cold = '/interview/first-query-slow-cold-cache/';
const monitoring = '/optimization/monitoring-slow-query-deep-dive/';
const comparison = '/comparison/mysql-vs-postgresql/';

async function routes(dir = 'content/docs'): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await routes(path));
    else if (/\.mdx?$/.test(path)) result.push(`/${path.replace('content/docs/', '').replace(/\.mdx?$/, '')}/`);
  }
  return result.sort();
}

test('all 45 exported articles load without JS errors or raw descriptor fences', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const paths = await routes();
  expect(paths).toHaveLength(45);
  for (const path of paths) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator('#nd-page')).toBeVisible();
    await expect(page.locator('pre code.language-mermaid')).toHaveCount(0);
    await expect(page.locator('pre code:is(.language-code-walkthrough, .language-code-diff, .language-terminal-session, .language-protocol-exchange, .language-span-waterfall)')).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  test(`${theme}: diagrams, five components and narrow-screen containment`, async ({ page, context }) => {
    await context.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
    for (const path of [concurrency, patterns, cold, monitoring, comparison]) {
      await page.goto(path);
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /light/);
      const diagram = page.locator('.d2-diagram').first();
      await expect(diagram).toBeVisible();
      expect(await diagram.locator('svg').count()).toBeGreaterThan(0);
      if (path === concurrency) {
        const walkthrough = page.locator('.code-walkthrough');
        await walkthrough.getByRole('button', { name: 'Bước sau' }).click();
        await expect(walkthrough.locator('select')).toHaveValue('1');
        await expect(walkthrough.locator('[data-line="3"]')).toHaveAttribute('data-highlighted', 'true');
        const variant = page.locator('.protocol-exchange details[data-variant="version"]');
        await variant.locator('summary').click();
        await expect(variant.getByText('409', { exact: true })).toBeVisible();
      }
      if (path === patterns) {
        const diff = page.locator('.code-diff');
        await diff.getByRole('button', { name: 'Inline', exact: true }).click();
        await expect(diff).toHaveAttribute('data-view', 'inline');
      }
      if (path === cold) await expect(page.locator('.span-waterfall')).toBeVisible();
      if (path === monitoring) await expect(page.locator('.terminal-session')).toContainText('pt-query-digest');
      if (path === comparison) {
        const images = page.locator('.d2-diagram svg image');
        expect(await images.count()).toBeGreaterThan(0);
        const hrefs = await images.evaluateAll((images) => images.map((i) => i.getAttribute('href') ?? i.getAttribute('xlink:href')));
        expect(hrefs.every((href) => href?.startsWith('data:image/'))).toBe(true);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), { message: path }).toBe(true);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  });
}

test('copy, keyboard walkthrough and Source Explorer deep links still work', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(concurrency);
  const walkthrough = page.locator('.code-walkthrough');
  await walkthrough.getByRole('button', { name: 'Bước sau' }).focus();
  await page.keyboard.press('Enter');
  await expect(walkthrough.locator('select')).toHaveValue('1');
  await walkthrough.getByRole('button', { name: 'Sao chép code', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('AND version = :expected_version;');
  // Exercise the host's actual URL contract through the generated SourceRef.
  await page.goto('/fundamentals/view-vs-materialized-view/');
  await page.getByRole('link', { name: 'Đối chiếu snippet trong Source Explorer' }).first().click();
  await expect(page.locator('body')).toHaveAttribute('data-source-drawer-open');
  await expect(page.locator('[data-source-drawer-open]')).toBeVisible();
  const sourceURL = page.url();
  expect(sourceURL).toContain('source=');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-source-drawer-open');
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveAttribute('data-source-drawer-open');
  await page.goto(concurrency);
  await expect(page.locator('.code-walkthrough')).toBeVisible();
});

test('without JavaScript: diagrams and all learning content remain readable', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  for (const [path, selector, expected] of [
    [concurrency, '.code-walkthrough', 'UPDATE products'],
    [concurrency, '.protocol-exchange', 'Version cũ'],
    [patterns, '.code-diff', 'EXTRACT'],
    [cold, '.span-waterfall', 'Query cold'],
    [monitoring, '.terminal-session', 'pt-query-digest'],
  ]) {
    await page.goto(`http://127.0.0.1:4187${path}`);
    await expect(page.locator(selector)).toContainText(expected);
    await expect(page.locator('.d2-diagram').first()).toBeVisible();
  }
  const variants = page.locator('.protocol-exchange details');
  await page.goto(`http://127.0.0.1:4187${concurrency}`);
  await variants.last().locator('summary').click();
  await expect(variants.last()).toHaveAttribute('open');
  await context.close();
});
