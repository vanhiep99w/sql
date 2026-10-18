import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('catalog assets match their reviewed hashes and contain no executable/external resources', async () => {
  const assets = JSON.parse(await readFile('content/diagram-assets/catalog.json', 'utf8'));
  assert.equal(assets.length, 2);
  for (const asset of assets) {
    assert.match(asset.source, /^https:\/\/icons\.d2lang\.com\/dev\/(mysql|postgresql)\.svg$/);
    const svg = await readFile(`content/diagram-assets/${asset.file}`, 'utf8');
    assert.equal(createHash('sha256').update(svg).digest('hex'), asset.sha256);
    assert.match(svg, /^<svg\b/);
    assert.doesNotMatch(svg, /<script|<foreignObject|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|\/\/|javascript:)/i);
  }
});
