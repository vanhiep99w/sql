import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const lab = '/labs/join-algorithms-v2.html';

test('the lesson links both versions; all three V2 modes return the same pairs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/fundamentals/join-deep-dive/');
  await expect(page.getByRole('link', { name: 'Mở phòng lab mô phỏng ba thuật toán JOIN' })).toHaveAttribute('href', '/labs/join-algorithms.html');
  await page.getByRole('link', { name: 'Theo dõi đường đi của một dòng' }).click();
  await expect(page).toHaveURL(new RegExp(lab.replace('.', '\\.') + '$'));
  const slider = page.getByRole('slider');
  for (const name of ['Nested Loop', 'Hash Join', 'Merge Join']) {
    await page.getByRole('button', { name }).click();
    await expect(slider).toHaveValue('0');
    await slider.press('End');
    const rows = page.locator('#pairs [data-row]');
    await expect(rows).toHaveCount(3);
    expect((await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-row')))).sort()).toEqual(['c1-o10', 'c1-o11', 'c2-o12']);
  }
  await page.getByRole('link', { name: /So với V1/ }).click();
  await expect(page).toHaveTitle('Phòng lab SQL · Ba thuật toán JOIN');
  expect(errors).toEqual([]);
});

test('motion moves inputs and results separately, with backwards replay and an offline file', async ({ page }) => {
  await page.setViewportSize({ width: 1150, height: 800 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(pathToFileURL(resolve('public/labs/join-algorithms-v2.html')).href);
  const next = page.getByRole('button', { name: 'Bước sau' });
  const slider = page.getByRole('slider');
  await next.click();
  await expect(page.locator('#left [data-row="c3"]')).toBeVisible();
  await expect(page.locator('.flyer[data-row="c3"]')).toHaveCount(1);
  await next.click();
  await expect(page.locator('#left [data-row="c3"]')).toBeVisible();
  await expect(page.locator('.flyer[data-row="c3"]')).toHaveCount(0);
  await expect(page.locator('.flyer[data-row="o10"]')).toHaveCount(1);

  await page.getByRole('button', { name: 'Hash Join' }).click();
  await next.click();
  await expect(page.locator('#bucket-1 [data-row="c3"]')).toBeVisible();
  await expect(page.locator('.flyer[data-row="c3"]')).toHaveCount(1);
  await expect(page.locator('#pairs li')).toHaveCount(0);
  await slider.press('Home');
  await expect(page.locator('#bucket-1 li')).toHaveCount(0);

  await page.getByRole('button', { name: 'Merge Join' }).click();
  await next.click();
  await expect(page.locator('#customers li')).toHaveText(['An1', 'Bình2', 'Chi3']);
  await next.click();
  await expect(page.locator('#right li')).toHaveText(['#101', '#111']);
  await next.click();
  await expect(page.locator('#pairs li')).toHaveCount(0);
  await next.click();
  await expect(page.locator('.flyer[data-row="c1-o10"]')).toHaveCount(1);
  await expect(page.locator('#pairs li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Bước trước' }).click();
  await expect(page.locator('#pairs li')).toHaveCount(0);
});

test('reduced motion and playback controls work on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto(lab);
  await page.getByRole('button', { name: 'Merge Join' }).click();
  await page.getByLabel('Tốc độ').selectOption({ label: '2×' });
  await page.getByRole('button', { name: 'Chạy', exact: true }).click();
  const slider = page.getByRole('slider');
  await expect(slider).toHaveValue('1');
  await page.clock.runFor(650);
  await expect(slider).toHaveValue('2');
  await page.getByRole('button', { name: 'Tạm dừng' }).click();
  await page.clock.runFor(1300);
  await expect(slider).toHaveValue('2');
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});
