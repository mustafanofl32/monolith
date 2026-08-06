# 9. Strip 01-void's baked-in matte, then crop it deliberately

**Status:** accepted

## Context

01-void arrived 2752×1536 like the other six, but with a letterbox matte baked into the pixels: 183
rows of black at the top and 181 at the bottom, leaving 2752×1172 of content at 2.348:1. Nothing in
the filename or metadata said so; it was found by running a projection profile with hard-edge gating
over all seven sources.

Cover-fitting 2.348:1 content into a 1.79:1 frame alongside six 1.79:1 siblings would have meant
either pillarboxing it or letting the fit crop it arbitrarily.

## Decision

Remove the matte, then take a deliberate 2100×1172 window anchored to the **left** edge. The scene
ships at 1.7918:1, matching the other six to four decimal places, with widths 640/1024/1600 and no
2560 variant.

## Why

The composition has its glow in the lower third and a large empty upper area. The left-anchored
window keeps the glow in the lower third and the upper two thirds empty — which is where MONOLITH
sits. That is the crop being an art-direction decision rather than a byproduct of `object-fit`.

No 2560 variant because the content is 2100 px wide. A 2560 variant would be upscaled — invented
pixels sold as detail. `tests/manifest.test.js` asserts no variant exceeds its source width, and
`pickWidth` falls back to the largest available rather than failing.

## Cost

- 01-void is the one scene whose maximum sharpness is lower than the rest. On a 2560 px display it
  is drawn from the 1600 variant, so it is the softest frame in the sequence. It is also the
  darkest and least detailed, which is why this is acceptable rather than merely tolerated.
- `encode-core.mjs` carries a per-scene `CROPS` table — a hardcoded exception. It is keyed by scene
  id inside the pipeline, not in the runtime, so the manifest remains the only authority the site
  reads.
- The matte detector's thresholds (`MATTE_THRESHOLD = 3.0`, `MIN_EDGE_JUMP = 4.0`,
  `MAX_MATTE_FRACTION = 0.3`) were tuned against seven images. A new source with a soft vignette
  rather than a hard matte would not be caught.

## Alternatives rejected

- **Pillarbox it.** Explicitly rejected: black bars beside one of seven scenes.
- **Let cover-fit crop it.** Would work and would centre the window, putting the glow mid-frame and
  filling the space the title needs.
- **Leave the matte in and letterbox.** Same problem, plus the graded black point would be computed
  over 364 rows of pure black that are not part of the image.
