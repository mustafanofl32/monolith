/**
 * Measures slab geometry per frame so warping is a number, not an impression.
 *
 * The lit face is the tractable feature: bright against a dark void, with a crisp left edge and a
 * crisp top edge. It is also where v1's warping was visible — its boundary went from straight to
 * curved. So for each frame this extracts the lit region and reports:
 *
 *   edgeBowPx   RMS deviation of the left edge from its own best-fit straight line. A rigid slab
 *               under any camera move has a straight vertical edge; a morphing one bows.
 *   aspect      lit-face width at mid-height / lit-face height. Under a pure orbit this changes
 *               smoothly and monotonically as the face turns away — it should not wander.
 *   topAngle    slope of the top edge in degrees. Tracks the top-face plane.
 *   baseX,baseY centroid of the bottom-most lit row — does the object stay planted.
 *
 *   node pipeline/geometry.mjs <framesDir> <frame...>
 */

import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(ROOT, process.argv[2]);
const frames = process.argv.slice(3);

/** Lit-face threshold. Well above the void and its glow, well below the face itself. */
const LIT = 70;

function fitLine(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (ys[i] - my) * (xs[i] - mx);
    den += (ys[i] - my) ** 2;
  }
  const slope = den === 0 ? 0 : num / den; // dx/dy
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const pred = mx + slope * (ys[i] - my);
    sq += (xs[i] - pred) ** 2;
  }
  return { slope, rms: Math.sqrt(sq / n) };
}

const rows = [];
for (const f of frames) {
  const file = join(dir, `f${String(f).padStart(4, '0')}.png`);
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;

  // Silhouette by strongest horizontal luminance gradient, not by an absolute threshold.
  //
  // A fixed "lit" threshold works on v1, whose slab has a bright face, and fails on v2, whose
  // slab is barely above the void — there it latches onto sparkle flecks and the rim highlight
  // rather than the object, which produces edge-bow figures that describe noise. The slab's
  // boundary is a strong vertical discontinuity in every frame regardless of how dark the face
  // is, so finding the largest |dL/dx| in each half of the row locates it in both clips.
  const lum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      lum[y * W + x] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
  }

  const left = [];
  const right = [];
  const ys = [];
  let top = -1;
  let bottom = -1;

  const MIN_EDGE = 6; // below this the row has no object boundary, only noise
  for (let y = 0; y < H; y++) {
    let bestL = 0;
    let xL = -1;
    let bestR = 0;
    let xR = -1;
    // 3px stencil suppresses single-pixel sparkle.
    for (let x = 3; x < W - 3; x++) {
      const g = Math.abs(
        (lum[y * W + x + 1] + lum[y * W + x + 2] + lum[y * W + x + 3]) / 3 -
          (lum[y * W + x - 1] + lum[y * W + x - 2] + lum[y * W + x - 3]) / 3,
      );
      if (x < W / 2) {
        if (g > bestL) { bestL = g; xL = x; }
      } else if (g > bestR) { bestR = g; xR = x; }
    }
    if (bestL > MIN_EDGE && bestR > MIN_EDGE && xR - xL > W * 0.05) {
      if (top < 0) top = y;
      bottom = y;
      left.push(xL);
      right.push(xR);
      ys.push(y);
    }
  }
  void LIT;

  if (ys.length < 20) {
    rows.push({ f, ok: false });
    continue;
  }

  // Restrict edge fitting to the middle 80% of height — the very top and bottom rows are where
  // the shadow boundary cuts across and would be measured as edge curvature that is not geometry.
  const lo = Math.floor(ys.length * 0.1);
  const hi = Math.ceil(ys.length * 0.9);
  const fit = fitLine(left.slice(lo, hi), ys.slice(lo, hi));

  const midIdx = Math.floor(ys.length / 2);
  const width = right[midIdx] - left[midIdx];
  const height = bottom - top;

  // Top edge slope over the first 12% of the lit height.
  const topSpan = Math.max(4, Math.floor(ys.length * 0.12));
  const topFit = fitLine(right.slice(0, topSpan), ys.slice(0, topSpan));

  const baseX = (left[ys.length - 1] + right[ys.length - 1]) / 2;

  rows.push({
    f,
    ok: true,
    edgeBow: fit.rms,
    aspect: width / height,
    width,
    height,
    topAngle: (Math.atan(topFit.slope) * 180) / Math.PI,
    baseX,
    baseY: bottom,
  });
}

console.log('frame   edgeBow(px)   lit W x H     W/H     topAngle   baseX   baseY');
for (const r of rows) {
  if (!r.ok) {
    console.log(`${String(r.f).padStart(5)}   (no lit region found)`);
    continue;
  }
  console.log(
    `${String(r.f).padStart(5)}   ${r.edgeBow.toFixed(2).padStart(10)}   ` +
      `${String(r.width).padStart(4)} x ${String(r.height).padEnd(4)}  ${r.aspect.toFixed(4)}   ` +
      `${r.topAngle.toFixed(2).padStart(7)}°   ${r.baseX.toFixed(0).padStart(5)}   ${String(r.baseY).padStart(5)}`,
  );
}

const ok = rows.filter((r) => r.ok);
if (ok.length > 1) {
  const span = (k) => {
    const v = ok.map((r) => r[k]);
    return { min: Math.min(...v), max: Math.max(...v) };
  };
  const bow = span('edgeBow');
  const asp = span('aspect');
  const ang = span('topAngle');
  const bx = span('baseX');
  const by = span('baseY');
  console.log('');
  console.log(`edge bow      max ${bow.max.toFixed(2)} px   (a rigid vertical edge fits its own line to well under 1 px)`);
  console.log(`aspect W/H    ${asp.min.toFixed(4)} .. ${asp.max.toFixed(4)}   drift ${(((asp.max - asp.min) / asp.min) * 100).toFixed(1)}%`);
  console.log(`top angle     ${ang.min.toFixed(2)}° .. ${ang.max.toFixed(2)}°   range ${(ang.max - ang.min).toFixed(2)}°`);
  console.log(`base drift    x ${(bx.max - bx.min).toFixed(0)} px,  y ${(by.max - by.min).toFixed(0)} px`);
}
