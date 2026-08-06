/**
 * Drives the built site and captures transition midpoints, plus phase-bucketed frame timings.
 *
 *   node pipeline/shots.mjs <baseUrl> <outDir>
 *
 * Screenshots are taken at the exact centre of a band, computed from the live model rather than
 * guessed as a fraction of the page — so "midpoint of 04->05" means the arithmetic midpoint of
 * that band, not roughly halfway down the document.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:4173';
const outDir = process.argv[3] ?? 'tmp/shots';
await mkdir(outDir, { recursive: true });

const VIEWPORT = { width: 1440, height: 900 };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__monolith?.mode === 'scrub');

const model = await page.evaluate(() => {
  const m = window.__monolith.model;
  return {
    totalScroll: m.totalScroll,
    documentHeight: m.documentHeight,
    bands: m.bands.map((b) => ({ from: b.from, to: b.to, start: b.start, end: b.end, transition: b.transition })),
    scenes: m.scenes.map((s) => ({ start: s.start, end: s.end })),
  };
});

console.log(`model: total ${model.totalScroll}px, ${model.bands.length} bands`);

/** Settle: the follower chases, so a screenshot taken immediately is mid-catch-up. */
async function settleAt(y) {
  await page.evaluate((target) => window.scrollTo(0, target), y);
  await page.waitForTimeout(700);
}

const wanted = ['mask-wipe-up', 'split-horizontal', 'long-dissolve'];
for (const band of model.bands) {
  if (!wanted.includes(band.transition)) continue;
  const mid = Math.round((band.start + band.end) / 2);
  await settleAt(mid);
  const label = `${String(band.from + 1).padStart(2, '0')}-${String(band.to + 1).padStart(2, '0')}-${band.transition}`;
  const file = join(outDir, `${label}.png`);
  await page.screenshot({ path: file });
  const state = await page.evaluate(() => {
    const s = window.__monolith.store;
    return { resident: s.residentScenes, mb: +(s.decodedBytes / 1048576).toFixed(1), widths: s.widths };
  });
  console.log(`  ${label}  y=${mid}  resident ${state.resident} scenes / ${state.mb} MB  widths ${state.widths.join(',')}`);
}

// ---- phase-bucketed frame timings ---------------------------------------------------------
// Averaged overall these would be 60% dominated by the cheap single-scene path. Measured per
// phase, a drop that only happens inside a transition cannot hide.
await page.evaluate(() => window.__monolith.resetMetrics());

async function sweep(from, to, stepPx, dwellMs) {
  const steps = Math.max(1, Math.round(Math.abs(to - from) / stepPx));
  for (let i = 0; i <= steps; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), Math.round(from + ((to - from) * i) / steps));
    await page.waitForTimeout(dwellMs);
  }
}

// A pass over the whole film at a steady rate, then a slow crawl through the slowest band.
await sweep(0, model.totalScroll, 40, 24);
const slow = model.bands[model.bands.length - 1];
await sweep(slow.start, slow.end, 12, 32);
await page.waitForTimeout(400);

const metrics = await page.evaluate(() => window.__monolith.metrics);
console.log('\nframe time by phase (ms)');
console.log('phase             frames    mean     p50     p95   worst   >16.7ms');
for (const [name, m] of Object.entries(metrics)) {
  console.log(
    `${name.padEnd(16)}${String(m.frames).padStart(7)}${m.meanMs.toFixed(2).padStart(8)}` +
      `${m.p50Ms.toFixed(2).padStart(8)}${m.p95Ms.toFixed(2).padStart(8)}${m.worstMs.toFixed(2).padStart(8)}` +
      `${String(m.over16ms).padStart(10)}`,
  );
}

await browser.close();
