import { expect, test } from '@playwright/test';

const workbenches = [
  {
    url: '/optimization/primary-key-uuid-vs-integer-deep-dive/#primary-key-split-animation',
    id: 'primary-key-split-animation',
    altMode: 'UUIDv4 (Random Insert)',
  },
  {
    url: '/optimization/composite-index-deep-dive/#composite-index-animation',
    id: 'composite-index-animation',
    altMode: 'Gap / Range chặn cột sau: a=10 AND c=05',
  },
  {
    url: '/optimization/clustered-vs-nonclustered-index/#clustered-lookup-animation',
    id: 'clustered-lookup-animation',
    altMode: 'InnoDB Secondary (Double Lookup)',
  },
  {
    url: '/optimization/like-query-deep-dive/#like-pattern-animation',
    id: 'like-pattern-animation',
    altMode: "LIKE '%SQL%' (Leading Wildcard)",
  },
  {
    url: '/interview/offset-pagination-slow/#offset-pagination-animation',
    id: 'offset-pagination-animation',
    altMode: 'Keyset / Seek (WHERE id > 45 LIMIT 3)',
  },
  {
    url: '/interview/for-update-skip-locked/#skip-locked-animation',
    id: 'skip-locked-animation',
    altMode: 'FOR UPDATE (Chờ dây chuyền)',
  },
  {
    url: '/fundamentals/mvcc/#mvcc-snapshot-animation',
    id: 'mvcc-snapshot-animation',
    altMode: 'PostgreSQL Heap vs InnoDB Undo Log',
  },
  {
    url: '/optimization/dml-index-impact-deep-dive/#hot-update-animation',
    id: 'hot-update-animation',
    altMode: 'PostgreSQL MVCC (xmin / xmax)',
  },
  {
    url: '/postgresql/vacuum/#vacuum-bloat-animation',
    id: 'vacuum-bloat-animation',
    altMode: 'VACUUM FULL (Nén file, ACCESS EXCLUSIVE)',
  },
  {
    url: '/fundamentals/isolation-levels/#isolation-anomaly-animation',
    id: 'isolation-anomaly-animation',
    altMode: 'SERIALIZABLE (SSI chặn Write Skew)',
  },
  {
    url: '/fundamentals/lock/#lock-mechanics-animation',
    id: 'lock-mechanics-animation',
    altMode: 'Gap Lock & Next-Key Lock (InnoDB)',
  },
  {
    url: '/optimization/sql-partition-deep-dive/#partition-pruning-animation',
    id: 'partition-pruning-animation',
    altMode: 'Mất Pruning (Bọc hàm / Thiếu Partition Key)',
  },
  {
    url: '/interview/sharding-at-scale/#sharding-routing-animation',
    id: 'sharding-routing-animation',
    altMode: 'Scatter-Gather (Thiếu Shard Key)',
  },
  {
    url: '/fundamentals/query-execution-order/#query-pipeline-animation',
    id: 'query-pipeline-animation',
    altMode: 'LEFT JOIN: Filter trong WHERE (Mất NULL!)',
  },
  {
    url: '/interview/logical-vs-physical-query-execution/#left-join-filter-animation',
    id: 'left-join-filter-animation',
    altMode: 'LEFT JOIN: Filter trong WHERE (Mất NULL!)',
  },
  {
    url: '/interview/first-query-slow-cold-cache/#cold-warm-cache-animation',
    id: 'cold-warm-cache-animation',
    altMode: 'Lần chạy 2 — Warm Cache (~50ms)',
  },
  {
    url: '/optimization/join-algorithms-deep-dive/#join-animation',
    id: 'join-animation',
    altMode: 'Hash Join',
  },
];

test('all SQL interactive workbenches render, switch modes, step and stay error-free', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1080 });

  for (const item of workbenches) {
    await page.goto(item.url);
    const lab = page.locator(`#${item.id}`);
    await expect(lab).toBeVisible();

    const slider = lab.getByRole('slider');
    const max = Number(await slider.getAttribute('max'));
    if (max > 0) {
      await lab.getByRole('button', { name: 'Bước sau' }).click();
      await expect(slider).toHaveValue('1');
    }

    await lab.getByRole('button', { name: item.altMode }).click();
    await expect(slider).toHaveValue('0');
    const altMax = Number(await slider.getAttribute('max'));
    if (altMax > 0) {
      await slider.press('End');
      await expect(slider).toHaveValue(String(altMax));
    }
  }

  expect(errors).toEqual([]);
});

test('mobile dark mode has zero horizontal overflow across SQL workbenches', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('theme', 'dark'));

  for (const item of workbenches) {
    await page.goto(item.url);
    const lab = page.locator(`#${item.id}`);
    await expect(lab).toBeVisible();
    const ok = await lab.evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(ok, `Overflow detected in #${item.id}`).toBe(true);
  }
});
