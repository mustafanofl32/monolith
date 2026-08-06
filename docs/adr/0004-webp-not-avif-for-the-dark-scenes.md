# 4. WebP q95, not AVIF, for the two near-black scenes

**Status:** accepted

## Context

AVIF beats WebP on almost every photograph at almost every quality, and "AVIF first, WebP fallback,
JPEG last" is the standard responsive-image ladder. 01-void and 07-return are near-black frames
carrying a smooth gradient plus the baked-in dither from ADR 2.

## Decision

The manifest carries a **per-scene** format priority. 01-void and 07-return list `["webp","jpeg"]`
and omit AVIF entirely. The other five list `["avif","webp","jpeg"]`.

## Why

Measured on the final encoded bytes — not on the graded PNG — with the fraction of dark 8×8 blocks
whose pixels are all identical. The graded source is dithered, so its flat share is ~0%; anything
above that is dither the encoder discarded.

**07-return @ 1600w**

| format | quality | chroma | size | flat blocks added |
|---|---|---|---|---|
| avif | 62 | 4:2:0 | 36.9 kB | 4.68% |
| avif | 80 | 4:4:4 | 60.1 kB | 7.12% |
| avif | 90 | 4:4:4 | 125.2 kB | 3.55% |
| webp | 88 | 4:4:4 | 62.1 kB | 6.36% |
| **webp** | **95** | **4:4:4** | **117.8 kB** | **2.63%** |
| jpeg | 88 | 4:4:4 | 96.7 kB | 6.21% |

WebP q95 is both smaller and smoother than the closest AVIF. Confirmed visually with a 6.3× shadow
lift (`pipeline/probe-encoded.mjs`): AVIF q80 shows obvious 2D blotching across the upper gradient,
AVIF q90 is smoother but still mottled against the source, WebP q95 keeps the grain structure.

**01-void @ 1600w**

| format | quality | chroma | size | flat blocks added |
|---|---|---|---|---|
| avif | 62 | 4:2:0 | 13.9 kB | 4.40% |
| avif | 80 | 4:4:4 | 41.9 kB | 2.68% |
| avif | 90 | 4:4:4 | 142.8 kB | 1.00% |
| **webp** | **95** | **4:4:4** | **119.5 kB** | **1.69%** |

Here the metric favours AVIF q90 — 1.00% against 1.69% — at 19% more bytes. The metric scans
horizontal runs only, so it under-reports AVIF's characteristic *2D* block artefacts, which the
lifted probe shows plainly. On this scene the eye overrode the metric. That is a judgement call and
it is recorded as one.

The general finding: **AVIF-first is the wrong default for near-black high-frequency content**,
because its rate-distortion pass is very good at deciding that a half-level dither is noise worth
spending no bits on — which is exactly the signal that keeps these gradients from banding.

## Cost

- 01-void and 07-return are ~2× the bytes they would be as AVIF q62. At 1600w that is the difference
  between 36.9 kB and 117.8 kB for 07-return.
- Only 01-void sits in the first-paint path, and at 119.5 kB it fits the 120 kB budget with 0.5 kB
  to spare — there is no headroom left on that scene.
- Format priority is per-scene data, so the runtime cannot assume a global preference.

## Alternatives rejected

- **AVIF everywhere at q62.** 4.4–4.7% added flat blocks; visible contouring on a good display.
- **AVIF q90 everywhere.** Larger than WebP q95 on both scenes and no better to the eye.
- **10-bit AVIF.** The actually-correct answer; no encoder on this machine supports it (ADR 2).
- **Lossless WebP.** 01-void at 1600w exceeds 400 kB. Not for a first-paint asset.
