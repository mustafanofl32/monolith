import sharp from 'sharp';

/**
 * Detects and removes baked-in letterbox/pillarbox mattes.
 *
 * This is not a hypothetical. `01-void` ships as a 2.35:1 CinemaScope frame matted into the same
 * 2752x1536 container as the others: 183 black rows on top, 181 on the bottom, with a hard edge
 * (row 181 reads 0.33, row 183 reads 8.95 — a 27x jump in two rows, which is a matte, not a
 * vignette). The other six are native full-frame.
 *
 * It has to be removed before anything else touches the pixels, for two separate reasons:
 *
 *   1. Rendering. Cover-fitting a matted frame alongside six unmatted ones puts black bars on the
 *      hero and then pops them away at the first transition.
 *
 *   2. Grading. The matte is 364 rows of pure black, which is where `01-void`'s measured black
 *      point of 0 came from. The grade was being computed against the container, not the image.
 *
 * Detection is on row/column mean luma against a threshold set above JPEG's noise around black
 * (a true matte row measures ~0.3, real content starts near 9) and requires a hard edge, so a
 * genuinely dark composition is never mistaken for a matte.
 */

/** Above JPEG ringing around black, far below any real content. */
const MATTE_THRESHOLD = 3.0;

/** A matte ends abruptly. If the step up is softer than this it is a vignette — leave it alone. */
const MIN_EDGE_JUMP = 4.0;

/** Refuse to crop away more than this much of an axis; that would mean the detector is wrong. */
const MAX_MATTE_FRACTION = 0.3;

function meanLuma(data, width, stride, offset, count) {
  let sum = 0;
  for (let k = 0; k < count; k++) {
    const i = offset + k * stride;
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return sum / count;
}

/**
 * @returns {{left:number,top:number,width:number,height:number,cropped:boolean}} an
 *   `extract`-shaped region covering only real content.
 */
export async function detectMatte(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;

  const rows = new Float64Array(H);
  for (let y = 0; y < H; y++) rows[y] = meanLuma(data, W, 3, y * W * 3, W);
  const cols = new Float64Array(W);
  for (let x = 0; x < W; x++) cols[x] = meanLuma(data, W, W * 3, x * 3, H);

  const scan = (profile, limit) => {
    let lead = 0;
    while (lead < limit && profile[lead] < MATTE_THRESHOLD) lead++;
    let trail = 0;
    while (trail < limit && profile[profile.length - 1 - trail] < MATTE_THRESHOLD) trail++;
    // Only believe it if the transition is a step, not a ramp.
    const hardLead = lead > 0 && profile[lead] - profile[lead - 1] >= MIN_EDGE_JUMP;
    const hardTrail =
      trail > 0 && profile[profile.length - 1 - trail] - profile[profile.length - trail] >= MIN_EDGE_JUMP;
    return [hardLead ? lead : 0, hardTrail ? trail : 0];
  };

  const [top, bottom] = scan(rows, Math.floor(H * MAX_MATTE_FRACTION));
  const [left, right] = scan(cols, Math.floor(W * MAX_MATTE_FRACTION));

  return {
    left,
    top,
    width: W - left - right,
    height: H - top - bottom,
    cropped: top + bottom + left + right > 0,
    matte: { top, bottom, left, right },
    container: { width: W, height: H },
  };
}

/** Applies the detected region. Returns 8-bit RGB plus the true intrinsic size. */
export async function loadContent(file, region, resizeWidth = null) {
  let pipe = sharp(file).removeAlpha();
  if (region.cropped) {
    pipe = pipe.extract({
      left: region.left,
      top: region.top,
      width: region.width,
      height: region.height,
    });
  }
  if (resizeWidth) {
    pipe = pipe.resize({ width: resizeWidth, fit: 'inside', kernel: 'lanczos3' });
  }
  const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
