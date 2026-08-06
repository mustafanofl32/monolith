# 2. Grade in float and quantize exactly once, with a dither

**Status:** accepted

## Context

Seven images from the same generator but not from the same exposure. Black points ranged 0–10,
white points 49–209. Bringing them to one look means stretching levels, and stretching an 8-bit
image spreads its existing levels apart, leaving gaps the eye reads as contour bands — worst on
01-void and 07-return, which are almost entirely shadow.

## Decision

Decode → resize → grade in float → dither → quantize to 8-bit, once, at the end. The grade and the
encode share the same code (`pipeline/lib/grade-core.mjs`) so both paths apply identical maths.
Dither is triangular-PDF at ±0.5 LSB with a fixed seed.

## Why

The order matters more than it looks. Resizing *before* grading manufactures intermediate levels
from interpolation, and the stretch then lands on values that were invented rather than measured —
it hides the banding in the probe while leaving it in the shipped file at other widths. Grading
before quantizing means the stretch happens at full precision and only one rounding step exists.

Triangular PDF rather than rectangular: TPDF decorrelates the quantization error from the signal,
so the residual reads as fine grain rather than as a pattern that tracks the gradient.

The seed is fixed (`0x5eed`, mulberry32) so the build is byte-reproducible — see ADR 5.

## Cost

- Peak memory during encode is a full float RGB buffer per variant: at 2560×1429 that is 44 MB.
- Grain is added to a source that a lossy encoder will then try to remove, so the encoder settings
  had to be chosen against that (ADR 4).
- Every pipeline stage must go through `grade-core.mjs`; a second implementation would drift.

## Alternatives rejected

- **16-bit intermediates.** Attempted first and abandoned. sharp's `toColourspace('rgb16')` halves
  values, and `raw({depth:'ushort'})` on a 16-bit PNG returns two bytes per channel which read back
  as 8-bit garbage (16384 arrives as 25). Rather than ship a silently-wrong intermediate, the grade
  was fused into the encode so no intermediate file exists.
- **10-bit AVIF.** The correct fix for the banding, and unavailable: sharp's prebuilt binary rejects
  `bitdepth` other than 8, and this machine has no `avifenc`, `magick`, `ffmpeg` or `cavif`. Raised
  before spending time on it; dropped by decision.
- **Relying on the film grain to hide it.** Grain masks residual banding perceptually, but it is a
  runtime overlay — it does not travel with the file, and anything that samples the image (a
  screenshot, a social preview) shows the bands. The dither is baked in; the grain is finish.
