/** Probes the three capabilities the banding mitigations depend on. Encode, don't infer. */
import sharp from 'sharp';

const W = 512;
const H = 64;

// A 48-level ramp stretched across the frame — the same shape as 01-void's dark gradient,
// which is where banding shows first.
const u16 = new Uint16Array(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const step = Math.floor((x / W) * 48);
    const v = Math.round((step / 48) * 0.09 * 65535);
    const i = (y * W + x) * 3;
    u16[i] = v;
    u16[i + 1] = v;
    u16[i + 2] = v;
  }
}

const raw16 = { width: W, height: H, channels: 3, depth: 'ushort' };

async function probe(label, fn) {
  try {
    const buf = await fn();
    console.log(`  ${label.padEnd(30)} OK    ${buf.length} bytes`);
    return buf.length;
  } catch (e) {
    console.log(`  ${label.padEnd(30)} FAIL  ${String(e.message).split('\n')[0].slice(0, 80)}`);
    return null;
  }
}

console.log('16-bit raw input + high-depth output:');
await probe('raw ushort -> png 16-bit', () =>
  sharp(Buffer.from(u16.buffer), { raw: raw16 }).png({ compressionLevel: 9 }).toBuffer(),
);
const a8 = await probe('raw ushort -> avif 8-bit', () =>
  sharp(Buffer.from(u16.buffer), { raw: raw16 }).avif({ quality: 60, bitdepth: 8 }).toBuffer(),
);
const a10 = await probe('raw ushort -> avif 10-bit', () =>
  sharp(Buffer.from(u16.buffer), { raw: raw16 }).avif({ quality: 60, bitdepth: 10 }).toBuffer(),
);
const a12 = await probe('raw ushort -> avif 12-bit', () =>
  sharp(Buffer.from(u16.buffer), { raw: raw16 }).avif({ quality: 60, bitdepth: 12 }).toBuffer(),
);

if (a8 && a10) {
  console.log('');
  console.log(`  10-bit size delta on this ramp: ${(((a10 - a8) / a8) * 100).toFixed(1)}%`);
}
if (a8 && a12) {
  console.log(`  12-bit size delta on this ramp: ${(((a12 - a8) / a8) * 100).toFixed(1)}%`);
}

console.log('');
console.log('verify the 16-bit png round-trips at depth:');
const png16 = await sharp(Buffer.from(u16.buffer), { raw: raw16 }).png().toBuffer();
const meta = await sharp(png16).metadata();
console.log(`  depth=${meta.depth}  channels=${meta.channels}  ${meta.width}x${meta.height}`);
