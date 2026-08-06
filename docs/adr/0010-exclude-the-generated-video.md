# 10. Assess the generated video, then exclude it

**Status:** accepted

## Context

Two 8-second generated orbits around the monolith were produced as a possible motion source, to be
scrubbed frame-by-frame the way an Apple product page scrubs a render. Criteria were fixed **before**
looking at the second take, so the assessment could fail:

| criterion | threshold |
|---|---|
| distinct frames | ≥ 90 of 192 |
| longest identical run | ≤ 2 frames |
| geometry warping | none or slight |
| perfectly flat dark 8×8 blocks | < 30% |
| camera speed | constant within ~15% |
| resolution | ≥ 1280 wide |

## Measured

Both takes, same scripts (`pipeline/probe-video.mjs`, `pipeline/frame-census.mjs`):

| | v1 | v2 | threshold |
|---|---|---|---|
| container / codec | MP4, avc1 High @ L3.1 | MP4, avc1 High @ L3.1 | |
| resolution | 1280 × 720 | 1280 × 720 | ≥ 1280 |
| frames / fps | 192 @ 24.000 (constant) | 192 @ 24.000 (constant) | |
| keyframes | 3 | 3 | |
| bitrate | 931 kbps | 1205 kbps | |
| bits / pixel / frame | 0.0421 | 0.0545 | |
| **distinct frames** | 64 | **96** | ≥ 90 |
| **longest identical run** | **129** | **97** | ≤ 2 |
| flat dark 8×8 blocks | 27.2% | **17.0%** | < 30% |

## Decision

Excluded. The site ships the seven stills.

## Why — and a correction

**The frozen tail is the disqualifying finding.** Both takes produce distinct frames for the first
half and then hold a single frame for the entire second half. v2 stops moving at t ≈ 3.9 s and every
frame from there to 7.9 s is byte-identical.

That "exactly half" pattern looked like an extraction artefact, so it was re-checked through a
completely independent path — explicit `seeked` events rather than polled `currentTime`, decoding
straight to a canvas and hashing the pixels:

```
asked 3.90  landed 3.900  hash 9e0faab1
asked 4.00  landed 4.000  hash 9e0faab1
asked 4.50  landed 4.500  hash 9e0faab1
asked 5.00  landed 5.000  hash 9e0faab1
asked 6.00  landed 6.000  hash 9e0faab1
asked 7.00  landed 7.000  hash 9e0faab1
asked 7.90  landed 7.900  hash 9e0faab1
```

`currentTime` lands exactly on each target, so seeking works. The freeze is in the source. A scrub
built on it would run for half its scroll range and then stop dead while the user kept scrolling.

**Correction to an earlier report.** During the assessment I reported v2 as failing dark-area
compression at 57.1% flat blocks against the 30% limit, and that was the headline reason given for
rejecting it. That figure does not reproduce. Re-measured across dark thresholds from 16 to 64, v2
sits between 16.8% and 26.4% — it **passes** that criterion at every threshold tested, and passes it
more comfortably than v1 does. The rejection stands, but not for the reason first given.

The remaining real objections:

- **96 usable frames, all in the first 4 seconds.** Enough for a 60–90 frame sequence in raw count,
  but they cover half an orbit, not a whole one.
- **1280 × 720** on a site that serves 2560-wide stills. The video would be the one element that
  softens when the viewport grows.
- **0.0545 bits per pixel per frame.** Freezing any single frame out of this and putting it next to a
  graded still is not a comparison it survives.

**The geometry criterion returned no usable verdict.** Silhouette detection by luminance threshold
caught sparkle flecks on the dark slab; switching to a gradient-based silhouette was still confounded
by shadow boundaries against a dark background. So "edges straight or bowed" was never measured, and
no claim is made about it in either direction.

## Cost

- The piece has no true motion source; all movement is transitions, Ken Burns drift and parallax.
- Roughly a day of pipeline work (probe, census, extraction, geometry) produced no shipped asset.
  The scripts are kept in `pipeline/` because they are what makes the rejection checkable.

## Alternatives rejected

- **Use the first 96 frames only.** Half an orbit that stops where the interesting part would be.
- **Regenerate a third take.** Reasonable, and not free. The seven stills already carry the piece,
  and adding a 720p element to a page of clean stills makes it the cheapest thing on screen.
- **Ship it and hope.** The reason the criteria were written down in advance.
