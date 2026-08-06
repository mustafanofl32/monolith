/**
 * Frame timing at the widest variant, bucketed by phase.
 *
 * Run at a 2560 CSS viewport so variant selection actually reaches the 2560 assets — the earlier
 * 1440 pass picked 1600 and therefore measured the cheaper case. The 06->07 band gets its own
 * slow crawl because it is the longest (689px) and the slowest curve, so it holds the two-bitmap
 * composite path open longer than anything else in the sequence.
 *
 *   node pipeline/bench-2560.mjs <baseUrl>
 */

import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4200';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__monolith?.mode === 'scrub');
await page.waitForTimeout(800);

const model = await page.evaluate(() => {
  const m = window.__monolith.model;
  return {
    totalScroll: m.totalScroll,
    bands: m.bands.map((b) => ({ from: b.from, to: b.to, start: b.start, end: b.end })),
  };
});

async function sweep(from, to, stepPx, dwellMs) {
  const steps = Math.max(1, Math.round(Math.abs(to - from) / stepPx));
  for (let i = 0; i <= steps; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), Math.round(from + ((to - from) * i) / steps));
    await page.waitForTimeout(dwellMs);
  }
}

// Warm every scene so decode cost is not attributed to the draw loop.
await sweep(0, model.totalScroll, 200, 60);
await page.waitForTimeout(600);
await page.evaluate(() => window.__monolith.resetMetrics());

// Steady pass over the whole film, then a slow crawl through the slowest band.
await sweep(0, model.totalScroll, 30, 20);
const last = model.bands[model.bands.length - 1];
await sweep(last.start, last.end, 8, 28);
await sweep(last.end, last.start, 8, 28);
await page.waitForTimeout(400);

const [metrics, store] = await page.evaluate(() => [window.__monolith.metrics, window.__monolith.store]);

console.log(`viewport 2560x1440 dpr 1   variants resident: ${store.widths.join(', ')}`);
console.log(`resident ${store.residentScenes} scenes = ${(store.decodedBytes / 1048576).toFixed(1)} MB decoded\n`);
console.log('phase             frames    mean     p50     p95   worst   >16.7ms   min fps (from p95)');
console.log('-'.repeat(88));
const order = Object.keys(metrics).sort((a, b) => (a === 'solo' ? -1 : b === 'solo' ? 1 : a.localeCompare(b)));
for (const name of order) {
  const m = metrics[name];
  const fps = m.p95Ms > 0 ? Math.min(999, 1000 / m.p95Ms) : 999;
  console.log(
    `${name.padEnd(16)}${String(m.frames).padStart(7)}${m.meanMs.toFixed(2).padStart(8)}` +
      `${m.p50Ms.toFixed(2).padStart(8)}${m.p95Ms.toFixed(2).padStart(8)}${m.worstMs.toFixed(2).padStart(8)}` +
      `${String(m.over16ms).padStart(10)}${fps.toFixed(0).padStart(21)}`,
  );
}

await browser.close();
