# 3. Measure colour cast over near-neutral pixels, with a relative threshold

**Status:** accepted

## Context

To bring seven images to one look, each one's colour cast has to be measured and corrected. The
naive measurement is the mean of R, G and B over the whole frame.

## Decision

Cast is measured only over pixels that are already close to neutral, and "close to neutral" is
defined relative to the pixel's own brightness:

```js
const NEUTRAL_RELATIVE_SPREAD = 0.12;
const NEUTRAL_FLOOR = 12;
if (max >= NEUTRAL_FLOOR && max - min <= max * NEUTRAL_RELATIVE_SPREAD) { /* counts as neutral */ }
```

## Why

**Whole-frame means fail on coloured subjects.** 05-turn contains a large amber panel. Averaged over
the frame that panel reads as a global warm cast, and the correction turned the whole image teal —
it removed the subject, not a cast. Only pixels that are *supposed* to be grey can tell you what
grey is doing.

**An absolute spread threshold fails in shadow.** A first version required `max - min <= 12`. A
pixel at R=20 G=14 B=8 is visibly amber and spreads only 12, so it counted as neutral; meanwhile a
highlight at R=210 G=205 B=200 is neutral to the eye and spreads 10. Cast is proportional to
brightness, so the threshold has to be too.

Correcting this changed a number I had already reported: I had quoted a "before" cast spread of
2263K when the true figure under the corrected measurement is 386K. The larger number flattered the
correction.

## Cost

- Scenes with few neutral pixels are measured from a small sample. `neutralShare` is recorded per
  scene so this is visible rather than assumed; it ranges 3%–35% before grading.
- **The metric does not survive its own correction on 01-void.** After grading, 01-void has 0.0% of
  pixels above the neutrality floor, so `neutralCct` silently falls back to the whole-frame figure.
  The 01→02 adjacent-pair delta therefore has no valid "after" value and none is quoted anywhere.
  A future version should report `null` instead of falling back.

## Alternatives rejected

- **Whole-frame mean.** Produced the teal 05-turn.
- **Grey-world with a percentile clip.** Still weights a large coloured region; the panel in 05-turn
  is big enough to survive any percentile that keeps enough samples to be stable.
- **Manual per-scene white balance.** Would work and would not generalise; the point of the pipeline
  is that adding an eighth image requires no hand-tuning.
