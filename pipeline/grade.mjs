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
 * Reads  src/scenes/<scene>.jpeg        (never modified)
 * Writes src/scenes/graded/<scene>.png  8-bit, dithered
 *
 * The graded PNGs are an inspection artefact, produced with byte-identical maths to the shipped
 * encode so that what is reviewed is what ships. The shipped assets are NOT built from these
 * files — `encode.mjs` re-applies the same grade to the source at its own resize, because
 * resizing before grading manufactures intermediate levels the stretch can land on and so bands
 * measurably less. See lib/grade-core.mjs.
 */

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES, analyse, samplePixels, median } from './lib/stats.mjs';
import { buildFloatLuts, gradeToFloat, ditherToU8 } from './lib/grade-core.mjs';
import { detectMatte, loadContent } from './lib/matte.mjs';

/** Fixed so rebuilds are byte-identical; see ditherToU8. */
export const DITHER_SEED = 0x5eed;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'scenes');
const OUT = join(SRC, 'graded');

/** How far toward smoothstep the contrast curve leans. 0.22 is a nudge, not a look. */
const S_CURVE = 0.22;

/** Cast correction is clamped so no single image is violently recoloured. */
const MAX_GAIN = 1.18;
const MIN_GAIN = 1 / MAX_GAIN;

/**
 * Ceiling on how far an image's tonal range may be stretched to reach the shared white point.
 *
 * Without this the levels step is auto-levels, and auto-levels cannot tell a dark *composition*
 * from an under-exposure. `01-void` peaks at 47/255 because it is meant to be nearly black.
 */
const MAX_STRETCH = 1.35;

/**
 * Closed-loop correction on one adjacent pair.
 *
 * Cohort spread is the wrong thing to converge: the viewer never sees scene 01 and scene 07 at
 * once, only adjacent pairs sharing a transition band. On the first pass 06->07 was the worst
 * adjacent delta at 533K, and it lands on the slowest transition in the sequence — a long
 * dissolve gives the eye the most time to notice a shift.
 *
 * Giving both scenes the same target does not fix it, because they already had one: the residual
 * comes from gain clamping and from the nonlinear levels/curve stages downstream of the gain. So
 * this measures what actually came out and corrects against that.
 *
 * The weights are lopsided on purpose. Moving 06 also widens 05->06, which is already 349K, so
 * most of the correction is spent on 07 where it costs nothing else.
 */
const PAIR_PULL = { a: '06-fracture', b: '07-return', aWeight: 0.18, bWeight: 0.82 };

function fmt(n, d = 1) {
  return Number(n).toFixed(d).padStart(d === 0 ? 5 : 6);
}

/**
 * Renders one graded scene at full resolution for inspection.
 *
 * Uses exactly the same grade + dither as the shipped encode, so what is reviewed here is what
 * gets encoded. A 16-bit intermediate was tried and abandoned: sharp's prebuilt binary does not
 * honour `raw.depth: 'ushort'` on this platform (a known 16-bit value came back as 25, the
 * signature of the buffer being read as 8-bit), and `toColourspace('rgb16')` is a colourspace
 * conversion rather than a depth widening — it halved every value. Since AVIF here is 8-bit only,
 * a high-depth intermediate buys nothing anyway: what matters is that there is exactly ONE
 * quantization, and that it is dithered.
 */
async function renderScene(scene, plan) {
  const { data, width, height } = await loadContent(join(SRC, `${scene}.jpeg`), plan.region);

  const luts = buildFloatLuts({ ...plan, sCurve: S_CURVE });
  const graded = gradeToFloat(data, luts);
  const dithered = ditherToU8(graded, DITHER_SEED);

  const file = join(OUT, `${scene}.png`);
  await sharp(dithered, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toFile(file);

  return file;
}

function castOf(stat) {
  const grey = (stat.neutralR + stat.neutralG + stat.neutralB) / 3 || 1;
  return [stat.neutralR / grey, stat.neutralG / grey, stat.neutralB / grey];
}

const clampGain = (g) => Math.min(MAX_GAIN, Math.max(MIN_GAIN, g));

async function main() {
  await mkdir(OUT, { recursive: true });

  // ---- measure the originals ---------------------------------------------------------
  // Mattes come off before anything is measured. 01-void carries 364 rows of black container,
  // which is exactly where its measured black point of 0 was coming from — the grade was being
  // computed against the matte rather than the image. See lib/matte.mjs.
  const regions = {};
  for (const scene of SCENES) {
    regions[scene] = await detectMatte(join(SRC, `${scene}.jpeg`));
  }

  const before = [];
  for (const scene of SCENES) {
    before.push({ scene, ...analyse(await samplePixels(join(SRC, `${scene}.jpeg`), regions[scene])) });
  }

  const targetBlack = median(before.map((b) => b.blackPoint));
  const targetWhite = median(before.map((b) => b.whitePoint));

  // Cast measured over near-neutral pixels only, so the amber accent is excluded from both the
  // per-image measurement and the shared target and is never corrected away.
  const casts = before.map(castOf);
  const targetCast = [0, 1, 2].map((c) => casts.reduce((a, k) => a + k[c], 0) / casts.length);

  const plans = SCENES.map((scene, i) => {
    const b = before[i];
    const range = Math.max(1, b.whitePoint - b.blackPoint);
    const cappedWhite = Math.min(targetWhite, targetBlack + range * MAX_STRETCH);
    return {
      scene,
      gains: [0, 1, 2].map((c) => clampGain(targetCast[c] / casts[i][c])),
      blackPoint: b.blackPoint,
      whitePoint: b.whitePoint,
      targetBlack,
      targetWhite: cappedWhite,
      region: regions[scene],
      stretch: (cappedWhite - targetBlack) / range,
      capped: cappedWhite < targetWhite,
    };
  });

  // ---- pass 1 --------------------------------------------------------------------------
  for (const plan of plans) await renderScene(plan.scene, plan);
  let after = [];
  for (const scene of SCENES) {
    after.push({ scene, ...analyse(await samplePixels(join(OUT, `${scene}.png`))) });
  }

  // ---- pass 2: closed-loop pull on the one adjacent pair that needs it ------------------
  const ia = SCENES.indexOf(PAIR_PULL.a);
  const ib = SCENES.indexOf(PAIR_PULL.b);
  const castA = castOf(after[ia]);
  const castB = castOf(after[ib]);

  // Where the two should meet. Weighted toward A, so the meeting point sits nearer 06 and it is
  // 07 that travels — moving 06 would widen 05->06, which is already the second-worst pair.
  const midpoint = [0, 1, 2].map((c) => castA[c] * PAIR_PULL.bWeight + castB[c] * PAIR_PULL.aWeight);

  for (const [idx, weight, measured] of [
    [ia, PAIR_PULL.aWeight, castA],
    [ib, PAIR_PULL.bWeight, castB],
  ]) {
    const corrective = [0, 1, 2].map((c) => {
      const full = midpoint[c] / measured[c];
      // Damp by the scene's weight so the lopsided split is honoured.
      return clampGain(1 + (full - 1) * weight);
    });
    plans[idx].gains = plans[idx].gains.map((g, c) => clampGain(g * corrective[c]));
    plans[idx].corrected = corrective;
    await renderScene(SCENES[idx], plans[idx]);
  }

  after = [];
  for (const scene of SCENES) {
    after.push({ scene, ...analyse(await samplePixels(join(OUT, `${scene}.png`))) });
  }

  // ---- report --------------------------------------------------------------------------
  console.log('shared grade');
  console.log(`  black point target : ${targetBlack}`);
  console.log(`  white point target : ${targetWhite}`);
  console.log(`  cast target R:G:B  : ${targetCast.map((v) => v.toFixed(4)).join(' : ')}  (cool, kept cool)`);
  console.log(`  s-curve            : ${S_CURVE} toward smoothstep`);
  console.log(`  pair pull          : ${PAIR_PULL.a} <-> ${PAIR_PULL.b}`);
  console.log('');

  const row = (label, r) =>
    `${label.padEnd(14)} ${fmt(r.blackPoint, 0)} ${fmt(r.whitePoint, 0)} ${fmt(r.meanLuma)} ${fmt(r.neutralCct, 0)}K`;

  console.log('              B E F O R E                  A F T E R');
  console.log('scene           black  white   mean neutral     black  white   mean neutral');
  console.log('─'.repeat(76));
  for (let i = 0; i < SCENES.length; i++) {
    console.log(`${row(SCENES[i], before[i])}    ${row('', after[i]).trimStart()}`);
  }

  console.log('');
  console.log('ADJACENT-PAIR neutral CCT delta — the only pairs a viewer ever sees together');
  console.log('pair            before     after');
  console.log('─'.repeat(40));
  let worstBefore = 0;
  let worstAfter = 0;
  for (let i = 0; i < SCENES.length - 1; i++) {
    const db = Math.abs(before[i].neutralCct - before[i + 1].neutralCct);
    const da = Math.abs(after[i].neutralCct - after[i + 1].neutralCct);

    // A pair is only measurable if BOTH scenes have a real neutral reference. 01-void has none:
    // 0.0% of its pixels are proportionally grey, so its "neutral CCT" is the fallback global
    // mean — a reading of its amber glow, not of its cast. Quoting that as a delta would be
    // reporting a number about nothing. It is also moot: at 4% mean luminance the eye cannot
    // judge colour temperature at all.
    const measurable = after[i].neutralUsable && after[i + 1].neutralUsable;
    const tag = i === SCENES.length - 2 ? '  <- slowest transition' : '';
    const label = String(i + 1).padStart(2, '0') + '->' + String(i + 2).padStart(2, '0');

    if (!measurable) {
      const which = [after[i], after[i + 1]].find((s) => !s.neutralUsable).scene;
      console.log(`${label.padEnd(14)} ${fmt(db, 0)}K       n/a   no neutral reference in ${which}`);
      continue;
    }
    worstBefore = Math.max(worstBefore, db);
    worstAfter = Math.max(worstAfter, da);
    console.log(`${label.padEnd(14)} ${fmt(db, 0)}K   ${fmt(da, 0)}K${tag}`);
  }
  console.log('─'.repeat(40));
  console.log(`${'worst measurable'.padEnd(14)} ${fmt(worstBefore, 0)}K   ${fmt(worstAfter, 0)}K`);

  console.log('');
  console.log('per-image correction');
  console.log('scene           R gain  G gain  B gain  stretch');
  for (const plan of plans) {
    console.log(
      `  ${plan.scene.padEnd(14)}${plan.gains.map((g) => g.toFixed(3)).join('   ')}   ` +
        `${plan.stretch.toFixed(2)}x` +
        `${plan.capped ? '  capped' : ''}${plan.corrected ? '  pair-pulled' : ''}`,
    );
  }

  await writeFile(
    join(OUT, 'grade-report.json'),
    `${JSON.stringify({ targetBlack, targetWhite, targetCast, sCurve: S_CURVE, plans, before, after }, null, 2)}\n`,
  );
}

await main();
