/**
 * The six transitions. One per adjacent pair, never the same twice in a row.
 *
 * Each receives the two decoded bitmaps, the band's eased progress, and each scene's own progress
 * (for Ken Burns, which must keep creeping through the band rather than restarting at its edge).
 *
 * Everything is composited into a single canvas rather than stacking DOM layers with opacity.
 * Two reasons: compositing two bitmaps into one 2D context gives frame-accurate control over the
 * blend (a mask wipe with a genuinely hard edge is not expressible as CSS opacity), and seven
 * full-screen layers would each be promoted to their own compositor layer, which on a phone is
 * the difference between one texture upload per frame and seven.
 */

import { coverRect, kenBurnsScale } from './cover-fit.js';
import { easeTravel, easeBlend, easeScale, smoothstep, mix } from './easing.js';

/** Draws one bitmap cover-fitted, optionally with extra scale and alpha. */
function drawScene(ctx, bitmap, dw, dh, { scale = 1, alpha = 1, clip = null } = {}) {
  if (!bitmap) return;
  ctx.save();
  if (clip) {
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
  }
  ctx.globalAlpha = alpha;
  const r = coverRect(bitmap.width, bitmap.height, dw, dh, scale);
  ctx.drawImage(bitmap, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
  ctx.restore();
}

/**
 * 01 -> 02. Cross-dissolve, incoming scaling 1.08 down to 1.00.
 *
 * The scale is on the INCOMING only. A scale on both reads as a zoom of the whole frame; on the
 * incoming alone it reads as the new image settling into place, which is what gives a plain
 * dissolve somewhere to arrive.
 */
function crossDissolveScaleIn(ctx, a, b, t, dw, dh) {
  const e = easeBlend(t);
  drawScene(ctx, a.bitmap, dw, dh, { scale: kenBurnsScale(a.progress) });
  drawScene(ctx, b.bitmap, dw, dh, {
    alpha: e,
    scale: kenBurnsScale(b.progress) * mix(1.08, 1.0, easeScale(t)),
  });
}

/**
 * 02 -> 03. Vertical mask wipe from the bottom. Hard edge, no feather.
 *
 * The incoming scene is revealed by an advancing rectangle rather than by opacity, so the edge is
 * a genuine boundary between two images. Deliberately unfeathered: a soft edge would read as a
 * gradient wipe, which is a different and much more common effect.
 */
function maskWipeUp(ctx, a, b, t, dw, dh) {
  const e = easeTravel(t);
  drawScene(ctx, a.bitmap, dw, dh, { scale: kenBurnsScale(a.progress) });
  const revealed = Math.round(dh * e);
  if (revealed > 0) {
    drawScene(ctx, b.bitmap, dw, dh, {
      scale: kenBurnsScale(b.progress),
      clip: { x: 0, y: dh - revealed, w: dw, h: revealed },
    });
  }
}

/**
 * 03 -> 04. Fast dissolve.
 *
 * Identical maths to a plain cross-dissolve — the "half duration" is expressed in the scroll
 * model, where this band is 0.175 of a scene rather than 0.35, not by running a different curve.
 * Duration belongs to the model so the arithmetic stays inspectable.
 */
function fastDissolve(ctx, a, b, t, dw, dh) {
  drawScene(ctx, a.bitmap, dw, dh, { scale: kenBurnsScale(a.progress) });
  drawScene(ctx, b.bitmap, dw, dh, { alpha: easeBlend(t), scale: kenBurnsScale(b.progress) });
}

/**
 * 04 -> 05. Horizontal split, outgoing parting from the centre.
 *
 * The incoming scene is drawn whole underneath; the outgoing is drawn as two halves that slide
 * apart. No fade on the halves — they leave as solid objects, which is what makes this read as a
 * physical parting rather than as another dissolve.
 */
function splitHorizontal(ctx, a, b, t, dw, dh) {
  const e = easeTravel(t);
  drawScene(ctx, b.bitmap, dw, dh, { scale: kenBurnsScale(b.progress) });

  if (!a.bitmap) return;
  const offset = e * (dw / 2);
  const half = dw / 2;
  const r = coverRect(a.bitmap.width, a.bitmap.height, dw, dh, kenBurnsScale(a.progress));

  // Left half, travelling left.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, Math.max(0, half - offset), dh);
  ctx.clip();
  ctx.drawImage(a.bitmap, r.sx, r.sy, r.sw, r.sh, r.dx - offset, r.dy, r.dw, r.dh);
  ctx.restore();

  // Right half, travelling right.
  ctx.save();
  ctx.beginPath();
  ctx.rect(Math.min(dw, half + offset), 0, dw, dh);
  ctx.clip();
  ctx.drawImage(a.bitmap, r.sx, r.sy, r.sw, r.sh, r.dx + offset, r.dy, r.dw, r.dh);
  ctx.restore();
}

/**
 * 05 -> 06. Cross-dissolve with a brief scale punch on the incoming.
 *
 * The punch is front-loaded: incoming enters at 1.12 and is essentially at rest by a third of the
 * way through, while the dissolve continues for the rest of the band. Spreading the scale across
 * the whole band instead would read as a slow zoom, not a punch.
 */
function crossDissolvePunch(ctx, a, b, t, dw, dh) {
  const e = easeBlend(t);
  const punch = easeScale(Math.min(1, t / 0.33));
  drawScene(ctx, a.bitmap, dw, dh, { scale: kenBurnsScale(a.progress) });
  drawScene(ctx, b.bitmap, dw, dh, {
    alpha: e,
    scale: kenBurnsScale(b.progress) * mix(1.12, 1.0, punch),
  });
}

/**
 * 06 -> 07. Long slow dissolve, the slowest in the sequence.
 *
 * Length again comes from the model (0.45 band). What differs here is the curve: expo-out would
 * complete the visible blend in the first fifth and leave a long tail of nothing happening, which
 * on the longest band reads as a stall. A near-linear ramp with only a gentle settle keeps the
 * dissolve perceptibly moving for the whole 689px.
 */
function longDissolve(ctx, a, b, t, dw, dh) {
  const gentle = smoothstep(t); // symmetric, no long flat tail
  drawScene(ctx, a.bitmap, dw, dh, { scale: kenBurnsScale(a.progress) });
  drawScene(ctx, b.bitmap, dw, dh, { alpha: gentle, scale: kenBurnsScale(b.progress) });
}

export const TRANSITION_FNS = {
  'cross-dissolve-scale-in': crossDissolveScaleIn,
  'mask-wipe-up': maskWipeUp,
  'fast-dissolve': fastDissolve,
  'split-horizontal': splitHorizontal,
  'cross-dissolve-punch': crossDissolvePunch,
  'long-dissolve': longDissolve,
};

export { drawScene };
