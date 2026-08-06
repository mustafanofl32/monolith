/**
 * Builds a before/after contact sheet so the grade can be judged by eye, not only by its table.
 * Top row: originals. Bottom row: graded. Same order, same scale.
 *
 *   node pipeline/compare.mjs <out.jpg>
 */

import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES } from './lib/stats.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'scenes');
const out = process.argv[2] ?? join(ROOT, 'tmp', 'grade-compare.jpg');

const TILE_W = 360;
const TILE_H = Math.round((TILE_W * 1536) / 2752);
const GAP = 6;

const cols = SCENES.length;
const width = cols * TILE_W + (cols + 1) * GAP;
const height = 2 * TILE_H + 3 * GAP;

const layers = [];
for (let i = 0; i < SCENES.length; i++) {
  const x = GAP + i * (TILE_W + GAP);
  layers.push({
    input: await sharp(join(SRC, `${SCENES[i]}.jpeg`)).resize(TILE_W, TILE_H).toBuffer(),
    left: x,
    top: GAP,
  });
  layers.push({
    input: await sharp(join(SRC, 'graded', `${SCENES[i]}.png`)).resize(TILE_W, TILE_H).toBuffer(),
    left: x,
    top: GAP * 2 + TILE_H,
  });
}

await sharp({
  create: { width, height, channels: 3, background: { r: 24, g: 24, b: 26 } },
})
  .composite(layers)
  .jpeg({ quality: 88 })
  .toFile(out);

console.log(`contact sheet -> ${out}  (${width}x${height})`);
console.log('top row = original, bottom row = graded, order 01..07');
