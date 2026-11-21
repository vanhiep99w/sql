import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const lesson = '/fundamentals/join-deep-dive/';
const lab = '/labs/join-algorithms.html';

test('all three physical algorithms emit the same INNER JOIN pairs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(lesson);
  await page.getByRole('link', { name: 'Mở phòng lab mô phỏng ba thuật toán JOIN' }).click();
  await expect(page).toHaveURL(new RegExp(`${lab.replace('.', '\\.')}$`));
  const slider = page.getByRole('slider');

  for (const name of ['Nested Loop', 'Hash Join', 'Merge Join']) {
    await page.getByRole('button', { name }).click();
    await expect(page.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    await expect(slider).toHaveValue('0');
    await slider.press('End');
    await expect(page.getByRole('heading', { name: 'Đã ghép 3 cặp' })).toBeVisible();
    const pairs = await page.locator('#result-list tr').evaluateAll((rows: HTMLTableRowElement[]) =>
      rows.map((row) => `${row.cells[0].textContent}/${row.cells[2].textContent}`).sort());
    expect(pairs, name).toEqual(['1/10', '1/11', '2/12']);
  }

  await page.getByRole('link', { name: 'Về bài JOIN Deep Dive' }).click();
  await expect(page).toHaveURL(new RegExp(`${lesson}$`));
  expect(errors).toEqual([]);
});

test('steps show rescans, hash collisions and duplicate merge keys', async ({ page }) => {
  await page.goto(lab);
  const slider = page.getByRole('slider');
  const next = page.getByRole('button', { name: 'Bước sau' });
  const previous = page.getByRole('button', { name: 'Bước trước' });
  const results = page.locator('#result-list tr');

  for (let i = 0; i < 5; i++) await next.click();
  await expect(page.locator('#event-note')).toContainText('Bắt đầu quét orders từ đầu cho An');
  await expect(results).toHaveCount(1);
  await previous.click();
  await expect(results).toHaveCount(0);

  await page.getByRole('button', { name: 'Hash Join' }).click();
  for (let i = 0; i < 3; i++) await next.click();
  const buckets = page.getByRole('region', { name: /Bảng băm/ });
  await expect(buckets).toContainText('3 · Chi');
  await expect(buckets).toContainText('1 · An');
  await expect(results).toHaveCount(0);
  for (let i = 0; i < 6; i++) await next.click();
  await expect(page.getByRole('heading', { name: 'An và đơn #13: không khớp' })).toBeVisible();
  await expect(page.locator('#event-note')).toContainText('Cùng bucket nhưng 1 ≠ 9');
  await expect(results).toHaveCount(1);

  await page.getByRole('button', { name: 'Merge Join' }).click();
  const customerKeys = page.locator('#customers td:first-child');
  await expect(customerKeys).toHaveText(['3', '1', '2']);
  await next.click();
  await expect(customerKeys).toHaveText(['1', '2', '3']);
  await next.click();
  await expect(page.locator('#orders tr[data-state="active"] td:first-child')).toHaveText(['10', '11']);
  await next.click();
  await next.click();
  await expect(results.locator('td:last-child')).toHaveText(['10', '11']);
  await slider.press('Home');
  await expect(customerKeys).toHaveText(['3', '1', '2']);
  await expect(results).toHaveCount(0);
});

test('autoplay respects pause, reset and speed; mobile reduced-motion is usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto(lab);
  const slider = page.getByRole('slider');
  await page.getByLabel('Tốc độ').selectOption({ label: '2×' });
  await page.getByRole('button', { name: 'Chạy', exact: true }).click();
  await expect(slider).toHaveValue('1');
  await page.clock.runFor(550);
  await expect(slider).toHaveValue('2');
  await page.getByRole('button', { name: 'Tạm dừng' }).click();
  await page.clock.runFor(2000);
  await expect(slider).toHaveValue('2');
  await page.getByRole('button', { name: 'Về đầu' }).click();
  await expect(slider).toHaveValue('0');

  await page.getByRole('button', { name: 'Merge Join' }).click();
  await page.getByRole('button', { name: 'Bước sau' }).click();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test('the standalone file animates without a server', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(pathToFileURL(resolve('public/labs/join-algorithms.html')).href);
  await page.getByRole('button', { name: 'Merge Join' }).click();
  await page.getByRole('button', { name: 'Bước sau' }).click();
  await expect(page.getByRole('heading', { name: 'Hai đầu vào đã sắp theo khóa' })).toBeVisible();
  expect(await page.locator('#orders tr, #customers tr').evaluateAll((rows) =>
    rows.some((row) => row.getAnimations().length > 0))).toBe(true);
});
