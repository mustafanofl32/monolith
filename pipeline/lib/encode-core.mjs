import sharp from 'sharp';
import { detectMatte, loadContent } from './matte.mjs';
import { buildFloatLuts, gradeToFloat, ditherToU8, averageHex } from './grade-core.mjs';

/**
 * Shared encode machinery: crop -> resize -> grade -> dither -> encode.
 *
 * The order is the point. Resizing happens on the ungraded source so that averaging neighbouring
 * pixels manufactures intermediate levels BEFORE the grade stretches them — the same grade bands
 * measurably less this way than if it ran first. The single quantization to 8-bit happens last,
 * with dither, because everything downstream of it is lossy and cannot be undone.
 */

/**
 * Deliberate crop windows, applied after matte removal.
 *
 * 01-void is 2.35:1 content that has to become 1.79:1 to match the other six. Cover-fit would
 * crop it from the centre and throw away the right side of the glow plume; the column-energy scan
 * shows the right half of the frame carries no light at all, so the window is pinned to x=0 and
 * the empty side is what gets discarded.
 */
export const CROPS = {
  '01-void': { anchor: 'left', aspect: 2752 / 1536 },
};

export async function contentRegion(file, scene) {
  const region = await detectMatte(file);
  const crop = CROPS[scene];
  if (!crop) return region;

  const targetW = Math.round(region.height * crop.aspect);
  if (targetW >= region.width) return region;

  const dx = crop.anchor === 'left' ? 0 : crop.anchor === 'right' ? region.width - targetW : Math.round((region.width - targetW) / 2);
  return {
    ...region,
    left: region.left + dx,
    width: targetW,
    cropped: true,
    deliberateCrop: { from: region.width, to: targetW, anchor: crop.anchor },
  };
}

/** Grade a scene at one output width. Returns the dithered 8-bit RGB plus its true size. */
export async function renderAt(file, region, plan, width, sCurve) {
  const { data, width: w, height: h } = await loadContent(file, region, width);
  const luts = buildFloatLuts({ ...plan, sCurve });
  const graded = gradeToFloat(data, luts);
  return { rgb: ditherToU8(graded, plan.ditherSeed), width: w, height: h, hex: averageHex(graded) };
}

/**
 * Chroma subsampling.
 *
 * 4:2:0 halves chroma resolution and is nearly free on most photographic content. On these
 * frames it is not: the amber glow is a low-luma, high-saturation gradient sitting on near-black,
 * which is precisely where halved chroma resolution shows as blocky colour banding. The darkest
 * scenes therefore encode 4:4:4. On near-monochrome dark frames the size cost is small because
 * there is little chroma detail to spend bits on either way.
 */
export function subsamplingFor(meanLuma, force444) {
  return force444 || meanLuma < 20 ? '4:4:4' : '4:2:0';
}

export async function encodeBuffer(rgb, width, height, format, quality, chroma) {
  const img = sharp(rgb, { raw: { width, height, channels: 3 } });
  switch (format) {
    case 'avif':
      return img.avif({ quality, chromaSubsampling: chroma, effort: 6 }).toBuffer();
    case 'webp':
      // near-lossless off; smartSubsample maps to 4:2:0 when enabled, so leave it off for 4:4:4.
      return img.webp({ quality, smartSubsample: chroma === '4:2:0', effort: 6 }).toBuffer();
    case 'jpeg':
      return img.jpeg({ quality, chromaSubsampling: chroma, mozjpeg: true, progressive: true }).toBuffer();
    default:
      throw new Error(`unknown format ${format}`);
  }
}

/**
 * Banding score for the dark region of an encoded image.
 *
 * Judges quality where it actually fails on this material. PSNR over a whole frame is dominated
 * by the bright areas and will happily report "fine" while the shadows contour, so this restricts
 * itself to pixels below `darkCeil` and measures two things:
 *
 *   rmse      — how far the encoder moved the dark pixels at all
 *   flatRuns  — the banding tell. A smooth gradient should change value every few pixels; a
 *               banded one holds a value for a long run and then steps. Long identical runs
 *               scanning horizontally are what the eye reads as a contour.
 */
export async function darkQuality(encodedBuf, referenceRgb, width, height, darkCeil = 64) {
  const { data } = await sharp(encodedBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  let sq = 0;
  let n = 0;

  // Run structure is measured for BOTH images and compared, because the absolute number is
  // meaningless here. A near-black frame is full of genuinely flat black, which produces long
  // runs at any quality — an absolute threshold flags every encode as banded. The question is
  // whether the ENCODER created flatness the dithered source did not have, so what matters is
  // the delta: dither keeps runs short, and an encoder that smooths it away lengthens them.
  const stats = (buf) => {
    let runs = 0;
    let longRuns = 0;
    for (let y = 0; y < height; y++) {
      let runLen = 0;
      let prev = -1;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        const refL =
          0.2126 * referenceRgb[i] + 0.7152 * referenceRgb[i + 1] + 0.0722 * referenceRgb[i + 2];
        if (refL >= darkCeil) {
          if (runLen >= 24) longRuns++;
          prev = -1;
          runLen = 0;
          continue;
        }
        const q = Math.round(
          0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2],
        );
        if (q === prev) {
          runLen++;
        } else {
          if (runLen >= 24) longRuns++;
          runs++;
          runLen = 1;
          prev = q;
        }
      }
      if (runLen >= 24) longRuns++;
    }
    return runs ? longRuns / runs : 0;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const refL = 0.2126 * referenceRgb[i] + 0.7152 * referenceRgb[i + 1] + 0.0722 * referenceRgb[i + 2];
      if (refL >= darkCeil) continue;
      const gotL = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const d = gotL - refL;
      sq += d * d;
      n++;
    }
  }

  const refFlat = stats(referenceRgb);
  const gotFlat = stats(data);

  return {
    rmse: n ? Math.sqrt(sq / n) : 0,
    darkPixels: n,
    refFlatShare: refFlat,
    encFlatShare: gotFlat,
    /** Positive means the encoder smoothed dither into flat runs the source did not have. */
    flatDelta: gotFlat - refFlat,
  };
}
