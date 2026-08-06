/**
 * The cubic-bezier solver's fallback path.
 *
 * The comment in easing.js claims the bisection fallback is "load-bearing rather than defensive
 * boilerplate". That is a claim about behaviour, so it gets a test: a curve whose control points
 * put a near-zero slope inside the solved range is exactly where Newton-Raphson stalls or steps
 * outside [0,1], and the result must still be correct there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cubicBezier, EXPO_OUT, TRAVEL_OUT, BLEND_OUT, SCALE_OUT } from '../src/easing.js';

/** Inverts the curve numerically and checks the solver agrees. */
function assertSolves(curve, name) {
  const [x1, y1, x2, y2] = curve;
  const ease = cubicBezier(curve);
  const bezier = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;

  for (let t = 0.01; t < 1; t += 0.01) {
    const x = bezier(t, x1, x2);
    const expectedY = bezier(t, y1, y2);
    assert.ok(
      Math.abs(ease(x) - expectedY) < 1e-3,
      `${name}: ease(${x.toFixed(4)}) = ${ease(x).toFixed(5)}, expected ${expectedY.toFixed(5)}`,
    );
  }
}

test('every shipped curve inverts correctly across its whole range', () => {
  assertSolves(EXPO_OUT, 'expo-out');
  assertSolves(TRAVEL_OUT, 'travel-out');
  assertSolves(BLEND_OUT, 'blend-out');
  assertSolves(SCALE_OUT, 'scale-out');
});

test('the solver survives a degenerate curve that stalls Newton outright', () => {
  // A flat plateau: x barely moves through the middle, so the slope Newton divides by approaches
  // zero and it either stops early or steps outside [0,1]. Bisection is what rescues this.
  const flat = cubicBezier([0.99, 0, 0.01, 1]);
  let previous = -1;
  for (let p = 0; p <= 1.0001; p += 0.005) {
    const v = flat(p);
    assert.ok(Number.isFinite(v), `non-finite at ${p.toFixed(3)}`);
    assert.ok(v >= -1e-6 && v <= 1 + 1e-6, `out of range at ${p.toFixed(3)}: ${v}`);
    assert.ok(v >= previous - 1e-6, `not monotonic at ${p.toFixed(3)}`);
    previous = v;
  }
  assert.ok(Math.abs(flat(0)) < 1e-6);
  assert.ok(Math.abs(flat(1) - 1) < 1e-6);
});

test('a linear curve short-circuits instead of being solved', () => {
  const linear = cubicBezier([0.5, 0.5, 0.9, 0.9]);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) assert.equal(linear(t), t);
});

test('out-of-range input is clamped, not extrapolated', () => {
  const ease = cubicBezier(TRAVEL_OUT);
  assert.equal(ease(-3), 0);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.equal(ease(4), 1);
});
