/**
 * Cover-fit, Ken Burns, easing, and variant selection. All pure, all assertable without a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { coverRect, kenBurnsScale } from '../src/cover-fit.js';
import { cubicBezier, TRAVEL_OUT, BLEND_OUT, EXPO_OUT, smoothstep, mix } from '../src/easing.js';
import { pickWidth, isRealResize } from '../src/viewport.js';

const SOURCES = [
  [2100, 1172], // 01-void after its crop
  [2560, 1429],
  [1024, 572],
];
const DESTS = [
  [375, 812], // portrait phone
  [768, 1024],
  [1440, 900],
  [2560, 1440],
  [900, 900], // square, the awkward case
];

test('cover-fit never letterboxes and never leaves the source', () => {
  for (const [sw, sh] of SOURCES) {
    for (const [dw, dh] of DESTS) {
      for (const scale of [1, 1.03, 1.06]) {
        const r = coverRect(sw, sh, dw, dh, scale);
        const label = `${sw}x${sh} -> ${dw}x${dh} @${scale}`;
        // The sampled window matches the destination aspect, so drawImage cannot distort.
        assert.ok(Math.abs(r.sw / r.sh - dw / dh) < 1e-9, `aspect ${label}`);
        // And it lies entirely inside the bitmap, so no transparent edge is ever sampled.
        assert.ok(r.sx >= 0 && r.sy >= 0, `origin ${label}`);
        assert.ok(r.sx + r.sw <= sw + 1e-9, `right edge ${label}`);
        assert.ok(r.sy + r.sh <= sh + 1e-9, `bottom edge ${label}`);
        assert.equal(r.dw, dw, `dest w ${label}`);
        assert.equal(r.dh, dh, `dest h ${label}`);
      }
    }
  }
});

test('a portrait viewport crops the sides rather than shrinking the image', () => {
  const r = coverRect(2560, 1429, 375, 812);
  assert.ok(r.sh > 1429 - 1, 'full source height is used');
  assert.ok(r.sw < 800, 'a narrow column is sampled');
});

test('scaling up tightens the source window, it does not push pixels off-canvas', () => {
  const a = coverRect(2560, 1429, 1440, 900, 1);
  const b = coverRect(2560, 1429, 1440, 900, 1.06);
  assert.ok(b.sw < a.sw && b.sh < a.sh);
  assert.ok(Math.abs(b.sw / a.sw - 1 / 1.06) < 1e-9);
});

test('pan clamps at the edge instead of running off it', () => {
  for (const pan of [-4, -1, 0, 1, 4]) {
    const r = coverRect(2560, 1429, 900, 900, 1.06, pan, pan);
    assert.ok(r.sx >= 0 && r.sx + r.sw <= 2560 + 1e-9, `panX ${pan}`);
    assert.ok(r.sy >= 0 && r.sy + r.sh <= 1429 + 1e-9, `panY ${pan}`);
  }
});

test('ken burns is monotonic, bounded, and clamps outside 0..1', () => {
  assert.equal(kenBurnsScale(0), 1);
  assert.ok(Math.abs(kenBurnsScale(1) - 1.06) < 1e-9);
  assert.equal(kenBurnsScale(-2), 1);
  assert.equal(kenBurnsScale(9), kenBurnsScale(1));
  let previous = 0;
  for (let t = 0; t <= 1; t += 0.01) {
    const s = kenBurnsScale(t);
    assert.ok(s >= previous);
    previous = s;
  }
});

test('easing curves are monotonic and pinned at both ends', () => {
  for (const [name, curve] of [['travel', TRAVEL_OUT], ['blend', BLEND_OUT], ['expo', EXPO_OUT]]) {
    const ease = cubicBezier(curve);
    assert.ok(Math.abs(ease(0)) < 1e-4, `${name} at 0`);
    assert.ok(Math.abs(ease(1) - 1) < 1e-4, `${name} at 1`);
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.005) {
      const v = ease(t);
      assert.ok(v >= previous - 1e-6, `${name} monotonic at ${t.toFixed(3)}`);
      previous = v;
    }
  }
});

test('transition curves keep motion in the middle of the band, unlike expo-out', () => {
  // The bug this pins: expo-out reaches 0.972 by the halfway point. Under a scroll-driven clock
  // that puts the entire visible movement in the first ~15% of the band and leaves the rest a
  // static hold — a wipe with no visible edge, a split already fully open.
  assert.ok(cubicBezier(EXPO_OUT)(0.5) > 0.95, 'expo-out really is that front-loaded');
  for (const [name, curve] of [['travel', TRAVEL_OUT], ['blend', BLEND_OUT]]) {
    const half = cubicBezier(curve)(0.5);
    assert.ok(half > 0.4 && half < 0.75, `${name} at t=0.5 is ${half.toFixed(3)}`);
  }
});

test('smoothstep and mix behave', () => {
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
  assert.ok(Math.abs(smoothstep(0.5) - 0.5) < 1e-9);
  assert.equal(mix(10, 20, 0), 10);
  assert.equal(mix(10, 20, 1), 20);
  assert.equal(mix(10, 20, 0.5), 15);
});

test('variant width is capped by CSS width, not by devicePixelRatio alone', () => {
  const scene = { widths: [640, 1024, 1600, 2560] };
  // A 390px phone at DPR 3 demands 1170 physical pixels but must never be handed 2560: three
  // resident bitmaps at that size is 43.9 MB.
  assert.equal(pickWidth(scene, { width: 390, dpr: 3 }), 1600);
  assert.equal(pickWidth(scene, { width: 375, dpr: 2 }), 1024);
  assert.equal(pickWidth(scene, { width: 1440, dpr: 1 }), 1600);
  assert.equal(pickWidth(scene, { width: 1440, dpr: 2 }), 2560);
});

test('a scene missing the largest variant falls back instead of upscaling', () => {
  // 01-void has no 2560 variant: its content is 2100px wide after cropping, and a 2560 variant
  // would be invented pixels.
  const cropped = { widths: [640, 1024, 1600] };
  assert.equal(pickWidth(cropped, { width: 2560, dpr: 2 }), 1600);
});

test('URL-bar collapse is not a resize but an orientation change is', () => {
  const portrait = { width: 390, height: 844, dpr: 2 };
  assert.equal(isRealResize(portrait, { ...portrait, height: 750 }), false, '94px of chrome');
  assert.equal(isRealResize(portrait, { width: 844, height: 390, dpr: 2 }), true, 'rotation');
  assert.equal(isRealResize(null, portrait), true, 'first measurement');
});
