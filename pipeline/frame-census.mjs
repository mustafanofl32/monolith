/**
 * Hashes every frame in the clip to find how many are actually DISTINCT.
 *
 * Prompted by finding frames 94-100 byte-identical. A container reporting 24fps says nothing
 * about how many unique images it holds: a generator that renders at a low rate and pads to 24
 * produces a file that probes as 192 frames and animates like far fewer.
 *
 * Hashing happens in-page and only the digest crosses the bridge, so this costs one canvas read
 * per frame instead of 192 PNG transfers.
 */

import { chromium } from 'playwright';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Usage: node frame-census.mjs <dir> <fps> <frameCount> — dir added so v2 reuses this unchanged. */
const DIR = process.argv[2] ? join(ROOT, process.argv[2]) : join(ROOT, 'src', 'video');
const FPS = Number(process.argv[3] ?? 24);
const COUNT = Number(process.argv[4] ?? 192);

const name = (await readdir(DIR)).find((f) => /\.(mp4|m4v|mov)$/i.test(f));
const data = await readFile(join(DIR, name));

const server = createServer((req, res) => {
  if (req.url.startsWith('/v.mp4')) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
    res.end(data);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body><video id=v src=/v.mp4 muted playsinline></video>');
  }
});
await new Promise((r) => server.listen(4323, r));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:4323/');
await page.evaluate(
  () =>
    new Promise((r) => {
      const v = document.getElementById('v');
      v.readyState >= 2 ? r() : (v.onloadeddata = r);
    }),
);

const hashes = await page.evaluate(
  async ([fps, count]) => {
    const v = document.getElementById('v');
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const g = c.getContext('2d', { alpha: false, willReadFrequently: true });
    const out = [];

    for (let n = 0; n < count; n++) {
      const t = (n + 0.5) / fps;
      v.currentTime = t;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) break;
        await new Promise((r) => setTimeout(r, 8));
      }
      await new Promise((r) => setTimeout(r, 25));

      g.drawImage(v, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      // FNV-1a over a 1-in-13 pixel stride. Enough to separate genuinely different frames while
      // staying cheap; identical frames hash identically regardless of stride.
      let h = 0x811c9dc5;
      let lum = 0;
      for (let i = 0; i < d.length; i += 52) {
        h ^= d[i];
        h = Math.imul(h, 0x01000193);
        h ^= d[i + 1];
        h = Math.imul(h, 0x01000193);
        lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      out.push({ n, hash: (h >>> 0).toString(16), lum: lum / (d.length / 52) });
    }
    return out;
  },
  [FPS, COUNT],
);

await browser.close();
server.close();

// ---- analysis ----------------------------------------------------------------------------
const runs = [];
let current = { hash: hashes[0].hash, start: 0, length: 1, lum: hashes[0].lum };
for (let i = 1; i < hashes.length; i++) {
  if (hashes[i].hash === current.hash) current.length++;
  else {
    runs.push(current);
    current = { hash: hashes[i].hash, start: i, length: 1, lum: hashes[i].lum };
  }
}
runs.push(current);

const distinct = new Set(hashes.map((h) => h.hash)).size;

console.log(`frames probed      ${hashes.length}`);
console.log(`distinct images    ${distinct}`);
console.log(`effective rate     ${((distinct / hashes.length) * FPS).toFixed(2)} fps of real motion (container says ${FPS})`);
console.log('');
console.log(`duplicate runs     ${runs.length} runs`);
const lengths = runs.map((r) => r.length);
console.log(
  `run length         min ${Math.min(...lengths)}  median ${lengths.slice().sort((a, b) => a - b)[Math.floor(lengths.length / 2)]}  max ${Math.max(...lengths)}`,
);
console.log('');
console.log('run layout (each block is one distinct image, number = how many frames it is held)');
console.log(
  runs
    .map((r) => String(r.length))
    .join(' ')
    .replace(/(.{100})/g, '$1\n'),
);

// Luminance across distinct images — a proxy for lighting flicker independent of geometry.
const lums = runs.map((r) => r.lum);
const dl = [];
for (let i = 1; i < lums.length; i++) dl.push(Math.abs(lums[i] - lums[i - 1]));
dl.sort((a, b) => a - b);
console.log('');
console.log(
  `luminance step between distinct images: median ${dl[Math.floor(dl.length / 2)].toFixed(3)}  ` +
    `p95 ${dl[Math.floor(dl.length * 0.95)].toFixed(3)}  max ${dl[dl.length - 1].toFixed(3)}  (0-255 scale)`,
);
