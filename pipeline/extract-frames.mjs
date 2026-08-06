/**
 * Extracts exact frames from the video using Chromium's decoder (no ffmpeg on this machine).
 *
 * Seeking targets the MIDDLE of a frame's display interval — t = (n + 0.5) / fps — because
 * seeking to a frame's exact start time lands on a boundary where the decoder may legitimately
 * present either neighbour. Half-interval targeting makes frame N unambiguous.
 *
 * `requestVideoFrameCallback` is awaited after each seek so the pixels drawn are the frame that
 * was actually presented, not whatever was on the previous compositor pass.
 *
 *   node pipeline/extract-frames.mjs <fps> <frameIndex...>
 */

import { chromium } from 'playwright';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Usage: node extract-frames.mjs <dir> <fps> <indices...> — dir added so v2 reuses this. */
const DIR = process.argv[2] ? join(ROOT, process.argv[2]) : join(ROOT, 'src', 'video');
/** Output keyed by source dir so v1 and v2 frames never collide. */
const OUT = join(ROOT, 'tmp', `frames-${basename(DIR)}`);
await mkdir(OUT, { recursive: true });

const fps = Number(process.argv[3]);
const wanted = process.argv.slice(4).map(Number);

const name = (await readdir(DIR)).find((f) => /\.(mp4|m4v|mov)$/i.test(f));
const data = await readFile(join(DIR, name));

// Served over HTTP rather than file:// so the media element behaves exactly as it will in the site.
const server = createServer((req, res) => {
  if (req.url.startsWith('/v.mp4')) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
    res.end(data);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body style="margin:0;background:#000"><video id="v" src="/v.mp4" muted playsinline></video>');
  }
});
await new Promise((r) => server.listen(4321, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
await page.goto('http://localhost:4321/');

const meta = await page.evaluate(async () => {
  const v = document.getElementById('v');
  await new Promise((res) => (v.readyState >= 2 ? res() : (v.onloadeddata = res)));
  return { w: v.videoWidth, h: v.videoHeight, duration: v.duration };
});
console.log(`decoded ${meta.w}x${meta.h}, duration ${meta.duration.toFixed(3)}s`);

for (const index of wanted) {
  const png = await page.evaluate(
    async ([i, rate]) => {
      const v = document.getElementById('v');
      const t = (i + 0.5) / rate;

      // Seek completion is polled rather than event-driven. Three separate signals proved
      // unreliable here: requestVideoFrameCallback never fires on a paused video in headless
      // (nothing is presented), requestAnimationFrame is throttled to ~1fps on a page that is not
      // animating, and `seeked` did not fire at all on a seek that crossed a keyframe boundary —
      // this clip has only 3 keyframes in 192 frames, so most seeks decode forward from a distant
      // reference. Polling currentTime against the target is the only signal that holds for all
      // of them, and it degrades to "carry on" rather than hanging.
      v.currentTime = t;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        // Tolerance is absolute, not a half-frame window. A half-frame tolerance is wide enough
        // for two adjacent targets to both satisfy it and resolve to the same displayed frame,
        // which is precisely what made the v1 "identical adjacent frames" result look like a
        // measurement bug. Seeks land on target to five decimals, so demand that.
        if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) break;
        await new Promise((res) => setTimeout(res, 15));
      }
      await new Promise((res) => setTimeout(res, 40));

      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d', { alpha: false }).drawImage(v, 0, 0);
      return c.toDataURL('image/png');
    },
    [index, fps],
  );

  const file = join(OUT, `f${String(index).padStart(4, '0')}.png`);
  await writeFile(file, Buffer.from(png.split(',')[1], 'base64'));
  console.log(`  frame ${String(index).padStart(4)}  t=${((index + 0.5) / fps).toFixed(4)}s  -> ${file}`);
}

await browser.close();
server.close();
