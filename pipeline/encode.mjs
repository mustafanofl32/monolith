/**
 * Phase 2 — encode the graded scenes into responsive variants and write the manifest.
 *
 *   node pipeline/encode.mjs
 *
 * Writes public/scenes/*.{avif,webp,jpg} and public/scenes/manifest.json.
 *
 * Nothing here is committed: the pipeline is deterministic (fixed dither seed, fixed encoder
 * settings), so CI reproduces these bytes exactly from the seven sources. That is the whole
 * reason the seed is pinned — a random dither would make every rebuild a full asset diff.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { SCENES } from './lib/stats.mjs';
import { contentRegion, renderAt, encodeBuffer } from './lib/encode-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'scenes');
const OUT = join(ROOT, 'public', 'scenes');

const WIDTHS = [640, 1024, 1600, 2560];
const DITHER_SEED = 0x5eed;

/**
 * Scenes that ship WebP as primary, with AVIF omitted entirely.
 *
 * Measured, not assumed. These two are near-black frames whose gradients depend on the dither
 * added in grading, and AVIF's rate-distortion machinery discards exactly that high-frequency
 * content. AVIF only matches WebP's appearance here at q90/effort9 = 150 kB at 1600w, which is
 * 25% over the first-paint budget; WebP reaches it at 119.5 kB. Serving AVIF preferentially
 * would mean the "best" format delivering the worst image. See README.
 */
const WEBP_PRIMARY = new Set(['01-void', '07-return']);

/** Quality per format, split by whether the scene depends on dither survival. */
const QUALITY = {
  dark: {
    webp: { quality: 95, chroma: '4:4:4' },
    jpeg: { quality: 88, chroma: '4:4:4' },
  },
  normal: {
    avif: { quality: 62, chroma: '4:2:0' },
    webp: { quality: 80, chroma: '4:2:0' },
    jpeg: { quality: 82, chroma: '4:2:0' },
  },
};

const EXT = { avif: 'avif', webp: 'webp', jpeg: 'jpg' };

function fmtKb(bytes) {
  return (bytes / 1024).toFixed(1).padStart(8);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const report = JSON.parse(await readFile(join(SRC, 'graded', 'grade-report.json'), 'utf8'));
  const scenes = [];
  const rows = [];

  for (let order = 0; order < SCENES.length; order++) {
    const id = SCENES[order];
    const plan = report.plans.find((p) => p.scene === id);
    const file = join(SRC, `${id}.jpeg`);
    const region = await contentRegion(file, id);

    const dark = WEBP_PRIMARY.has(id);
    const profile = dark ? QUALITY.dark : QUALITY.normal;
    // Order is priority order: the renderer takes the first format the browser supports.
    const formats = dark ? ['webp', 'jpeg'] : ['avif', 'webp', 'jpeg'];

    // Never upscale. 01-void's content is 2100px wide after its crop, so it simply has no 2560
    // variant — the manifest carries widths per scene precisely so the renderer can cope.
    const widths = WIDTHS.filter((w) => w <= region.width);

    const variants = {};
    let intrinsic = null;
    let averageColour = null;

    for (const width of widths) {
      const { rgb, width: w, height: h, hex } = await renderAt(
        file,
        region,
        { ...plan, ditherSeed: DITHER_SEED },
        width,
        report.sCurve,
      );
      if (!intrinsic) {
        // Intrinsic is the largest emitted variant's true geometry.
        intrinsic = { width: region.width, height: region.height };
        averageColour = hex;
      }

      for (const format of formats) {
        const cfg = profile[format];
        const buf = await encodeBuffer(rgb, w, h, format, cfg.quality, cfg.chroma);
        const name = `${id}-${String(width).padStart(4, '0')}.${EXT[format]}`;
        await writeFile(join(OUT, name), buf);
        variants[format] ??= {};
        variants[format][width] = { file: name, bytes: buf.length, width: w, height: h };
        rows.push({ id, width, format, bytes: buf.length, quality: cfg.quality, chroma: cfg.chroma });
      }
    }

    scenes.push({
      id,
      order,
      intrinsic: {
        ...intrinsic,
        aspect: Number((intrinsic.width / intrinsic.height).toFixed(6)),
      },
      averageColour,
      formats,
      widths,
      variants,
    });
  }

  const manifest = {
    // No timestamp: this file is regenerated in CI and a clock reading would make every build
    // differ from every other for no reason.
    version: 1,
    basePath: '/scenes',
    scenes,
  };
  await writeFile(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // ---- size table --------------------------------------------------------------------
  console.log('MEASURED SIZES  (kB, from the encoded files on disk)\n');
  const formatsSeen = ['avif', 'webp', 'jpeg'];
  console.log(
    'scene           width      avif      webp      jpeg   primary',
  );
  console.log('─'.repeat(66));
  for (const scene of scenes) {
    for (const width of scene.widths) {
      const cells = formatsSeen.map((f) => {
        const v = scene.variants[f]?.[width];
        return v ? fmtKb(v.bytes) : '       —';
      });
      const flag = width === 1600 && scene.id === '01-void' ? '  <- first paint' : '';
      console.log(
        `${(scene.order === 0 || width === scene.widths[0] ? scene.id : '').padEnd(14)}` +
          `${String(width).padStart(6)}  ${cells.join('  ')}   ${scene.formats[0]}${flag}`,
      );
    }
    console.log('');
  }

  const total = (f) => rows.filter((r) => r.format === f).reduce((a, r) => a + r.bytes, 0);
  const grand = rows.reduce((a, r) => a + r.bytes, 0);
  console.log('─'.repeat(66));
  console.log(
    `files ${rows.length}   avif ${(total('avif') / 1048576).toFixed(2)} MB   ` +
      `webp ${(total('webp') / 1048576).toFixed(2)} MB   jpeg ${(total('jpeg') / 1048576).toFixed(2)} MB   ` +
      `total ${(grand / 1048576).toFixed(2)} MB`,
  );

  // ---- budget gate -------------------------------------------------------------------
  const hero = scenes[0];
  const heroPrimary = hero.variants[hero.formats[0]][1600];
  const budget = 120 * 1024;
  console.log('');
  console.log(
    `BUDGET  ${hero.id} @1600w ${hero.formats[0]}: ${(heroPrimary.bytes / 1024).toFixed(1)} kB / 120.0 kB  ` +
      `${heroPrimary.bytes <= budget ? 'PASS' : 'FAIL'}  (${((heroPrimary.bytes / budget) * 100).toFixed(1)}% of budget)`,
  );
  if (heroPrimary.bytes > budget) process.exitCode = 1;
}

await main();
