/**
 * The scroll model is pure arithmetic, which is the whole reason it lives in its own module: every
 * property the renderer depends on can be asserted without a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, locate, residentSet, describe as describeModel, TRANSITIONS } from '../src/scroll-model.js';

const VIEWPORTS = [400, 640, 812, 900, 1024, 1440];

test('scenes tile the scroll range with no gap', () => {
  for (const vh of VIEWPORTS) {
    const model = buildModel(vh);
    assert.equal(model.scenes[0].start, 0, `vh ${vh}`);
    for (let i = 1; i < model.scenes.length; i++) {
      // Each scene starts before the previous one ends. The overlap is the band.
      assert.ok(model.scenes[i].start < model.scenes[i - 1].end, `vh ${vh}, scene ${i}`);
    }
    assert.equal(model.totalScroll, model.scenes.at(-1).end, `vh ${vh}`);
  }
});

test('every scroll offset resolves to a live scene', () => {
  const model = buildModel(900);
  for (let y = 0; y <= model.totalScroll; y += 7) {
    const at = locate(model, y);
    assert.ok(at.primary >= 0 && at.primary < 7, `y ${y}`);
    assert.ok(at.primaryProgress >= 0 && at.primaryProgress <= 1, `y ${y}`);
  }
});

test('never three scenes at once — bands do not overlap each other', () => {
  for (const vh of VIEWPORTS) {
    const model = buildModel(vh);
    for (let i = 1; i < model.bands.length; i++) {
      assert.ok(model.bands[i].start > model.bands[i - 1].end, `vh ${vh}, band ${i}`);
    }
  }
});

test('band progress runs 0 to 1 across the band and only there', () => {
  const model = buildModel(900);
  for (const band of model.bands) {
    assert.equal(locate(model, band.start).progress, 0);
    assert.equal(locate(model, band.end).progress, 1);
    assert.equal(locate(model, band.start - 1).band, null);
    assert.equal(locate(model, band.end + 1).band, null);
  }
});

test('scene progress keeps advancing across a band rather than restarting at its edge', () => {
  // Ken Burns is driven by this. If it reset at a band edge the scene would visibly jump scale
  // exactly when a second scene is drawn over it — the most conspicuous possible moment.
  const model = buildModel(900);
  const band = model.bands[2];
  const before = locate(model, band.start - 1).primaryProgress;
  const inside = locate(model, band.start + 1).primaryProgress;
  assert.ok(inside > before);
  assert.ok(inside - before < 0.01, 'progress should be continuous, not stepped');
});

test('scroll offsets outside the range clamp instead of throwing', () => {
  const model = buildModel(900);
  assert.equal(locate(model, -5000).primary, 0);
  assert.equal(locate(model, model.totalScroll + 5000).primary, 6);
});

test('residency is at most three and always contains the current scene', () => {
  const model = buildModel(900);
  for (let i = 0; i < 7; i++) {
    const set = residentSet(model, i);
    assert.ok(set.size <= 3);
    assert.ok(set.has(i));
    for (const index of set) assert.ok(index >= 0 && index < 7);
  }
  assert.equal(residentSet(model, 0).size, 2, 'first scene has no previous');
  assert.equal(residentSet(model, 6).size, 2, 'last scene has no next');
});

test('document height leaves the last scene exactly reachable', () => {
  for (const vh of VIEWPORTS) {
    const model = buildModel(vh);
    assert.equal(model.documentHeight - vh, model.totalScroll, `vh ${vh}`);
  }
});

test('there is one transition per band and each is named', () => {
  const model = buildModel(900);
  assert.equal(model.bands.length, 6);
  assert.equal(TRANSITIONS.length, 6);
  for (const band of model.bands) {
    assert.equal(typeof band.transition, 'string');
    assert.ok(band.length > 0, 'a zero-length band would divide by zero in locate()');
  }
});

test('a NaN or non-finite offset lands on the last scene rather than throwing', () => {
  // The renderer clamps before calling locate(), but a resize mid-frame can briefly produce a
  // model whose totalScroll is smaller than the current position. Falling off the end must be a
  // held final frame, not an exception inside rAF.
  const model = buildModel(900);
  for (const y of [NaN, Infinity, -Infinity]) {
    const at = locate(model, y);
    assert.ok(at.primary >= 0 && at.primary < 7, `y ${y}`);
    assert.equal(at.band, null, `y ${y}`);
  }
});

test('describe() reports every scene, every band, and the in-band share', () => {
  // `npm run model` is how the scroll arithmetic gets checked by hand, so its output is part of
  // the contract rather than a debug print.
  const text = describeModel(buildModel(900));
  for (let i = 1; i <= 7; i++) assert.match(text, new RegExp(`^0${i}\\s`, 'm'), `scene 0${i} missing`);
  for (const name of TRANSITIONS) assert.ok(text.includes(name), `${name} missing`);
  assert.match(text, /total scroll \d+px\s+document \d+px\s+in-band \d+px \(\d+\.\d%\)/);
  assert.ok(text.includes('viewport 900px'));
});

test('scenes 06 and 07 keep real solo time around the slowest transition', () => {
  // The regression this guards: at the base scene length, the 0.45 band between 06 and 07 left
  // scene 06 with ~190px of solo scroll, so it appeared and began dissolving almost at once.
  for (const vh of VIEWPORTS) {
    const model = buildModel(vh);
    for (const index of [5, 6]) {
      const scene = model.scenes[index];
      const before = model.bands.find((b) => b.to === index);
      const after = model.bands.find((b) => b.from === index);
      const solo = (after ? after.start : scene.end) - (before ? before.end : scene.start);
      assert.ok(solo > vh * 0.35, `vh ${vh}, scene ${index} solo ${solo}px`);
    }
  }
});
