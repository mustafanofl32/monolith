/**
 * Contract tests between the asset pipeline and the runtime.
 *
 * These run against real build output, so they need `npm run assets` first. In CI that is the step
 * immediately before, which is the point: the pipeline is deterministic, so if a variant's bytes
 * drift the encode settings changed and someone should know.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'public', 'scenes');
const manifestPath = join(dir, 'manifest.json');

if (!existsSync(manifestPath)) {
  throw new Error(`${manifestPath} is missing — run \`npm run assets\` before the tests.`);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

test('the manifest describes seven ordered scenes', () => {
  assert.equal(manifest.scenes.length, 7);
  manifest.scenes.forEach((scene, i) => {
    assert.equal(scene.order, i, scene.id);
    assert.match(scene.id, /^0[1-7]-[a-z]+$/, scene.id);
  });
});

test('every variant the manifest promises exists at the size it claims', () => {
  for (const scene of manifest.scenes) {
    for (const format of scene.formats) {
      assert.ok(scene.variants[format], `${scene.id} lists ${format} but has no variants`);
      for (const width of scene.widths) {
        const variant = scene.variants[format][String(width)];
        assert.ok(variant, `${scene.id} ${format} ${width} missing`);
        const path = join(dir, variant.file);
        assert.ok(existsSync(path), `${variant.file} not on disk`);
        // Byte-exact: the dither seed is fixed and the encoder settings are fixed, so a change
        // here is a real change to the output and not build noise.
        assert.equal(statSync(path).size, variant.bytes, `${variant.file} size drifted`);
      }
    }
  }
});

test('no variant is wider than the graded source — nothing is upscaled', () => {
  for (const scene of manifest.scenes) {
    for (const width of scene.widths) {
      assert.ok(width <= scene.intrinsic.width, `${scene.id} offers ${width} from ${scene.intrinsic.width}`);
    }
  }
});

test('the two darkest scenes ship WebP first and omit AVIF entirely', () => {
  // AVIF's rate-distortion pass discards the dither that keeps these gradients smooth. This is the
  // finding the README documents; the assertion stops a future "AVIF everywhere" tidy-up.
  for (const id of ['01-void', '07-return']) {
    const scene = manifest.scenes.find((s) => s.id === id);
    assert.equal(scene.formats[0], 'webp', id);
    assert.ok(!scene.formats.includes('avif'), `${id} should not offer AVIF`);
  }
  for (const id of ['02-emergence', '03-reveal', '04-surface', '05-turn', '06-fracture']) {
    assert.equal(manifest.scenes.find((s) => s.id === id).formats[0], 'avif', id);
  }
});

test('every scene ends in a format that needs no feature detection', () => {
  for (const scene of manifest.scenes) {
    assert.equal(scene.formats.at(-1), 'jpeg', `${scene.id} has no universal fallback`);
  }
});

test('average colour is a usable hex, so first paint is never white', () => {
  for (const scene of manifest.scenes) {
    assert.match(scene.averageColour, /^#[0-9a-f]{6}$/, scene.id);
  }
});

test('the manifest carries no timestamp — it must be byte-reproducible', () => {
  const raw = readFileSync(manifestPath, 'utf8');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(raw), 'an ISO timestamp would churn every CI build');
});

test('no scene filename is hardcoded anywhere outside the manifest', () => {
  // Brief rule 3. The runtime must learn what exists by reading the manifest, so adding or
  // renaming a scene is a pipeline change and not a code change.
  const ids = manifest.scenes.map((s) => s.id);
  const sources = readdirSync(join(root, 'src'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(root, 'src', f))
    .concat([join(root, 'index.html')]);

  for (const path of sources) {
    const text = readFileSync(path, 'utf8');
    // Comments explain decisions by name; only code is constrained.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const id of ids) {
      if (!code.includes(id)) continue;
      // main.js names one scene deliberately: the reduced-motion still has to be a chosen
      // composition, not whichever file happens to sort first.
      const allowed = path.endsWith('main.js') && id === '03-reveal';
      assert.ok(allowed, `${path} hardcodes "${id}"`);
    }
  }
});
