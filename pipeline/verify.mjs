/**
 * Phase 6 + 7 — measures the performance budget and captures the verification screenshots.
 *
 *   node pipeline/verify.mjs <baseUrl> <outDir>
 *
 * LCP and CLS come from PerformanceObserver, which is the browser's own measurement, not a proxy.
 * Frame rate is bucketed by phase because 40% of the scroll is inside a transition band and an
 * overall average would be dominated by the cheaper single-scene path.
 */

import { chromium, devices } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:4210';
const outDir = process.argv[3] ?? 'tmp/verify';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();

/** Injected before any page script so the observers catch the very first entries. */
const OBSERVE = `
  window.__perf = { lcp: 0, cls: 0, shifts: [] };
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__perf.lcp = e.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (!e.hadRecentInput) { window.__perf.cls += e.value; window.__perf.shifts.push(e.value); }
    }
  }).observe({ type: 'layout-shift', buffered: true });
`;

// ---- Phase 6: budget, on a throttled mid-tier connection -----------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(OBSERVE);

  // "Mid-tier connection": ~5 Mbps down, 40 ms RTT, and 4x CPU throttling so the numbers are not
  // a desktop-only best case.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 40,
    downloadThroughput: (5 * 1024 * 1024) / 8,
    uploadThroughput: (1 * 1024 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const t0 = Date.now();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__monolith?.mode === 'scrub', null, { timeout: 60000 });
  const firstScene = await page.evaluate(() => window.__monolith.firstSceneMs);
  await page.waitForTimeout(3000);

  const perf = await page.evaluate(() => ({ ...window.__perf, transfer: performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), 0) }));

  console.log('PHASE 6 — budget  (5 Mbps / 40 ms RTT / 4x CPU throttle)');
  console.log(`  first scene visible   ${firstScene.toFixed(0)} ms          budget < 1500   ${firstScene < 1500 ? 'PASS' : 'FAIL'}`);
  console.log(`  LCP                   ${perf.lcp.toFixed(0)} ms          budget < 2000   ${perf.lcp < 2000 ? 'PASS' : 'FAIL'}`);
  console.log(`  CLS                   ${perf.cls.toFixed(4)}            budget < 0.05   ${perf.cls < 0.05 ? 'PASS' : 'FAIL'}`);
  console.log(`  transfer to first paint ~${(perf.transfer / 1024).toFixed(0)} kB   (wall ${Date.now() - t0} ms)`);
  await ctx.close();
}

// ---- Phase 6: frame rate, unthrottled, bucketed --------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__monolith?.mode === 'scrub');
  const model = await page.evaluate(() => ({
    total: window.__monolith.model.totalScroll,
    bands: window.__monolith.model.bands.map((b) => ({ start: b.start, end: b.end })),
  }));

  const sweep = async (from, to, step, dwell) => {
    const n = Math.max(1, Math.round(Math.abs(to - from) / step));
    for (let i = 0; i <= n; i++) {
      await page.evaluate((y) => window.scrollTo(0, y), Math.round(from + ((to - from) * i) / n));
      await page.waitForTimeout(dwell);
    }
  };

  await sweep(0, model.total, 200, 50);
  await page.evaluate(() => window.__monolith.resetMetrics());
  await sweep(0, model.total, 30, 20);
  const last = model.bands[model.bands.length - 1];
  await sweep(last.start, last.end, 8, 26);
  await sweep(last.end, last.start, 8, 26);
  await page.waitForTimeout(300);

  const [metrics, store] = await page.evaluate(() => [window.__monolith.metrics, window.__monolith.store]);
  console.log('');
  console.log(`  frame rate at 2560w — variants ${store.widths.join(',')}, ${(store.decodedBytes / 1048576).toFixed(1)} MB resident`);
  console.log('  phase             frames    p50     p95   worst   >16.7ms');
  for (const [name, m] of Object.entries(metrics)) {
    console.log(
      `  ${name.padEnd(16)}${String(m.frames).padStart(7)}${m.p50Ms.toFixed(2).padStart(7)}` +
        `${m.p95Ms.toFixed(2).padStart(8)}${m.worstMs.toFixed(2).padStart(8)}${String(m.over16ms).padStart(10)}`,
    );
  }
  await ctx.close();
}

// ---- Phase 7: widths -----------------------------------------------------------------------
console.log('');
console.log('PHASE 7 — verification');
// Real device shapes, not width x 0.62 — the scroll model is driven by viewport *height*, so a
// made-up height measures a viewport nobody has.
for (const [width, height] of [[375, 812], [768, 1024], [1440, 900], [2560, 1440]]) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__monolith?.mode === 'scrub');
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => ({
    widths: window.__monolith.store.widths,
    mb: +(window.__monolith.store.decodedBytes / 1048576).toFixed(1),
    total: window.__monolith.model.totalScroll,
  }));
  const doc = await page.evaluate(() => document.documentElement.scrollWidth);
  await page.screenshot({ path: join(outDir, `w${width}.png`) });
  console.log(
    `  ${String(width).padStart(4)}px  variants ${String(info.widths.join(',')).padEnd(14)} ` +
      `${String(info.mb).padStart(5)} MB   scroll ${info.total}px   h-overflow ${doc > width ? 'YES ' + doc : 'none'}`,
  );
  await ctx.close();
}

// ---- Phase 7: transition midpoints ---------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__monolith?.mode === 'scrub');
  const bands = await page.evaluate(() =>
    window.__monolith.model.bands.map((b) => ({ from: b.from, to: b.to, mid: Math.round((b.start + b.end) / 2), t: b.transition })),
  );
  for (const b of bands) {
    await page.evaluate((y) => window.scrollTo(0, y), b.mid);
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(outDir, `band-${b.from + 1}${b.to + 1}-${b.t}.png`) });
  }
  // Scene 01 and 04 with type on.
  for (const [label, y] of [['type-01', 300], ['type-04', 3100], ['type-07', 6300]]) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(outDir, `${label}.png`) });
  }
  console.log(`  captured ${bands.length} transition midpoints + 3 type positions`);
  await ctx.close();
}

// ---- Phase 7: scroll behaviours + reduced motion --------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__monolith?.mode === 'scrub');

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));

  const result = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const total = window.__monolith.model.totalScroll;
    const canvas = document.querySelector('[data-canvas]');
    const ctx = canvas.getContext('2d');

    /**
     * "Uniform" = every one of nine spread samples is byte-identical. Scene 01 is near-black but
     * carries a glow, so a genuinely drawn frame is never uniform; a frame that failed to composite
     * is. This is a real read of the canvas, not a proxy for one.
     */
    const uniform = () => {
      const pts = [];
      for (const fx of [0.15, 0.5, 0.85]) {
        for (const fy of [0.2, 0.5, 0.8]) {
          const d = ctx.getImageData(Math.round(canvas.width * fx), Math.round(canvas.height * fy), 1, 1).data;
          pts.push(`${d[0]},${d[1]},${d[2]}`);
        }
      }
      return new Set(pts).size === 1;
    };

    let blank = 0;
    let checks = 0;
    // slow, fast, upward
    const patterns = [
      { from: 0, to: total * 0.3, step: 20, dwell: 20 },
      { from: total * 0.3, to: total, step: 400, dwell: 8 },
      { from: total, to: 0, step: 300, dwell: 8 },
    ];
    for (const p of patterns) {
      const n = Math.max(1, Math.round(Math.abs(p.to - p.from) / p.step));
      for (let i = 0; i <= n; i++) {
        window.scrollTo(0, Math.round(p.from + ((p.to - p.from) * i) / n));
        await sleep(p.dwell);
        checks++;
        if (uniform()) blank++;
      }
    }
    // interrupted mid-transition: jump in, stop dead, reverse out
    const band = window.__monolith.model.bands[4];
    window.scrollTo(0, Math.round((band.start + band.end) / 2));
    await sleep(400);
    const midOk = !uniform();
    window.scrollTo(0, band.start - 200);
    await sleep(400);
    const outOk = !uniform();
    return { checks, blank, midOk, outOk };
  });
  console.log(
    `  scroll slow/fast/up: ${result.checks} samples, ${result.blank} uniform (failed) frames; ` +
      `interrupted mid-band drew ${result.midOk ? 'yes' : 'NO'}, reversed out drew ${result.outOk ? 'yes' : 'NO'}`,
  );
  console.log(`  page errors during scroll: ${errors.length}${errors.length ? ' — ' + errors[0] : ''}`);
  await ctx.close();
}

{
  const ctx = await browser.newContext({ ...devices['Desktop Chrome'], reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__monolith?.mode === 'still', null, { timeout: 20000 });
  const still = await page.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    imgs: document.querySelectorAll('img').length,
    words: document.body.innerText.trim().split(/\s+/).length,
    scene: window.__monolith.scene,
  }));
  await page.screenshot({ path: join(outDir, 'reduced-motion.png'), fullPage: false });
  console.log(`  reduced motion: scene ${still.scene}, ${still.canvases} canvas, ${still.imgs} img, ${still.words} words`);
  await ctx.close();
}

await browser.close();
