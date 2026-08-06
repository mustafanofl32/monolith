/**
 * The scroll model. Pure arithmetic, no DOM — so it can be reasoned about and tested directly.
 *
 * Seven scenes, each owning a scroll range. Adjacent ranges overlap in a transition band. Outside
 * a band exactly one scene draws; inside one, two draw and blend by the band's normalised
 * progress.
 *
 * Scene lengths are expressed in viewport heights and resolved to pixels once, from a measured
 * viewport — never from `100dvh`. `dvh` is *defined* to track the collapsing mobile URL bar, so
 * ranges derived from it shift mid-gesture and every scene boundary moves underneath the user.
 * `svh`/`lvh` are the stable pair; the measured value here behaves like `lvh` and is only
 * recomputed on a real resize (see viewport.js).
 */

/** Base scene length, in viewport heights. */
const BASE_LENGTH_VH = 1.4;

/**
 * Scenes 06 and 07 are longer because they flank the slowest transition.
 *
 * At the base length the 0.45 band between them left scene 06 with ~190px of solo time — it would
 * have appeared and begun dissolving almost simultaneously. Lengthening both restores a real hold.
 */
const LENGTH_VH = [1.4, 1.4, 1.4, 1.4, 1.4, 1.7, 1.7];

/**
 * Band length as a ratio of the shorter adjacent scene.
 *
 * Index i is the band between scene i and i+1. 0.35 is the house default; 03->04 is half that
 * because the brief calls for a fast dissolve, and 06->07 is the longest.
 */
const BAND_RATIO = [0.35, 0.35, 0.175, 0.35, 0.35, 0.45];

export const TRANSITIONS = [
  'cross-dissolve-scale-in',
  'mask-wipe-up',
  'fast-dissolve',
  'split-horizontal',
  'cross-dissolve-punch',
  'long-dissolve',
];

/**
 * Resolves the model against a viewport height in CSS pixels.
 *
 * @returns {{scenes:Array,bands:Array,totalScroll:number,documentHeight:number,viewportHeight:number}}
 */
export function buildModel(viewportHeight) {
  const lengths = LENGTH_VH.map((vh) => Math.round(vh * viewportHeight));

  const bands = BAND_RATIO.map((ratio, i) => ({
    index: i,
    from: i,
    to: i + 1,
    transition: TRANSITIONS[i],
    ratio,
    length: Math.round(ratio * Math.min(lengths[i], lengths[i + 1])),
  }));

  const scenes = [];
  let start = 0;
  for (let i = 0; i < lengths.length; i++) {
    scenes.push({ index: i, start, length: lengths[i], end: start + lengths[i] });
    if (i < bands.length) {
      // The next scene begins one band-length before this one ends — that overlap IS the band.
      start = start + lengths[i] - bands[i].length;
    }
  }

  for (const band of bands) {
    band.start = scenes[band.to].start;
    band.end = scenes[band.from].end;
  }

  const totalScroll = scenes[scenes.length - 1].end;

  return {
    viewportHeight,
    scenes,
    bands,
    totalScroll,
    // The stage is sticky, so the document needs one extra viewport for the final scene to be
    // reachable. This makes max scrollY exactly equal totalScroll.
    documentHeight: totalScroll + viewportHeight,
  };
}

/**
 * Where a scroll offset falls.
 *
 * @returns {{band:object|null, progress:number, primary:number, secondary:number|null,
 *            primaryProgress:number, secondaryProgress:number}}
 *   `progress` is the band's normalised 0..1 when inside one. `primaryProgress` /
 *   `secondaryProgress` are each scene's own 0..1 through its whole range, which is what drives
 *   Ken Burns — that has to keep advancing across a band, not restart at its edge.
 */
export function locate(model, scrollY) {
  const y = Math.min(Math.max(scrollY, 0), model.totalScroll);

  for (const band of model.bands) {
    if (y >= band.start && y <= band.end) {
      return {
        band,
        progress: band.end === band.start ? 1 : (y - band.start) / (band.end - band.start),
        primary: band.from,
        secondary: band.to,
        primaryProgress: sceneProgress(model.scenes[band.from], y),
        secondaryProgress: sceneProgress(model.scenes[band.to], y),
      };
    }
  }

  // Outside every band: exactly one scene is live.
  for (const scene of model.scenes) {
    if (y >= scene.start && y <= scene.end) {
      return {
        band: null,
        progress: 0,
        primary: scene.index,
        secondary: null,
        primaryProgress: sceneProgress(scene, y),
        secondaryProgress: 0,
      };
    }
  }

  const last = model.scenes[model.scenes.length - 1];
  return {
    band: null,
    progress: 0,
    primary: last.index,
    secondary: null,
    primaryProgress: 1,
    secondaryProgress: 0,
  };
}

function sceneProgress(scene, y) {
  const t = (y - scene.start) / Math.max(1, scene.length);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Which scenes should be decoded and resident: previous, current, next. */
export function residentSet(model, primary) {
  const set = new Set();
  for (const i of [primary - 1, primary, primary + 1]) {
    if (i >= 0 && i < model.scenes.length) set.add(i);
  }
  return set;
}

/** Formats the model as a table. Used by `npm run model` and by the checkpoint report. */
export function describe(model) {
  const lines = [];
  lines.push(`viewport ${model.viewportHeight}px`);
  lines.push('');
  lines.push('scene   range            length   solo-only span');
  for (const s of model.scenes) {
    const bandBefore = model.bands.find((b) => b.to === s.index);
    const bandAfter = model.bands.find((b) => b.from === s.index);
    const soloStart = bandBefore ? bandBefore.end : s.start;
    const soloEnd = bandAfter ? bandAfter.start : s.end;
    lines.push(
      `${String(s.index + 1).padStart(2, '0')}   ${String(s.start).padStart(6)} – ${String(s.end).padStart(6)}` +
        `   ${String(s.length).padStart(6)}   ${String(soloStart).padStart(6)} – ${String(soloEnd).padStart(6)}` +
        `  (${soloEnd - soloStart})`,
    );
  }
  lines.push('');
  lines.push('band    range            length   ratio   transition');
  for (const b of model.bands) {
    lines.push(
      `${String(b.from + 1).padStart(2, '0')}→${String(b.to + 1).padStart(2, '0')}  ` +
        `${String(b.start).padStart(6)} – ${String(b.end).padStart(6)}   ${String(b.length).padStart(6)}` +
        `   ${b.ratio.toFixed(3)}   ${b.transition}`,
    );
  }
  const bandTotal = model.bands.reduce((a, b) => a + b.length, 0);
  lines.push('');
  lines.push(
    `total scroll ${model.totalScroll}px   document ${model.documentHeight}px   ` +
      `in-band ${bandTotal}px (${((bandTotal / model.totalScroll) * 100).toFixed(1)}%)`,
  );
  return lines.join('\n');
}
