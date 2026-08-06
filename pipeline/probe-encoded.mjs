/**
 * Runs the shadow-lift banding probe on the FINAL ENCODED bytes, not on the graded PNG.
 *
 * The graded PNG is not the last link in the chain. AVIF and WebP are lossy and their rate-
 * distortion machinery treats fine noise as something to discard, so an encoder can smooth the
 * dither away and reintroduce the very banding the dither was added to prevent. The only file
 * that matters is the one the browser downloads.
 *
 *   node pipeline/probe-encoded.mjs <scene> <width> <out.png>
 */

import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { contentRegion, renderAt, encodeBuffer } from './lib/encode-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'scenes');
const [scene, widthArg, out] = process.argv.slice(2);
const WIDTH = Number(widthArg);

const report = JSON.parse(await readFile(join(SRC, 'graded', 'grade-report.json'), 'utf8'));
const plan = report.plans.find((p) => p.scene === scene);
const file = join(SRC, `${scene}.jpeg`);
const region = await contentRegion(file, scene);
const { rgb, width, height } = await renderAt(file, region, { ...plan, ditherSeed: 0x5eed }, WIDTH, report.sCurve);

const VARIANTS = [
  ['source (dithered, lossless)', null, null],
  ['avif q80 4:4:4', 'avif', 80],
  ['avif q90 4:4:4', 'avif', 90],
  ['webp q95 4:4:4', 'webp', 95],
];

const LIFT = 0.16;
const PAD = 8;
const LABEL = 22;

// Downscale the probe panels so three fit side by side without a huge output.
const VIEW_W = 470;
const VIEW_H = Math.round((VIEW_W * height) / width);

const layers = [];
for (let i = 0; i < VARIANTS.length; i++) {
  const [label, format, quality] = VARIANTS[i];
  let pixels = rgb;
  let bytes = null;
  if (format) {
    const buf = await encodeBuffer(rgb, width, height, format, quality, '4:4:4');
    bytes = buf.length;
    pixels = await sharp(buf).removeAlpha().raw().toBuffer();
  }

  const lifted = Buffer.allocUnsafe(pixels.length);
  for (let p = 0; p < pixels.length; p++) {
    lifted[p] = Math.round(Math.min(1, pixels[p] / 255 / LIFT) * 255);
  }

  const panel = await sharp(lifted, { raw: { width, height, channels: 3 } })
    .resize(VIEW_W, VIEW_H, { kernel: 'nearest' }) // nearest: do not let the resize invent smoothness
    .png()
    .toBuffer();

  const x = PAD + i * (VIEW_W + PAD);
  layers.push({
    input: Buffer.from(
      `<svg width="${VIEW_W}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg"><text x="0" y="15" font-family="monospace" font-size="13" fill="#c9c6c0">${label}${bytes ? `  ${(bytes / 1024).toFixed(1)} kB` : ''}</text></svg>`,
    ),
    left: x,
    top: 3,
  });
  layers.push({ input: panel, left: x, top: LABEL });
}

await sharp({
  create: {
    width: PAD + VARIANTS.length * (VIEW_W + PAD),
    height: LABEL + VIEW_H + PAD,
    channels: 3,
    background: { r: 16, g: 16, b: 18 },
  },
})
  .composite(layers)
  .png()
  .toFile(out);

console.log(`${scene} @ ${WIDTH}w (${width}x${height}) shadows lifted ${(1 / LIFT).toFixed(1)}x -> ${out}`);
