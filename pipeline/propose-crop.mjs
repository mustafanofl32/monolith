/**
 * Renders candidate crop windows for 01-void so the framing is chosen by eye.
 *
 * 01-void is 2.35:1 content in a 1.79:1 container. Cropping it to 1.79:1 must remove WIDTH — at
 * 1172 rows the widest possible 1.79:1 window is 2100px — so the only free variable is where
 * horizontally that window sits.
 *
 * Each candidate is shown twice: as it will appear, and with shadows lifted, because the glow
 * placement is the whole decision and it is nearly invisible at true exposure.
 *
 *   node pipeline/propose-crop.mjs <out.png>
 */

import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectMatte, loadContent } from './lib/matte.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2];

const TARGET_ASPECT = 2752 / 1536; // exactly the other six scenes
const GLOW_X = 1065; // measured luminance-weighted centroid

const region = await detectMatte(join(ROOT, 'src', 'scenes', '01-void.jpeg'));
const { data, width, height } = await loadContent(join(ROOT, 'src', 'scenes', '01-void.jpeg'), region);

const cropW = Math.round(height * TARGET_ASPECT);
const maxX = width - cropW;

const candidates = [
  { label: 'A  x0=0    glow centred', x0: 0 },
  { label: 'B  x0=326  centre crop', x0: Math.round(maxX / 2) },
  { label: 'C  x0=652  glow hard left', x0: maxX },
];

const VIEW_W = 640;
const VIEW_H = Math.round(VIEW_W / TARGET_ASPECT);
const PAD = 10;
const LABEL_H = 26;

function overlay(w, h) {
  // Rule-of-thirds, plus the upper-two-thirds band the MONOLITH heading has to live in.
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
       <rect x="0" y="0" width="${w}" height="${Math.round((h * 2) / 3)}"
             fill="#D4A04C" fill-opacity="0.05"/>
       <line x1="${w / 3}" y1="0" x2="${w / 3}" y2="${h}" stroke="#D4A04C" stroke-opacity="0.35" stroke-width="1"/>
       <line x1="${(w * 2) / 3}" y1="0" x2="${(w * 2) / 3}" y2="${h}" stroke="#D4A04C" stroke-opacity="0.35" stroke-width="1"/>
       <line x1="0" y1="${h / 3}" x2="${w}" y2="${h / 3}" stroke="#D4A04C" stroke-opacity="0.35" stroke-width="1"/>
       <line x1="0" y1="${(h * 2) / 3}" x2="${w}" y2="${(h * 2) / 3}" stroke="#D4A04C" stroke-opacity="0.55" stroke-width="1"/>
     </svg>`,
  );
}

function caption(text, w) {
  return Buffer.from(
    `<svg width="${w}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
       <text x="0" y="17" font-family="monospace" font-size="14" fill="#c9c6c0">${text}</text>
     </svg>`,
  );
}

const layers = [];
const raw = { width, height, channels: 3 };

for (let i = 0; i < candidates.length; i++) {
  const c = candidates[i];
  const cropped = await sharp(data, { raw })
    .extract({ left: c.x0, top: 0, width: cropW, height })
    .resize(VIEW_W, VIEW_H)
    .raw()
    .toBuffer();

  // Shadow lift, same 6.3x probe used elsewhere.
  const lifted = Buffer.allocUnsafe(cropped.length);
  for (let p = 0; p < cropped.length; p++) {
    lifted[p] = Math.round(Math.min(1, cropped[p] / 255 / 0.16) * 255);
  }

  const viewRaw = { width: VIEW_W, height: VIEW_H, channels: 3 };
  const x = PAD + i * (VIEW_W + PAD);

  layers.push({ input: caption(c.label, VIEW_W), left: x, top: 4 });
  layers.push({
    input: await sharp(cropped, { raw: viewRaw }).composite([{ input: overlay(VIEW_W, VIEW_H) }]).png().toBuffer(),
    left: x,
    top: LABEL_H,
  });
  layers.push({
    input: await sharp(lifted, { raw: viewRaw }).composite([{ input: overlay(VIEW_W, VIEW_H) }]).png().toBuffer(),
    left: x,
    top: LABEL_H + VIEW_H + PAD,
  });
  layers.push({
    input: caption(`glow at ${(((GLOW_X - c.x0) / cropW) * 100).toFixed(1)}% across`, VIEW_W),
    left: x,
    top: LABEL_H + VIEW_H * 2 + PAD * 2,
  });
}

await sharp({
  create: {
    width: PAD + candidates.length * (VIEW_W + PAD),
    height: LABEL_H + VIEW_H * 2 + PAD * 2 + LABEL_H,
    channels: 3,
    background: { r: 16, g: 16, b: 18 },
  },
})
  .composite(layers)
  .png()
  .toFile(out);

console.log(`content ${width}x${height} -> crop ${cropW}x${height} (${(cropW / height).toFixed(4)}:1)`);
console.log(`candidates: ${candidates.map((c) => `${c.label.split(' ')[0]}@x0=${c.x0}`).join('  ')}`);
console.log(`top row = as shipped, bottom row = shadows lifted 6.3x`);
console.log(`amber band = upper two thirds, reserved for the MONOLITH heading`);
console.log(`-> ${out}`);
