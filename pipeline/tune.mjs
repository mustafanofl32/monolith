/**
 * Phase 2 quality tuning — finds the quality where dark-gradient artefacts appear, then steps back.
 *
 * "Tune until artefacts appear, then step back one" needs a number, so this sweeps quality on the
 * two darkest scenes at 1600w and measures the dark region only (see darkQuality). It reports the
 * sweep rather than silently picking, because the step-back is a judgement about where the curve
 * turns and that should be visible.
 *
 *   node pipeline/tune.mjs
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { contentRegion, renderAt, encodeBuffer, darkQuality } from './lib/encode-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'scenes');
const report = JSON.parse(await readFile(join(SRC, 'graded', 'grade-report.json'), 'utf8'));

const WIDTH = 1600;
const SCENES = ['01-void', '07-return'];
const SWEEPS = {
  avif: [30, 40, 45, 50, 55, 60, 70],
  webp: [55, 65, 72, 78, 82, 88],
  jpeg: [62, 70, 76, 82, 88],
};

for (const scene of SCENES) {
  const plan = report.plans.find((p) => p.scene === scene);
  const file = join(SRC, `${scene}.jpeg`);
  const region = await contentRegion(file, scene);
  const { rgb, width, height } = await renderAt(file, region, { ...plan, ditherSeed: 0x5eed }, WIDTH, report.sCurve);

  console.log(`\n${scene}  ${width}x${height} @ ${WIDTH}w`);
  for (const [format, qualities] of Object.entries(SWEEPS)) {
    console.log(`  ${format}   quality    size     dark RMSE   src flat   enc flat    delta`);
    for (const q of qualities) {
      // 4:4:4 throughout the sweep: these are the two darkest scenes, which is exactly where
      // halved chroma resolution shows on the amber glow.
      const buf = await encodeBuffer(rgb, width, height, format, q, '4:4:4');
      const m = await darkQuality(buf, rgb, width, height);
      // Only a POSITIVE delta means the encoder ate dither. Negative means it added texture.
      const flag = m.flatDelta > 0.01 ? '  <- eats dither' : '';
      console.log(
        `         ${String(q).padStart(6)}  ${(buf.length / 1024).toFixed(1).padStart(7)} kB` +
          `  ${m.rmse.toFixed(3).padStart(9)}  ${(m.refFlatShare * 100).toFixed(2).padStart(7)}%` +
          `  ${(m.encFlatShare * 100).toFixed(2).padStart(7)}%  ${(m.flatDelta * 100).toFixed(2).padStart(7)}%${flag}`,
      );
    }
  }
}
