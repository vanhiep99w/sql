import { expect, test } from '@playwright/test';

const article = '/optimization/b-plus-tree-deep-dive/';
const searchTitle = 'Mô phỏng tìm kiếm và quét khoảng trên B+Tree';
const splitTitle = 'Mô phỏng chèn dữ liệu và chia page trên B+Tree';

test('search workbench runs exact lookup and range scan across sibling links', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${article}#btree-search-animation`);

  const lab = page.locator('#nd-page').getByRole('region', { name: searchTitle });
  await expect(lab).toBeVisible();
  const next = lab.getByRole('button', { name: 'Bước sau' });
  const slider = lab.getByRole('slider');
  const results = lab.locator('[data-zone="output"] [data-result-key]');
  const pages = lab.locator('[data-zone="pages"] li');

  // Exact lookup (id = 42)
  await slider.press('End');
  await expect(pages).toHaveText(['Root', 'Leaf B']);
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('42');

  // Switch to Range Scan (35..75)
  await lab.getByRole('button', { name: 'Quét khoảng (35..75)' }).click();
  await expect(slider).toHaveValue('0');
  await expect(results).toHaveCount(0);

  // Step through to first emitted key (step 3) and verify fly animation sprite
  await next.click();
  await next.click();
  await next.click();
  await expect(results).toHaveCount(1);
  await expect(lab.locator('[data-animation-layer] [data-fly-target="[data-result-key=\\"42\\"]"]')).toHaveCount(1);

  // Advance to sibling link traversal (step 5) and verify traveling sibling pulse
  await next.click();
  await next.click();
  await expect(lab.locator('[data-sibling="leaf-b-leaf-c"]')).toHaveAttribute('data-active', 'true');
  await expect(lab.locator('[data-animation-layer] [data-sibling-pulse="leaf-b-leaf-c"]')).toHaveCount(1);
  await expect(pages).toHaveText(['Root', 'Leaf B', 'Leaf C']);

  // Advance to stop step (step 8: key 90 > 75)
  await next.click();
  await next.click();
  await next.click();
  await expect(lab.locator('[data-key-id="leaf-c:90"]')).toHaveAttribute('data-state', 'stopped');
  await expect(results).toHaveCount(4);
  expect(await results.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-result-key')))).toEqual(['42', '55', '60', '75']);

  expect(errors).toEqual([]);
});

test('split workbench demonstrates insert with room, leaf split and root split height growth', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${article}#btree-split-animation`);

  const lab = page.locator('#nd-page').getByRole('region', { name: splitTitle });
  await expect(lab).toBeVisible();
  const next = lab.getByRole('button', { name: 'Bước sau' });
  const slider = lab.getByRole('slider');

  // Mode 1: Insert with room (47)
  await slider.press('End');
  await expect(lab.locator('[data-node="leaf-b"]')).toContainText('47');
  await expect(lab.locator('[data-node="leaf-b2"]')).toHaveCount(0);

  // Mode 2: Leaf Page Split — verify smooth node glide + split emergence + key migration
  await lab.getByRole('button', { name: 'Chia leaf đầy (Page Split)' }).click();
  await expect(slider).toHaveValue('0');
  for (let i = 0; i < 3; i++) await next.click();
  await expect(lab.locator('[data-node="leaf-b2"]')).toBeVisible();
  await expect(lab.locator('[data-animation-layer] [data-fly-target="[data-key-id=\\"leaf-b2:45\\"]"]')).toHaveCount(1);
  expect(await lab.locator('[data-node="leaf-b2"]').evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
  expect(await lab.locator('[data-node="leaf-c"]').evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
  // Wait for FLIP animations to settle and verify SVG wire endpoints match exact Root bottom -> Leaf top.
  await lab.evaluate(async (node) => {
    await Promise.allSettled(node.getAnimations({ subtree: true }).map((a) => a.finished));
  });
  const wireCheck = await lab.evaluate((node) => {
    const vp = node.querySelector('[data-tree-viewport]')!.getBoundingClientRect();
    const rootBottom = node.querySelector('[data-node="root"]')!.getBoundingClientRect().bottom - vp.top;
    const leafTop = node.querySelector('[data-node="leaf-b2"]')!.getBoundingClientRect().top - vp.top;
    const path = node.querySelector('[data-edge-key="root-leaf-b2-1.18"]')!.getAttribute('d')!;
    const nums = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    return { y1: nums[1], y2: nums[nums.length - 1], rootBottom, leafTop };
  });
  expect(Math.abs(wireCheck.y1 - wireCheck.rootBottom)).toBeLessThan(2);
  expect(Math.abs(wireCheck.y2 - wireCheck.leafTop)).toBeLessThan(2);
  // Step 4 promotes separator 45 to Root and smoothly parts 30 & 60
  await next.click();
  await expect(lab.locator('[data-animation-layer] [data-fly-target="[data-key-id=\\"root:45\\"]"]')).toHaveCount(1);
  await expect(lab.locator('[data-node="root"]')).toContainText('45');
  await expect(lab.locator('[data-zone="tree"] [data-key-id="root:45"]')).toHaveAttribute('data-state', 'new');
  await expect(lab.locator('[data-node="leaf-b2"]')).toContainText('45');

  // Mode 3: Root Split (2 levels -> 3 levels) — verify height expansion + root split emergence + leaf glide
  await lab.getByRole('button', { name: 'Root đầy → Tăng chiều cao' }).click();
  await expect(slider).toHaveValue('0');
  await expect(lab.locator('[data-level]')).toHaveCount(2);
  for (let i = 0; i < 4; i++) await next.click();
  await expect(lab.locator('[data-level]')).toHaveCount(3);
  expect(await lab.locator('[data-tree-viewport]').evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
  expect(await lab.locator('[data-node="new-root"]').evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
  expect(await lab.locator('[data-node="int-a"]').evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
  expect(await lab.locator('[data-node="leaf-a"]').evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
  await expect(lab.locator('[data-node="new-root"]')).toContainText('42');
  await expect(lab.locator('[data-node="int-a"]')).toContainText('30');
  await expect(lab.locator('[data-node="int-b"]')).toContainText('60');

  expect(errors).toEqual([]);
});

test('mobile dark mode supports reduced motion, playback controls and zero horizontal overflow', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await page.clock.install();
  await page.goto(article);

  await expect(page.locator('html')).toHaveClass(/dark/);

  for (const title of [searchTitle, splitTitle]) {
    const lab = page.getByRole('region', { name: title });
    await expect(lab).toBeVisible();
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
  }

  // Also check widest state (4 leaves + 3 levels on Root Split) at 320px
  const splitLab = page.getByRole('region', { name: splitTitle });
  await splitLab.getByRole('button', { name: 'Root đầy → Tăng chiều cao' }).click();
  await splitLab.getByRole('slider').press('End');
  expect(await splitLab.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});
