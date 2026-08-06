/**
 * Easing.
 *
 * Every animated value in this project runs through a curve chosen deliberately. Linear reads as
 * mechanical because nothing physical moves at constant velocity; bounce reads as toy-like.
 *
 * The house curve is cubic-bezier(0.16, 1, 0.30, 1) — "expo out".
 *
 * Why those control points specifically:
 *
 *   P1 = (0.16, 1)  The first handle is pulled almost fully vertical: by 16% of the way through
 *                   the duration the curve has already reached the top of its range. The motion
 *                   commits immediately rather than easing in, so a transition begins the instant
 *                   the user crosses the band edge and never feels like it lagged the scroll.
 *
 *   P2 = (0.30, 1)  The second handle is pinned at y=1 and pulled left, which flattens the entire
 *                   tail. The last 70% of the duration covers almost no distance — it is a long,
 *                   decelerating settle.
 *
 * That shape is what "considered" reads as: arrival is fast, settling is slow. A symmetric ease
 * (0.42, 0, 0.58, 1) spends as long arriving as departing and feels sluggish at both ends.
 *
 * The curve is applied to the BLEND, not to scroll position. Scroll stays 1:1 with the user's
 * input — the page never scrolls at a speed the user did not ask for.
 */

export const EXPO_OUT = [0.16, 1, 0.3, 1];

/**
 * WHY EXPO_OUT IS NOT USED FOR THE TRANSITIONS THEMSELVES.
 *
 * Expo-out is the correct instinct for a TIME-driven animation: it commits instantly and settles
 * slowly, and the user waits out the tail without noticing it. Scroll-driven is a different
 * problem, because the user *is* the clock. They scrub linearly through the band, so the curve
 * maps directly onto distance travelled — and expo-out reaches **0.972 at t=0.5**.
 *
 * Measured consequence, caught by screenshotting band midpoints: at the arithmetic centre of the
 * 02->03 band there was no visible wipe edge, and at the centre of 04->05 the split had all but
 * closed. Both transitions completed inside the first ~15% of their scroll range and then held
 * still for the remaining 85%. A wipe you cannot watch wipe is a cut.
 *
 * These two curves keep the motion legible across the band while still decelerating hard into the
 * end — tail slope ~0.08 against linear's 1.00.
 */

/** Wipes and splits: something physically travels, so it must stay readable. 0.556 at t=0.5. */
export const TRAVEL_OUT = [0.62, 0.04, 0.34, 1];

/**
 * Dissolves: mildly front-loaded, because alpha is not perceptually linear — a 50% blend already
 * reads as more than half transitioned, so the curve should not also be ahead of itself. 0.657.
 */
export const BLEND_OUT = [0.55, 0.06, 0.3, 1];

/** Scale components, where an abrupt start is visible as a snap on a large image. */
export const SCALE_OUT = [0.22, 1, 0.36, 1];

const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_EPSILON = 1e-7;
// 24 halvings resolves 1/2^24, which is what it takes to actually reach SUBDIVISION_EPSILON.
// At 12 the loop always exhausted its budget before converging.
const SUBDIVISION_MAX = 24;

const A = (a1, a2) => 1 - 3 * a2 + 3 * a1;
const B = (a1, a2) => 3 * a2 - 6 * a1;
const C = (a1) => 3 * a1;

function bezier(t, a1, a2) {
  return ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
}

function slope(t, a1, a2) {
  return 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1);
}

/**
 * Builds an easing function from four control-point coordinates.
 *
 * Solves x(t) = progress for t by Newton-Raphson, falling back to bisection when Newton fails to
 * converge.
 *
 * An earlier version of this comment claimed the fallback was load-bearing for expo-out's flat
 * tail. Measured, that is false: four Newton iterations leave a worst-case residual of 1.3e-11 on
 * expo-out and better on the other three, so bisection never runs for any curve this site ships
 * and costs nothing per frame. It exists for curves with a near-zero slope inside the solved
 * range, where Newton stalls on the min-slope guard — see tests/easing-solver.test.js.
 */
export function cubicBezier([x1, y1, x2, y2]) {
  if (x1 === y1 && x2 === y2) return (t) => t;

  return (progress) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;

    let t = progress;
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      const currentSlope = slope(t, x1, x2);
      if (Math.abs(currentSlope) < NEWTON_MIN_SLOPE) break;
      t -= (bezier(t, x1, x2) - progress) / currentSlope;
    }

    // Fall back on CONVERGENCE, not merely on range. Testing `t < 0 || t > 1` alone misses the
    // failure that actually happens: where the curve is flat, Newton breaks out early on the
    // min-slope guard and leaves a `t` that is wrong but still inside [0,1], so bisection never
    // ran and the returned curve came back non-monotonic. Checking the residual catches both.
    if (t < 0 || t > 1 || Number.isNaN(t) || Math.abs(bezier(t, x1, x2) - progress) > SUBDIVISION_EPSILON) {
      let lo = 0;
      let hi = 1;
      t = progress;
      for (let i = 0; i < SUBDIVISION_MAX; i++) {
        const x = bezier(t, x1, x2);
        if (Math.abs(x - progress) < SUBDIVISION_EPSILON) break;
        if (x < progress) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }

    return bezier(t, y1, y2);
  };
}

export const easeOut = cubicBezier(EXPO_OUT);
export const easeTravel = cubicBezier(TRAVEL_OUT);
export const easeBlend = cubicBezier(BLEND_OUT);
export const easeScale = cubicBezier(SCALE_OUT);

/** Symmetric, no long tail. Used where the motion should read as perfectly even. */
export function smoothstep(t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return k * k * (3 - 2 * k);
}

/** Linear interpolation, clamped. */
export function mix(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return a + (b - a) * k;
}
