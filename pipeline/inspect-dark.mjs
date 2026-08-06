/**
 * Renders a scene graded, plus a banding probe for it.
 *
 * The probe is the point. Banding in a near-black gradient is invisible on a normal monitor at
 * normal exposure — the whole problem is that it only appears once a display or a viewer's eyes
 * adapt to the dark. So the right panel lifts the shadows hard (a x6 gain on the bottom decile),
 * which is what a cheap laptop panel or a dark room effectively does. If contours show there,
 * they will show on someone's screen.
 *
 *   node pipeline/inspect-dark.mjs <scene> <out.png>
 */

import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scene = process.argv[2];
const out = process.argv[3];

const W = 1100;
const src = join(ROOT, 'src', 'scenes', 'graded', `${scene}.png`);

const { data, info } = await sharp(src)
  .resize({ width: W })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

// Shadow-lift probe: normalise the darkest 16% of the range up to full scale. Anything banding
// down there becomes plainly visible.
const LIFT_CEIL = 0.16;
const lifted = Buffer.allocUnsafe(data.length);
for (let i = 0; i < data.length; i++) {
  const v = data[i] / 255 / LIFT_CEIL;
  lifted[i] = Math.round(Math.min(1, v) * 255);
}

const raw = { width: info.width, height: info.height, channels: 3 };
const left = await sharp(data, { raw }).png().toBuffer();
const right = await sharp(lifted, { raw }).png().toBuffer();

const GAP = 8;
await sharp({
  create: {
    width: info.width * 2 + GAP * 3,
    height: info.height + GAP * 2,
    channels: 3,
    background: { r: 18, g: 18, b: 20 },
  },
})
  .composite([
    { input: left, left: GAP, top: GAP },
    { input: right, left: info.width + GAP * 2, top: GAP },
  ])
  .png()
  .toFile(out);

console.log(`${scene}: left = graded as shipped, right = shadows lifted ${(1 / LIFT_CEIL).toFixed(1)}x -> ${out}`);
