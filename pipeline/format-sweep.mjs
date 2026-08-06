/**
 * The AVIF-vs-WebP decision for the two near-black scenes, in numbers.
 *
 * Encodes the final graded pixels at each candidate setting and reports size alongside the
 * flat-block share — the fraction of dark 8x8 blocks whose pixels are all identical. The graded
 * source is dithered, so its flat share is ~0; anything the encoder adds is dither it discarded,
 * which is banding waiting to appear on a wide gamut display.
 *
 *   node pipeline/format-sweep.mjs
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { contentRegion, renderAt, encodeBuffer, darkQuality } from './lib/encode-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'scenes');
const report = JSON.parse(await readFile(join(SRC, 'graded', 'grade-report.json'), 'utf8'));

const CANDIDATES = [
  ['avif', 62, '4:2:0'],
  ['avif', 80, '4:4:4'],
  ['avif', 90, '4:4:4'],
  ['webp', 88, '4:4:4'],
  ['webp', 95, '4:4:4'],
  ['jpeg', 88, '4:4:4'],
];

for (const scene of ['01-void', '07-return']) {
  const plan = report.plans.find((p) => p.scene === scene);
  const file = join(SRC, `${scene}.jpeg`);
  const region = await contentRegion(file, scene);

  for (const width of [1600, 2560]) {
    if (width > region.width) continue;
    const { rgb, width: w, height: h } = await renderAt(
      file,
      region,
      { ...plan, ditherSeed: 0x5eed },
      width,
      report.sCurve,
    );

    console.log(`\n${scene} @ ${width}w  (${w}x${h})`);
    console.log('  format  quality  chroma      size    flat blocks   added by encoder');
    for (const [format, quality, chroma] of CANDIDATES) {
      const buf = await encodeBuffer(rgb, w, h, format, quality, chroma);
      const m = await darkQuality(buf, rgb, w, h);
      console.log(
        `  ${format.padEnd(7)}${String(quality).padStart(6)}   ${chroma}` +
          `${((buf.length / 1024).toFixed(1) + ' kB').padStart(11)}` +
          `${(m.encFlatShare * 100).toFixed(2).padStart(12)}%` +
          `${(m.flatDelta * 100).toFixed(2).padStart(15)}%`,
      );
    }
  }
}
