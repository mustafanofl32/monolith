/**
 * Film grain.
 *
 * Two jobs, both structural rather than decorative. It unifies seven separately generated images
 * into one visual world — shared grain reads as one film stock — and it perceptually masks the
 * residual banding that the lossy encoders reintroduced into the dark gradients after grading.
 *
 * That second job is a mask, not a fix. The dither baked into the encode is what actually removes
 * banding from the file; this only helps the eye integrate what survived. Relying on it instead of
 * the dither would be treating the symptom.
 *
 * Generated ONCE into an offscreen tile and reused. Regenerating noise per frame would cost a
 * full-canvas random fill every frame — at 2560x1429 that is 3.6M pixels of Math.random per frame,
 * which would dominate the frame budget the renderer is measured against.
 */

/** Tile size. Large enough that repetition is invisible, small enough to build instantly. */
const TILE = 256;

/** How many pre-rolled tiles to cycle through. One tile with a moving offset reads as a sliding
 *  texture rather than as grain; a few tiles cycling reads as film. */
const VARIANTS = 3;

export function createGrain({ opacity = 0.035 } = {}) {
  const tiles = [];

  for (let v = 0; v < VARIANTS; v++) {
    const c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    const g = c.getContext('2d');
    const img = g.createImageData(TILE, TILE);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // Monochrome noise. Coloured noise would tint the neutrals we spent Phase 1 aligning.
      const n = (Math.random() * 255) | 0;
      d[i] = n;
      d[i + 1] = n;
      d[i + 2] = n;
      d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    tiles.push(c);
  }

  let frame = 0;

  return {
    /** Draws grain over the whole canvas. Call after the scene composite. */
    draw(ctx, w, h) {
      const tile = tiles[frame % VARIANTS];
      frame++;

      ctx.save();
      ctx.globalAlpha = opacity;
      // 'overlay' keeps grain out of the deepest blacks, where visible noise would read as
      // sensor dirt rather than film, while still breaking up the midtone gradients.
      ctx.globalCompositeOperation = 'overlay';
      const pattern = ctx.createPattern(tile, 'repeat');
      // Sub-tile jitter so the repeat grid never aligns frame to frame.
      const dx = -((frame * 37) % TILE);
      const dy = -((frame * 61) % TILE);
      ctx.translate(dx, dy);
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w + TILE, h + TILE);
      ctx.restore();
    },
  };
}
