/**
 * Phase 1 — grade the seven source images to a single shared look.
 *
 * The seven were generated independently, so their black points, white balance and contrast do
 * not match. During a transition the eye reads that mismatch instantly and calls it amateur. This
 * script measures all seven, derives one shared grade, applies it, and re-measures so the
 * convergence is visible rather than asserted.
 *
 *   node pipeline/grade.mjs
 *
 * Reads  src/scenes/<scene>.jpeg     (never modified)
 * Writes src/scenes/graded/<scene>.png
 *
 * PNG output on purpose: this is an intermediate. Re-encoding to JPEG here would bake in
 * generation-loss before the Phase 2 encoder has even seen the pixels.
 */

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES, analyse, samplePixels, buildLut, median, correlatedColourTemperature } from './lib/stats.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'scenes');
const OUT = join(SRC, 'graded');

/** How far toward smoothstep the contrast curve leans. 0.22 is a nudge, not a look. */
const S_CURVE = 0.22;

/** Cast correction is clamped so no single image is violently recoloured — if one is this far
 *  out, that is a grading decision for a human, not something to silently force into line. */
const MAX_GAIN = 1.18;
const MIN_GAIN = 1 / MAX_GAIN;

/**
 * Ceiling on how far an image's tonal range may be stretched to reach the shared white point.
 *
 * Without this the levels step is just auto-levels, and auto-levels cannot tell a dark
 * *composition* from an under-exposure. `01-void` peaks at 47/255 — it is meant to be nearly
 * black. Stretching it to the cohort white point is a 4x expansion: it lifts the mean luminance
 * from 11 to 42, turns the void grey, and amplifies every bit of banding in it.
 *
 * So the black point is always aligned exactly — that is the "same black everywhere" requirement,
 * and it is what the eye actually catches at a transition. The white point is pulled toward the
 * shared target only as far as this limit allows. An image with no highlight keeps not having one.
 */
const MAX_STRETCH = 1.35;

function fmt(n, d = 1) {
  return Number(n).toFixed(d).padStart(d === 0 ? 5 : 6);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // ---- pass 1: measure the originals -------------------------------------------------
  const before = [];
  for (const scene of SCENES) {
    const sample = await samplePixels(join(SRC, `${scene}.jpeg`));
    before.push({ scene, sample, ...analyse(sample) });
  }

  // ---- derive the shared grade -------------------------------------------------------
  // Targets are cohort medians, not extremes: converging on the middle moves every image a
  // little rather than dragging six of them to match one outlier.
  const targetBlack = median(before.map((b) => b.blackPoint));
  const targetWhite = median(before.map((b) => b.whitePoint));

  // Cast is the channel ratio with exposure divided out, so a dark scene and a bright scene are
  // comparable. Measured over near-neutral pixels only: the amber accent is excluded from both
  // the per-image measurement and the shared target, so it is never treated as something to
  // correct away. The target is the cohort's own average, so warmth common to all seven survives.
  const casts = before.map((b) => {
    const grey = (b.neutralR + b.neutralG + b.neutralB) / 3 || 1;
    return [b.neutralR / grey, b.neutralG / grey, b.neutralB / grey];
  });
  const targetCast = [0, 1, 2].map((c) => casts.reduce((a, k) => a + k[c], 0) / casts.length);

  console.log('shared grade');
  console.log(`  black point target : ${targetBlack}`);
  console.log(`  white point target : ${targetWhite}`);
  console.log(`  cast target R:G:B  : ${targetCast.map((v) => v.toFixed(4)).join(' : ')}`);
  console.log(`  s-curve            : ${S_CURVE} toward smoothstep`);
  console.log(
    `  cast measured over near-neutral pixels: ` +
      before.map((b) => `${(b.neutralShare * 100).toFixed(0)}%`).join(' '),
  );
  const thin = before.filter((b) => !b.neutralUsable).map((b) => b.scene);
  if (thin.length) {
    console.log(`  ! too few neutral pixels, fell back to global mean: ${thin.join(', ')}`);
  }
  console.log('');

  // ---- pass 2: apply, then re-measure ------------------------------------------------
  const after = [];
  for (let i = 0; i < SCENES.length; i++) {
    const scene = SCENES[i];
    const b = before[i];

    const gains = [0, 1, 2].map((c) => {
      const g = targetCast[c] / casts[i][c];
      return Math.min(MAX_GAIN, Math.max(MIN_GAIN, g));
    });

    // Limit the stretch. A dark composition keeps its ceiling; only genuinely mis-matched
    // exposures get pulled the whole way to the shared white point.
    const range = Math.max(1, b.whitePoint - b.blackPoint);
    const cappedWhite = Math.min(targetWhite, targetBlack + range * MAX_STRETCH);
    const stretch = (cappedWhite - targetBlack) / range;

    const luts = buildLut({
      gains,
      blackPoint: b.blackPoint,
      whitePoint: b.whitePoint,
      targetBlack,
      targetWhite: cappedWhite,
      sCurve: S_CURVE,
    });

    const outFile = join(OUT, `${scene}.png`);
    await sharp(join(SRC, `${scene}.jpeg`))
      .removeAlpha()
      // One LUT per channel applies cast + levels + curve in a single pass.
      .recomb([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ])
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(async ({ data, info }) => {
        for (let p = 0; p < data.length; p += 3) {
          data[p] = luts[0][data[p]];
          data[p + 1] = luts[1][data[p + 1]];
          data[p + 2] = luts[2][data[p + 2]];
        }
        await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
          .png({ compressionLevel: 9 })
          .toFile(outFile);
      });

    const sample = await samplePixels(outFile);
    after.push({ scene, gains, stretch, capped: cappedWhite < targetWhite, ...analyse(sample) });
  }

  // ---- report ------------------------------------------------------------------------
  const spread = (rows, key) => Math.max(...rows.map((r) => r[key])) - Math.min(...rows.map((r) => r[key]));

  const row = (label, r) =>
    `${label.padEnd(14)} ${fmt(r.blackPoint, 0)} ${fmt(r.whitePoint, 0)} ${fmt(r.meanLuma)} ` +
    `${fmt(r.neutralCct, 0)}K ${fmt(r.cct, 0)}K`;

  console.log('                    B E F O R E                            A F T E R');
  console.log(
    'scene           black  white   mean  neutral  frame     black  white   mean  neutral  frame',
  );
  console.log('─'.repeat(94));
  for (let i = 0; i < SCENES.length; i++) {
    console.log(`${row(SCENES[i], before[i])}    ${row('', after[i]).trimStart()}`);
  }
  console.log('─'.repeat(94));
  const spreadRow = (rows) =>
    `${fmt(spread(rows, 'blackPoint'), 0)} ${fmt(spread(rows, 'whitePoint'), 0)} ` +
    `${fmt(spread(rows, 'meanLuma'))} ${fmt(spread(rows, 'neutralCct'), 0)}K ${fmt(spread(rows, 'cct'), 0)}K`;
  console.log(`${'spread'.padEnd(14)} ${spreadRow(before)}    ${spreadRow(after)}`);
  console.log('');
  console.log('  neutral = CCT of near-neutral pixels — what the cast correction targets, must converge');
  console.log('  frame   = CCT of the whole frame — includes the amber accent, SHOULD stay varied');
  console.log('');
  console.log('per-image correction applied');
  console.log('scene           R gain  G gain  B gain  stretch');
  for (const a of after) {
    console.log(
      `  ${a.scene.padEnd(14)}${a.gains.map((g) => g.toFixed(3)).join('   ')}   ` +
        `${a.stretch.toFixed(2)}x${a.capped ? '  <- capped, dark composition preserved' : ''}`,
    );
  }

  await writeFile(
    join(OUT, 'grade-report.json'),
    `${JSON.stringify({ targetBlack, targetWhite, targetCast, sCurve: S_CURVE, before, after }, replacer, 2)}\n`,
  );
}

/** Drop the raw pixel buffers from the JSON report — they are megabytes of noise. */
function replacer(key, value) {
  return key === 'sample' ? undefined : value;
}

await main();
