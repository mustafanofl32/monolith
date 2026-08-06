import sharp from 'sharp';

console.log(`sharp ${sharp.versions.sharp} | libvips ${sharp.versions.vips}`);
console.log(`heif ${sharp.versions.heif ?? '-'} | aom ${sharp.versions.aom ?? '-'}`);
console.log('');

// Capability tables lie about AVIF: sharp files it under `heif`, so `format.avif.output`
// reads false on a binary that encodes AVIF perfectly well. Actually encoding is the only
// answer that counts.
const probe = sharp({
  create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 10, b: 12 } },
});

for (const [label, run] of [
  ['avif', () => probe.clone().avif({ quality: 50 }).toBuffer()],
  ['webp', () => probe.clone().webp({ quality: 80 }).toBuffer()],
  ['jpeg', () => probe.clone().jpeg({ quality: 80 }).toBuffer()],
]) {
  try {
    const buf = await run();
    console.log(`  ${label.padEnd(5)} ENCODES  (${buf.length} bytes for a 64x64 probe)`);
  } catch (e) {
    console.log(`  ${label.padEnd(5)} FAILED   ${String(e.message).split('\n')[0]}`);
  }
}
