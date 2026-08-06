/**
 * Reads MP4 structure directly. No ffmpeg on this machine, and the container carries everything
 * needed: codec, coded resolution, duration, exact sample count, per-sample sizes.
 *
 * Frame count comes from stsz (one sample = one frame for video), which is exact — far better
 * than duration x nominal fps, which rounds.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Optional directory, so v1 and v2 can be probed with the same script. */
const DIR = process.argv[2] ? join(ROOT, process.argv[2]) : join(ROOT, 'src', 'video');

const files = (await readdir(DIR)).filter((f) => /\.(mp4|m4v|mov)$/i.test(f));
if (!files.length) {
  console.error('no video found in src/video');
  process.exit(1);
}
const file = join(DIR, files[0]);
const buf = await readFile(file);
const bytes = (await stat(file)).size;

console.log(`file      ${files[0]}`);
console.log(`size      ${bytes.toLocaleString()} bytes (${(bytes / 1048576).toFixed(2)} MB)`);

/** Walks sibling boxes in [start,end), calling visit(type, payloadStart, payloadEnd). */
function walk(start, end, visit) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    visit(type, p + header, p + size);
    p += size;
  }
}

function findPath(path, start = 0, end = buf.length) {
  let found = null;
  walk(start, end, (type, s, e) => {
    if (found) return;
    if (type === path[0]) {
      if (path.length === 1) found = [s, e];
      else found = findPath(path.slice(1), s, e);
    }
  });
  return found;
}

// ---- ftyp -----------------------------------------------------------------------------
const ftyp = findPath(['ftyp']);
if (ftyp) {
  const major = buf.toString('latin1', ftyp[0], ftyp[0] + 4);
  const brands = [];
  for (let p = ftyp[0] + 8; p + 4 <= ftyp[1]; p += 4) brands.push(buf.toString('latin1', p, p + 4));
  console.log(`brand     ${major}  (compatible: ${brands.join(' ')})`);
}

// ---- mvhd -----------------------------------------------------------------------------
const mvhd = findPath(['moov', 'mvhd']);
let movieDuration = 0;
if (mvhd) {
  const version = buf[mvhd[0]];
  const o = mvhd[0] + 4;
  const timescale = version === 1 ? buf.readUInt32BE(o + 16) : buf.readUInt32BE(o + 8);
  const duration = version === 1 ? Number(buf.readBigUInt64BE(o + 20)) : buf.readUInt32BE(o + 12);
  movieDuration = duration / timescale;
}

// ---- find the video trak --------------------------------------------------------------
let video = null;
walk(...findPath(['moov']), (type, s, e) => {
  if (type !== 'trak') return;
  const hdlr = findPath(['mdia', 'hdlr'], s, e);
  if (!hdlr) return;
  const handler = buf.toString('latin1', hdlr[0] + 8, hdlr[0] + 12);
  if (handler === 'vide') video = [s, e];
});

if (!video) {
  console.error('no video track found');
  process.exit(1);
}

// tkhd -> display dimensions (16.16 fixed)
const tkhd = findPath(['tkhd'], ...video);
let dispW = 0;
let dispH = 0;
if (tkhd) {
  const version = buf[tkhd[0]];
  const end = tkhd[1];
  dispW = buf.readUInt32BE(end - 8) / 65536;
  dispH = buf.readUInt32BE(end - 4) / 65536;
  void version;
}

// mdhd -> media timescale + duration
const mdhd = findPath(['mdia', 'mdhd'], ...video);
let mediaTimescale = 0;
let mediaDuration = 0;
if (mdhd) {
  const version = buf[mdhd[0]];
  const o = mdhd[0] + 4;
  mediaTimescale = version === 1 ? buf.readUInt32BE(o + 16) : buf.readUInt32BE(o + 8);
  mediaDuration = version === 1 ? Number(buf.readBigUInt64BE(o + 20)) : buf.readUInt32BE(o + 12);
}
const durationSec = mediaTimescale ? mediaDuration / mediaTimescale : movieDuration;

// stsd -> codec + coded dimensions
const stsd = findPath(['mdia', 'minf', 'stbl', 'stsd'], ...video);
let codec = '?';
let codedW = 0;
let codedH = 0;
let profileInfo = '';
if (stsd) {
  const entryStart = stsd[0] + 8;
  codec = buf.toString('latin1', entryStart + 4, entryStart + 8);
  codedW = buf.readUInt16BE(entryStart + 32);
  codedH = buf.readUInt16BE(entryStart + 34);
  // avcC sits inside the sample entry; byte 1..3 are profile / compat / level.
  const avcc = buf.indexOf(Buffer.from('avcC', 'latin1'), entryStart);
  if (avcc > 0 && avcc < stsd[1]) {
    const profile = buf[avcc + 5];
    const level = buf[avcc + 7];
    const names = { 66: 'Baseline', 77: 'Main', 100: 'High', 110: 'High10', 122: 'High4:2:2' };
    profileInfo = `  ${names[profile] ?? 'profile ' + profile} @ L${(level / 10).toFixed(1)}`;
  }
}

// stsz -> exact sample (frame) count and sizes
const stsz = findPath(['mdia', 'minf', 'stbl', 'stsz'], ...video);
let frameCount = 0;
let sampleSizes = [];
if (stsz) {
  const uniform = buf.readUInt32BE(stsz[0] + 4);
  frameCount = buf.readUInt32BE(stsz[0] + 8);
  if (uniform === 0) {
    for (let i = 0; i < frameCount; i++) sampleSizes.push(buf.readUInt32BE(stsz[0] + 12 + i * 4));
  } else {
    sampleSizes = new Array(frameCount).fill(uniform);
  }
}

// stts -> frame durations, to detect variable frame rate
const stts = findPath(['mdia', 'minf', 'stbl', 'stts'], ...video);
const deltas = new Map();
if (stts) {
  const count = buf.readUInt32BE(stts[0] + 4);
  for (let i = 0; i < count; i++) {
    const n = buf.readUInt32BE(stts[0] + 8 + i * 8);
    const d = buf.readUInt32BE(stts[0] + 12 + i * 8);
    deltas.set(d, (deltas.get(d) ?? 0) + n);
  }
}

// stss -> sync (key) frames. Absent means every frame is a keyframe.
const stss = findPath(['mdia', 'minf', 'stbl', 'stss'], ...video);
const keyframes = stss ? buf.readUInt32BE(stss[0] + 4) : frameCount;

const videoBytes = sampleSizes.reduce((a, b) => a + b, 0);
const fps = durationSec ? frameCount / durationSec : 0;

console.log(`codec     ${codec}${profileInfo}`);
console.log(`coded     ${codedW} x ${codedH}   (display ${dispW} x ${dispH}, aspect ${(codedW / codedH).toFixed(4)}:1)`);
console.log(`duration  ${durationSec.toFixed(3)} s`);
console.log(`frames    ${frameCount}  ->  ${fps.toFixed(3)} fps`);
console.log(`keyframes ${keyframes}${stss ? '' : '  (no stss box: every frame is a keyframe)'}`);

if (deltas.size === 1) {
  const [d] = [...deltas.keys()];
  console.log(`timing    constant, ${d}/${mediaTimescale} per frame = ${(mediaTimescale / d).toFixed(3)} fps`);
} else {
  console.log(`timing    VARIABLE frame rate — ${deltas.size} distinct durations`);
  for (const [d, n] of [...deltas].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    console.log(`            ${n} frames at ${(mediaTimescale / d).toFixed(2)} fps`);
  }
}

const kbps = (videoBytes * 8) / durationSec / 1000;
console.log(`bitrate   ${kbps.toFixed(0)} kbps video track  (${(bytes * 8 / durationSec / 1000).toFixed(0)} kbps whole file)`);
console.log(`          ${(videoBytes / frameCount / 1024).toFixed(1)} kB average per frame`);

// Bits per pixel per frame is the number that predicts whether a frozen frame holds up.
const bpp = (videoBytes * 8) / (frameCount * codedW * codedH);
console.log(`density   ${bpp.toFixed(4)} bits/pixel/frame`);

const sorted = [...sampleSizes].sort((a, b) => a - b);
console.log(
  `frame kB  min ${(sorted[0] / 1024).toFixed(1)}  ` +
    `p50 ${(sorted[Math.floor(sorted.length / 2)] / 1024).toFixed(1)}  ` +
    `p95 ${(sorted[Math.floor(sorted.length * 0.95)] / 1024).toFixed(1)}  ` +
    `max ${(sorted[sorted.length - 1] / 1024).toFixed(1)}`,
);
