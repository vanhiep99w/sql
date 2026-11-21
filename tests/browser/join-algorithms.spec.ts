import { expect, test } from '@playwright/test';

const article = '/fundamentals/join-deep-dive/';
const name = 'Mô phỏng ba thuật toán JOIN vật lý';

test('the article renders the simulation inline and all three algorithms emit the same pairs', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(article);
  const headingId = 'mô-phỏng-đường-đi-của-một-dòng';
  await page.locator(`#nd-page a[href="#${headingId}"]`).click();
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe(`#${headingId}`);
  await expect(page.locator(`#${headingId}`)).toBeVisible();
  const lab = page.locator('#nd-page').getByRole('region', { name });
  await expect(lab).toBeVisible();
  await expect(lab.locator('iframe')).toHaveCount(0);
  const slider = lab.getByRole('slider');
  for (const mode of ['Nested Loop', 'Hash Join', 'Merge Join']) {
    await lab.getByRole('button', { name: mode }).click();
    await expect(slider).toHaveValue('0');
    await slider.press('End');
    const rows = lab.locator('[data-zone="output"] [data-row]');
    await expect(rows).toHaveCount(3);
    expect((await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-row')))).sort()).toEqual(['c1-o10', 'c1-o11', 'c2-o12']);
  }
  for (const old of ['join-algorithms.html', 'join-algorithms-v2.html']) {
    expect((await request.get(`/labs/${old}`)).status()).toBe(404);
  }
  expect(errors).toEqual([]);
});

test('inline motion preserves the outer row, builds buckets and emits merged pairs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${article}#join-animation`);
  const lab = page.getByRole('region', { name });
  const next = lab.getByRole('button', { name: 'Bước sau' });
  const sprites = lab.locator('[data-animation-layer]');
  const output = lab.getByRole('list', { name: 'Các cặp INNER JOIN' });
  await next.click();
  await expect(lab.getByRole('list', { name: 'Khách đang xét' })).toContainText('Chi');
  await expect(sprites.locator('[data-row="c3"]')).toHaveCount(1);
  await next.click();
  await expect(lab.getByRole('list', { name: 'Khách đang xét' })).toContainText('Chi');
  await expect(sprites.locator('[data-row="c3"]')).toHaveCount(0);
  await expect(sprites.locator('[data-row="o10"]')).toHaveCount(1);

  await lab.getByRole('button', { name: 'Hash Join' }).click();
  await next.click();
  const bucket = lab.getByRole('list', { name: 'Bucket 1' });
  await expect(bucket).toContainText('Chi');
  await expect(sprites.locator('[data-row="c3"]')).toHaveCount(1);
  await expect(output.locator('li')).toHaveCount(0);
  await lab.getByRole('slider').press('Home');
  await expect(bucket.locator('li')).toHaveCount(0);

  await lab.getByRole('button', { name: 'Merge Join' }).click();
  await next.click();
  await expect(lab.getByRole('list', { name: 'customers' }).locator('li')).toHaveText(['An1', 'Bình2', 'Chi3']);
  await next.click();
  await expect(lab.getByRole('list', { name: 'Đơn đang xét' }).locator('li')).toHaveText(['#101', '#111']);
  await next.click();
  await expect(output.locator('li')).toHaveCount(0);
  await next.click();
  await expect(sprites.locator('[data-row="c1-o10"]')).toHaveCount(1);
  await expect(output.locator('li')).toHaveCount(1);
  await lab.getByRole('button', { name: 'Bước trước' }).click();
  await expect(output.locator('li')).toHaveCount(0);
  await expect(sprites.locator('[data-row]')).toHaveCount(0);
});

test('mobile dark mode supports reduced motion and playback controls', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await page.clock.install();
  await page.goto(article);
  const lab = page.getByRole('region', { name });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await lab.getByRole('button', { name: 'Merge Join' }).click();
  await lab.getByLabel('Tốc độ').selectOption({ label: '2×' });
  await lab.getByRole('button', { name: 'Chạy', exact: true }).click();
  const slider = lab.getByRole('slider');
  await expect(slider).toHaveValue('1');
  await page.clock.runFor(650);
  await expect(slider).toHaveValue('2');
  await lab.getByRole('button', { name: 'Tạm dừng' }).click();
  await page.clock.runFor(1300);
  await expect(slider).toHaveValue('2');
  expect(await lab.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
  expect(await lab.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});
