/**
 * Fails the build if the shipped payload grows past what the README claims.
 *
 * A performance number in a README rots the moment nobody checks it. These are the two figures the
 * README states as budgets, so they are asserted on every build rather than measured once.
 *
 *   node pipeline/check-budget.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'dist', 'assets');

/** Brief's budget for initial JS. */
const JS_GZIP_LIMIT = 40 * 1024;
/** 01-void at 1600w is the largest single asset in the first-paint path. */
const HERO_LIMIT = 120 * 1024;

let failed = false;
const report = (label, value, limit, unit = 'kB') => {
  const ok = value <= limit;
  if (!ok) failed = true;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(38)}` +
      `${(value / 1024).toFixed(1)} ${unit}  (limit ${(limit / 1024).toFixed(0)} ${unit})`,
  );
};

const files = await readdir(ASSETS);

let jsGzip = 0;
for (const file of files.filter((f) => f.endsWith('.js'))) {
  jsGzip += gzipSync(await readFile(join(ASSETS, file))).length;
}
report('initial JS, gzipped', jsGzip, JS_GZIP_LIMIT);

const manifest = JSON.parse(await readFile(join(ROOT, 'public', 'scenes', 'manifest.json'), 'utf8'));
const hero = manifest.scenes[0];
const heroFormat = hero.formats[0];
const heroWidth = Math.max(...hero.widths);
const heroFile = hero.variants[heroFormat][String(heroWidth)].file;
const heroBytes = (await stat(join(ROOT, 'public', 'scenes', heroFile))).size;
report(`hero ${heroFile}`, heroBytes, HERO_LIMIT);

if (failed) {
  console.error('\nPayload budget exceeded — the README states these limits.');
  process.exit(1);
}
console.log('\nWithin budget.');
