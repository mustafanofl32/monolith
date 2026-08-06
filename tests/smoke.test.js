/**
 * Smoke test — the one that runs a real browser against a real production build.
 *
 * Everything else in tests/ is DOM-free by design, which leaves renderer.js, transitions.js,
 * bitmap-store.js, grain.js and overlay.js unexercised. This covers the path those modules are on:
 * the page boots, decodes, composites something that is not a flat fill, survives a scroll through
 * every transition, and honours reduced motion.
 *
 * Skipped automatically when `dist/` is absent or Playwright's browser is not installed, so
 * `npm test` still works on a clone that has not built yet. CI always has both.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  chromium = null;
}

const reason = !existsSync(dist)
  ? 'dist/ not built — run `npm run build` first'
  : !chromium
    ? 'playwright not installed'
    : null;

/**
 * Registers a test, skipping it only when there is a reason to.
 *
 * `test(name, { skip: null }, fn)` still skips on this runner — the *presence* of the option is
 * what counts, not its value. So the option is omitted entirely when the test should run.
 */
const maybe = (name, fn) => (reason ? test(name, { skip: reason }, fn) : test(name, fn));

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** A static server for dist/, so the smoke test does not depend on `vite preview` or a free port. */
async function serve() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(dist, path === '/' ? 'index.html' : path);
    if (!file.startsWith(dist)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

maybe('the built site boots, composites, and scrolls through every transition', async () => {
  const { server, base } = await serve();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__monolith?.mode === 'scrub', null, { timeout: 30000 });

    // The preloader must clear itself, or the piece is invisible behind an opaque panel forever.
    await page.waitForFunction(() => !document.querySelector('[data-preloader]'), null, { timeout: 10000 });

    const model = await page.evaluate(() => ({
      total: window.__monolith.model.totalScroll,
      bands: window.__monolith.model.bands.map((b) => Math.round((b.start + b.end) / 2)),
      max: document.documentElement.scrollHeight - window.innerHeight,
    }));

    // The document must be exactly as tall as the model needs: no dead scroll, nothing unreachable.
    assert.equal(model.max, model.total, 'document height does not match the scroll model');
    assert.equal(model.bands.length, 6);

    /** True when the canvas is drawing an image rather than a flat backdrop fill. */
    const composited = () =>
      page.evaluate(() => {
        const canvas = document.querySelector('[data-canvas]');
        const ctx = canvas.getContext('2d');
        const seen = new Set();
        for (const fx of [0.15, 0.5, 0.85]) {
          for (const fy of [0.2, 0.5, 0.8]) {
            const d = ctx.getImageData(Math.round(canvas.width * fx), Math.round(canvas.height * fy), 1, 1).data;
            seen.add(`${d[0]},${d[1]},${d[2]}`);
          }
        }
        return seen.size > 1;
      });

    assert.ok(await composited(), 'the hero never composited');

    // Every transition midpoint, forwards.
    for (const [i, y] of model.bands.entries()) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(500);
      assert.ok(await composited(), `band ${i + 1} midpoint drew a flat frame`);
    }

    // And back up, which is the direction that needs the previous bitmap still resident.
    for (const y of [...model.bands].reverse()) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(220);
      assert.ok(await composited(), 'scrolling back up drew a flat frame');
    }

    // Residency must stay bounded no matter how far it has been scrolled.
    const stats = await page.evaluate(() => window.__monolith.store);
    assert.ok(stats.residentScenes <= 3, `${stats.residentScenes} scenes resident, expected <= 3`);

    assert.deepEqual(errors, [], 'the page logged errors');
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});

maybe('reduced motion gets a real document, not a disabled animation', async () => {
  const { server, base } = await serve();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__monolith?.mode === 'still', null, { timeout: 30000 });

    const still = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      images: document.querySelectorAll('img').length,
      text: document.body.innerText.trim(),
      preloader: !!document.querySelector('[data-preloader]'),
      srcset: document.querySelector('img')?.srcset ?? '',
    }));

    assert.equal(still.canvases, 0, 'reduced motion should not create a canvas at all');
    assert.equal(still.images, 1);
    assert.equal(still.preloader, false);
    assert.ok(still.srcset.includes('640w'), 'the still must stay responsive');
    // Every word of the chapter copy is present, so nothing is lost but the motion.
    for (const phrase of ['MONOLITH', 'Every surface remembers', 'Seven images.']) {
      assert.ok(still.text.includes(phrase), `reduced motion is missing "${phrase}"`);
    }
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});
