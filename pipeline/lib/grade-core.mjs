/**
 * The grade itself, and the quantization that follows it.
 *
 * Kept separate from the scripts because both `grade.mjs` (inspectable output) and `encode.mjs`
 * (shipped output) must apply *identical* maths. If they drifted, the images inspected at the
 * checkpoint would not be the images that ship.
 *
 * ORDER MATTERS, and it is: decode -> resize -> grade in float -> dither -> quantize once.
 *
 * Resizing before grading is deliberate and slightly counter-intuitive. The source is 8-bit, so
 * `01-void`'s dark gradient holds only ~48 distinct levels and the grade stretches them. Resizing
 * first averages neighbouring pixels, which manufactures intermediate values the stretch can then
 * land on — so the same grade bands measurably less. Grading first and resizing after would
 * stretch the gaps and then merely blur them.
 */

/** Rec. 709 luma, matching lib/stats.mjs. */
export function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Builds a float lookup per channel: 8-bit in, 0..1 float out.
 *
 * Cast gain, levels and the S-curve composed into one table. Everything downstream of the 8-bit
 * source is computed at full precision — there is no intermediate rounding.
 */
export function buildFloatLuts({ gains, blackPoint, whitePoint, targetBlack, targetWhite, sCurve }) {
  const span = Math.max(1, whitePoint - blackPoint);
  return [0, 1, 2].map((c) => {
    const lut = new Float32Array(256);
    for (let v = 0; v < 256; v++) {
      let x = (v * gains[c] - blackPoint) / span;
      x = Math.min(1, Math.max(0, x));
      const s = x * x * (3 - 2 * x);
      x = x * (1 - sCurve) + s * sCurve;
      lut[v] = Math.min(1, Math.max(0, (targetBlack + x * (targetWhite - targetBlack)) / 255));
    }
    return lut;
  });
}

/** Applies the grade to an 8-bit RGB buffer, returning float 0..1. */
export function gradeToFloat(rgb8, luts) {
  const out = new Float32Array(rgb8.length);
  for (let i = 0; i < rgb8.length; i += 3) {
    out[i] = luts[0][rgb8[i]];
    out[i + 1] = luts[1][rgb8[i + 1]];
    out[i + 2] = luts[2][rgb8[i + 2]];
  }
  return out;
}

/**
 * Deterministic PRNG (mulberry32).
 *
 * Dither must be random in distribution but identical between runs: a non-deterministic dither
 * changes every encoded byte on every rebuild, which turns a no-op rebuild into a full re-upload
 * and makes it impossible to tell a real asset change from noise in a diff.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Quantizes float 0..1 to 8-bit with triangular-PDF dither at half a level.
 *
 * This is the primary defence against banding in the dark gradients, not a secondary one — 10-bit
 * AVIF is unavailable in this toolchain (sharp's prebuilt libvips rejects any bitdepth but 8, and
 * no avifenc/magick/ffmpeg exists on this machine), so every output format lands at 8 bits.
 *
 * Triangular rather than uniform: TPDF dither makes the quantization error independent of the
 * signal, which is what actually removes the *correlated* stepping the eye reads as a band.
 * Uniform dither reduces banding but leaves the error correlated with the signal, so contours
 * remain faintly visible. Amplitude is +/-0.5 LSB — enough to break a step, small enough that it
 * reads as film grain rather than noise.
 *
 * This is baked into the file. It is not the Phase 4 grain overlay, which masks banding
 * perceptually at runtime but cannot remove banding already encoded into the bytes.
 */
export function ditherToU8(floatRgb, seed = 0x5eed) {
  const rand = mulberry32(seed);
  const out = Buffer.allocUnsafe(floatRgb.length);
  for (let i = 0; i < floatRgb.length; i++) {
    const tpdf = (rand() - rand()) * 0.5;
    const v = Math.round(floatRgb[i] * 255 + tpdf);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/** Average colour of a graded float buffer, as #rrggbb. Used for the manifest's paint-first colour. */
export function averageHex(floatRgb) {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = floatRgb.length / 3;
  for (let i = 0; i < floatRgb.length; i += 3) {
    r += floatRgb[i];
    g += floatRgb[i + 1];
    b += floatRgb[i + 2];
  }
  const hex = (v) =>
    Math.round(Math.min(1, Math.max(0, v / n)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
