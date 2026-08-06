import sharp from 'sharp';

/**
 * Per-image statistics, and the maths behind the grade.
 *
 * Everything here works on 8-bit sRGB (gamma-encoded) values rather than linear light. That is
 * deliberate: "black point" and "levels" are photographic operations defined in the space the
 * image is stored and displayed in. Doing them in linear light is more physically correct and
 * produces a different, muddier look — not the one anybody grading a photograph expects.
 */

/** Analysis is run on a downscale: percentiles and means are statistical, so full resolution
 *  buys nothing and costs ~10x the time across seven 4.2 MP images. */
const ANALYSIS_WIDTH = 800;

export async function samplePixels(file) {
  const { data, info } = await sharp(file)
    .resize({ width: ANALYSIS_WIDTH, fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, pixels: info.width * info.height };
}

/** Rec. 709 luma. Matches how the eye weights the channels, so a "black point" measured this
 *  way corresponds to perceived darkness rather than to whichever channel happens to be lowest. */
export function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Widest channel spread a pixel may have and still count as "should be neutral".
 *
 * This is what separates a colour cast from an intended accent. A cast is a weak tint spread
 * across everything; an accent is a strong colour in one region. Measuring cast over the whole
 * frame cannot tell them apart — on `05-turn` the large amber panel read as a global warm cast,
 * and correcting it pushed the grey stone teal. Averaging only over pixels that are already close
 * to grey excludes the accent from both the measurement and the target, so the cast is corrected
 * and the amber is left exactly where the artist put it.
 */
const NEUTRAL_SPREAD = 32;

/** Below this, hue is mostly sensor/compression noise and would poison the neutral average. */
const NEUTRAL_FLOOR = 12;

export function analyse({ data, pixels }) {
  const hist = new Uint32Array(256);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  // Second accumulator, over near-neutral pixels only — this is what drives cast correction.
  let nR = 0;
  let nG = 0;
  let nB = 0;
  let nCount = 0;

  for (let i = 0; i < data.length; i += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sumR += r;
    sumG += g;
    sumB += b;
    hist[Math.round(luma(r, g, b))]++;

    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    if (max - min <= NEUTRAL_SPREAD && max >= NEUTRAL_FLOOR) {
      nR += r;
      nG += g;
      nB += b;
      nCount++;
    }
  }

  const meanR = sumR / pixels;
  const meanG = sumG / pixels;
  const meanB = sumB / pixels;

  // If an image is almost entirely saturated there is no neutral reference to measure against;
  // fall back to the global mean rather than correcting from a handful of pixels.
  const enough = nCount > pixels * 0.02;

  return {
    neutralR: enough ? nR / nCount : meanR,
    neutralG: enough ? nG / nCount : meanG,
    neutralB: enough ? nB / nCount : meanB,
    neutralShare: nCount / pixels,
    neutralUsable: enough,
    // 0.5 / 99.5 rather than absolute min/max: a single hot pixel or one crushed dust speck
    // would otherwise define the whole image's range.
    blackPoint: percentile(hist, pixels, 0.005),
    whitePoint: percentile(hist, pixels, 0.995),
    meanLuma: luma(meanR, meanG, meanB),
    meanR,
    meanG,
    meanB,
    // Whole-frame CCT. Includes the amber accent, so it is a description of the image, not a
    // measure of the grade — two scenes with different amounts of amber SHOULD differ here.
    cct: correlatedColourTemperature(meanR, meanG, meanB),
    // CCT of the near-neutral pixels only. This is the number the cast correction targets, so
    // this is the one that has to converge.
    neutralCct: enough
      ? correlatedColourTemperature(nR / nCount, nG / nCount, nB / nCount)
      : correlatedColourTemperature(meanR, meanG, meanB),
  };
}

function percentile(hist, total, q) {
  const target = total * q;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= target) return v;
  }
  return 255;
}

/**
 * Correlated colour temperature of the average pixel, via McCamy's approximation.
 *
 * sRGB -> linear -> CIE XYZ -> xy chromaticity -> CCT. Reported because "this one is cooler than
 * that one" is far easier to act on as a Kelvin number than as three channel means.
 */
export function correlatedColourTemperature(r8, g8, b8) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(r8);
  const g = lin(g8);
  const b = lin(b8);

  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;

  const sum = X + Y + Z;
  if (sum <= 0) return 0;

  const x = X / sum;
  const y = Y / sum;
  const n = (x - 0.332) / (0.1858 - y);
  return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
}

/**
 * Builds the 256-entry per-channel lookup table that performs the whole grade in one pass.
 *
 * Three operations composed into one table, applied in this order:
 *
 *   1. Cast correction. Each image's channel *ratios* are nudged to the cohort's average ratios.
 *      Note this corrects chromaticity, not level — an image that is genuinely darker stays
 *      darker. Correcting toward the cohort average rather than to neutral grey is what keeps the
 *      intended amber: warmth common to all seven is the target, so it survives, while one image
 *      being greener than the rest does not.
 *
 *   2. Levels. Maps this image's measured black and white points onto shared targets, so the void
 *      is the same black everywhere and highlights peak together.
 *
 *   3. S-curve. A gentle blend toward smoothstep. Endpoints are fixed at 0 and 1, so it adds
 *      midtone contrast without clipping anything the levels step just placed.
 */
export function buildLut({ gains, blackPoint, whitePoint, targetBlack, targetWhite, sCurve }) {
  const luts = [];
  const span = Math.max(1, whitePoint - blackPoint);

  for (let c = 0; c < 3; c++) {
    const lut = Buffer.alloc(256);
    for (let v = 0; v < 256; v++) {
      let x = v * gains[c];

      // Levels, in 0..1.
      x = (x - blackPoint) / span;
      x = Math.min(1, Math.max(0, x));

      // Gentle S. smoothstep alone is too strong; blending keeps the shoulders soft.
      const s = x * x * (3 - 2 * x);
      x = x * (1 - sCurve) + s * sCurve;

      // Re-place onto the shared output range.
      x = targetBlack + x * (targetWhite - targetBlack);

      lut[v] = Math.round(Math.min(255, Math.max(0, x)));
    }
    luts.push(lut);
  }
  return luts;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const SCENES = [
  '01-void',
  '02-emergence',
  '03-reveal',
  '04-surface',
  '05-turn',
  '06-fracture',
  '07-return',
];
