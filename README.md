# MONOLITH

A scroll-driven study in light. Seven images, seven scenes, six transitions, one canvas.

The scroll wheel is the clock: every frame is composited from the current scroll position, so
scrolling backwards runs the piece backwards and stopping mid-transition holds it there. There is no
video, no timeline, and no animation library.

With only seven images, all of the craft is in the transitions, the grading and the typography — so
that is where the work went. It is deliberately not seven cross-fades.

---

## Run it

Node 20+. No API keys, no Docker, no cloud account, nothing to sign up for.

```bash
npm install
npm run assets     # grade + encode the seven sources into 74 responsive variants (~2 min)
npm run dev        # http://localhost:5173
```

`npm run assets` is required once before `dev` or `build`: the encoded assets are not committed
(see [ADR 5](docs/adr/0005-build-assets-in-ci-not-commit-them.md)).

```bash
npm test           # 29 unit + contract tests, no browser needed
npm run build && npm run preview
node pipeline/verify.mjs http://localhost:4173 tmp/verify   # the measurements below
```

---

## The scroll model

Seven scenes, each owning a range of scroll offsets. Adjacent ranges **overlap**, and the overlap is
the transition band. Outside a band exactly one scene draws; inside one, two draw and blend by the
band's normalised progress. Bands never touch each other, so three scenes are never live at once.

Scene lengths are expressed in viewport heights and resolved once from a measured
`window.innerHeight` — never from `dvh`
([ADR 7](docs/adr/0007-measured-viewport-height-not-dvh.md)).

```
LENGTH_VH  = [1.4, 1.4, 1.4, 1.4, 1.4, 1.7, 1.7]           // scene length, in viewports
BAND_RATIO = [0.35, 0.35, 0.175, 0.35, 0.35, 0.45]         // band = ratio x shorter neighbour
```

Resolved at a 900 px viewport (`npm run model` prints this for any height):

```
scene   range            length   solo-only span
01        0 –   1260     1260        0 –    819  (819)
02      819 –   2079     1260     1260 –   1638  (378)
03     1638 –   2898     1260     2079 –   2677  (598)
04     2677 –   3937     1260     2898 –   3496  (598)
05     3496 –   4756     1260     3937 –   4315  (378)
06     4315 –   5845     1530     4756 –   5156  (400)
07     5156 –   6686     1530     5845 –   6686  (841)

band    range            length   ratio   transition
01→02     819 –   1260      441   0.350   cross-dissolve-scale-in
02→03    1638 –   2079      441   0.350   mask-wipe-up
03→04    2677 –   2898      221   0.175   fast-dissolve
04→05    3496 –   3937      441   0.350   split-horizontal
05→06    4315 –   4756      441   0.350   cross-dissolve-punch
06→07    5156 –   5845      689   0.450   long-dissolve

total scroll 6686px   document 7586px   in-band 2674px (40.0%)
```

Scenes 06 and 07 are longer than the rest because they flank the slowest transition. At the base
1.4 length, the 0.45 band between them left scene 06 with roughly 190 px of solo scroll — it would
have arrived and started dissolving almost simultaneously. A test pins the minimum solo span.

**Two clocks, on purpose.** The canvas follows a smoothed scroll value; the type and the progress
line read raw `window.scrollY`. A progress bar that lagged the page would read as a bug, and so
would type that slid after the scroll had stopped. The smoothing is frame-rate independent —
`value += distance * (1 - exp(-dt / tau))`, not a fixed per-frame factor, because a fixed factor
converges twice as fast at 120 Hz and would make the feel of the site a property of the display.

---

## Measured

Every number below was produced by `pipeline/verify.mjs` against a production build on this machine
(Windows 11, Chromium via Playwright). Nothing here is estimated.

### Budget — 1440×900, throttled to 5 Mbps / 40 ms RTT / 4× CPU

| | measured | budget | |
|---|---|---|---|
| first scene visible | **322 ms** | < 1500 ms | pass |
| LCP | **384 ms** | < 2000 ms | pass |
| CLS | **0.0000** | < 0.05 | pass |
| initial JS, gzipped | **6.5 kB** | < 40 kB | pass |
| initial CSS, gzipped | 1.4 kB | — | |
| transfer to first paint | ~145 kB | — | |

CLS is zero by construction: the stage is a fixed-height sticky element and the canvas is sized from
JS, so nothing reflows when the images arrive.

The preloader waits for **two** scenes, not one — 128.8 kB at 1440 px — so the first transition can
never decode mid-scroll. Its counter is tied to real decode progress with no minimum duration; from
cache it is gone in one frame.

### Frame cost at 2560×1440, bucketed by phase

40% of the scroll is inside a transition band, so a single average would be dominated by the cheap
single-scene path and would hide a drop that only happens during motion. Times are the work done
inside the rAF callback, in milliseconds — **this is draw cost, not an fps counter.**

| phase | frames | p50 | p95 | worst | over 16.7 ms |
|---|---|---|---|---|---|
| solo (one scene) | 480 | 0.10 | 0.30 | 3.10 | **0** |
| band 01→02 cross-dissolve-scale-in | 46 | 0.10 | 0.30 | 0.40 | **0** |
| band 02→03 mask-wipe-up | 48 | 0.10 | 0.30 | 0.30 | **0** |
| band 03→04 fast-dissolve | 22 | 0.10 | 0.20 | 0.70 | **0** |
| band 04→05 split-horizontal | 48 | 0.10 | 0.20 | 0.30 | **0** |
| band 05→06 cross-dissolve-punch | 47 | 0.10 | 0.20 | 0.20 | **0** |
| band 06→07 long-dissolve | 638 | 0.10 | 0.20 | 1.30 | **0** |

Not a single frame in any bucket exceeded the 16.7 ms budget, including the 06→07 band swept
forwards and backwards at 8 px steps. The worst frame anywhere was 3.10 ms, in the solo path, where
a decode landed.

### Memory and variant selection

| viewport | variant widths | after first paint | peak resident |
|---|---|---|---|
| 375 × 812 | 640 | 1.7 MB | 2.6 MB |
| 768 × 1024 | 1024 | 4.5 MB | 6.7 MB |
| 1440 × 900 | 1600 | 10.9 MB | 16.4 MB |
| 2560 × 1440 | 1600 + 2560 | 19.4 MB | **41.9 MB** |

Three bitmaps resident at most, chosen by CSS width rather than DPR alone
([ADR 8](docs/adr/0008-three-bitmaps-resident-capped-by-css-width.md)).

### Robustness

- 137 scroll samples across slow (20 px steps), fast (400 px steps) and upward passes: **0 frames**
  where the canvas failed to composite, **0 page errors**.
- Interrupted mid-transition — jumped into a band, stopped dead, reversed out: composited correctly
  at both points.
- No horizontal overflow at 375 / 768 / 1440 / 2560.
- `prefers-reduced-motion: reduce` renders a single still (03-reveal) as an ordinary `<img>`, with
  every word of the chapter copy present: **0 canvas elements, no rAF, no grain, no speculative
  decoding**, and the document takes its natural height instead of 7.4 viewports.

---

## The image pipeline

Seven 2752×1536 JPEGs in `src/scenes/` become 74 files totalling 5.28 MB in `public/scenes/`, plus a
`manifest.json` that is the only thing the runtime reads. No scene filename appears anywhere in
`src/` — a test enforces it.

**Grading.** Black and white points are measured per scene, the cast is corrected, and a 0.22
S-curve is applied. Levels stretch is capped at 1.35× so an auto-levels pass cannot destroy a scene
that is *supposed* to be dark — the first version stretched 01-void from [0,47] to [3,191] and
turned the void into fog.

Colour cast is measured **only over near-neutral pixels**, with the neutrality threshold defined
relative to each pixel's own brightness
([ADR 3](docs/adr/0003-measure-neutrality-relative-to-brightness.md)). Measuring the whole frame
turned 05-turn teal, because its large amber panel read as a global warm cast.

Convergence, black point:

| | 01 | 02 | 03 | 04 | 05 | 06 | 07 | spread |
|---|---|---|---|---|---|---|---|---|
| before | 8 | 2 | 5 | 3 | 0 | 3 | 10 | **10** |
| after | 3 | 3 | 3 | 3 | 3 | 3 | 4 | **1** |

Neutral-pixel colour temperature, adjacent pairs (the metric that matters — a difference is only
visible where two scenes are on screen together):

| pair | before | after |
|---|---|---|
| 02→03 | 282 K | 84 K |
| 03→04 | 55 K | 20 K |
| 04→05 | 282 K | 59 K |
| 05→06 | 330 K | 100 K |
| 06→07 | 56 K | 77 K |
| **worst** | **330 K** | **100 K** |

Two honest notes on that table. **01→02 is absent because the metric cannot measure it.** After
grading, 01-void has 0.0% of pixels above the neutrality floor, so `neutralCct` silently falls back
to a whole-frame figure that is not comparable — quoting a number there would be quoting an
artefact. And **the 06→07 pull is no longer earning its place**: it was tuned against an earlier
grade where that pair was further apart, and on the final grade it moves them from 56 K to 77 K.
Both figures are far below a visible threshold, but it is doing nothing useful and could be dropped.

Neutrals are kept slightly cool against the amber accent on purpose. That separation is the art
direction, not a side effect.

**Banding.** Levels stretching an 8-bit image spreads its levels apart and leaves gaps the eye reads
as contours. The fix is to grade in float and quantize once, with a triangular-PDF dither at ±0.5
LSB ([ADR 2](docs/adr/0002-grade-in-float-quantize-once.md)). The dither is baked into the file, not
faked by the runtime grain — grain masks banding perceptually but does not travel with the image.

### AVIF is the wrong default for near-black content

The standard ladder is AVIF → WebP → JPEG. Measured on the **final encoded bytes**, not on the
graded PNG, that ladder is wrong for the two darkest scenes. The metric is the share of dark 8×8
blocks that are perfectly flat; the dithered source is at ~0%, so anything above it is dither the
encoder threw away.

**07-return @ 1600w**

| format | quality | chroma | size | flat blocks added |
|---|---|---|---|---|
| avif | 62 | 4:2:0 | 36.9 kB | 4.68% |
| avif | 80 | 4:4:4 | 60.1 kB | 7.12% |
| avif | 90 | 4:4:4 | 125.2 kB | 3.55% |
| webp | 88 | 4:4:4 | 62.1 kB | 6.36% |
| **webp** | **95** | **4:4:4** | **117.8 kB** | **2.63%** |
| jpeg | 88 | 4:4:4 | 96.7 kB | 6.21% |

**01-void @ 1600w**

| format | quality | chroma | size | flat blocks added |
|---|---|---|---|---|
| avif | 62 | 4:2:0 | 13.9 kB | 4.40% |
| avif | 80 | 4:4:4 | 41.9 kB | 2.68% |
| avif | 90 | 4:4:4 | 142.8 kB | 1.00% |
| **webp** | **95** | **4:4:4** | **119.5 kB** | **1.69%** |

On 07-return WebP q95 wins outright — smaller *and* smoother. On 01-void the metric prefers AVIF q90
(1.00% vs 1.69%) at 19% more bytes, but the metric scans horizontal runs only and therefore
under-reports AVIF's characteristic *two-dimensional* blocking, which a 6.3× shadow lift shows
plainly. On that scene the eye overrode the metric; that is a judgement call and it is recorded as
one in [ADR 4](docs/adr/0004-webp-not-avif-for-the-dark-scenes.md).

So the manifest carries a **per-scene** format priority. 01-void and 07-return omit AVIF entirely;
the other five lead with it.

The real fix would be 10-bit AVIF, which removes the problem at the source. It is not available
here: sharp's prebuilt binary rejects any bit depth other than 8, and this machine has no `avifenc`,
`magick`, `ffmpeg` or `cavif`. Reported as blocked rather than shipped as 8-bit and called 10-bit.

### Why the assets are built in CI instead of committed

The dither uses a fixed mulberry32 seed, the encoder settings are constants, and the manifest carries
no timestamp. The pipeline is therefore byte-reproducible, and `tests/manifest.test.js` asserts every
variant's on-disk size against the byte count the manifest recorded.

**That determinism is what makes building in CI safe rather than a source of churn.** Without it,
every push would rewrite 74 binaries with cosmetically different bytes and no way to distinguish a
real change from encoder noise. With it, a size mismatch means somebody changed the encode settings,
and the test says so out loud.

---

## Stack

Vite, and the platform. No framework, no animation library, no webfont, no runtime dependency at
all — the deployed site is HTML, CSS, one 15.9 kB ES module, and images.

`sharp` is a build-time dependency for the image pipeline. `playwright` is a dev dependency for the
measurement scripts. Neither ships.

```
src/
  scroll-model.js   pure arithmetic — ranges, bands, residency. No DOM, fully unit tested.
  renderer.js       the rAF loop, the scroll follower, per-phase frame instrumentation
  transitions.js    six transition functions, keyed by name from the model
  bitmap-store.js   prev/current/next residency, explicit close()
  cover-fit.js      source-side crop geometry, Ken Burns
  viewport.js       viewport measurement, variant and format selection
  easing.js         cubic-bezier solver and the four curves
  grain.js          three pre-rolled noise tiles, composited in overlay mode
  overlay.js        chapter type, parallax, masked reveal, progress line, preloader
  main.js           wiring, and the reduced-motion path
pipeline/           grade, encode, and every measurement script used for the numbers above
docs/adr/           ten decision records
tests/              29 tests, node:test, no browser
```

Type is DOM rather than canvas, so it stays selectable, translatable and readable by a screen reader,
and stays crisp at any DPR without re-rendering. It is confined to each scene's *solo* span so a
heading is never legible over two blended images at once — which is where scroll type usually looks
cheap. Two platform typefaces, one accent colour used three times, a strict 4 px spacing scale.

---

## Limits

- **Chromium and Firefox are what this was measured on.** Safari should work — `createImageBitmap`,
  `ImageBitmap.close()` and sticky positioning are all supported — but it has not been tested here,
  and Safari's WebP decode path for large images is the most likely place to find a surprise.
- **41.9 MB of decoded bitmaps at 2560×1440** is the worst case. Fine on a desktop, which is the only
  place that viewport exists; a phone caps at 640–1600 and stays under 7 MB.
- **The measurements are single-machine.** They were taken on one Windows 11 desktop with CPU and
  network throttling applied, not across a device lab.
- **The 15% resize threshold is a heuristic.** A window resized by exactly 14% will not rebuild the
  model until the next real resize. The result is cosmetic.
- **The matte detector was tuned against seven images.** A source with a soft vignette rather than a
  hard letterbox would not be caught automatically.
- **`neutralCct` falls back instead of reporting `null`** when a scene has too few neutral pixels.
  That is why the 01→02 pair is missing from the convergence table above rather than wrong in it.
- **No scroll-snapping.** A scrollbar drag lands wherever it lands; beyond 20% of total scroll the
  follower stops chasing and cuts, because a drag should arrive rather than glide.

## The video that is not here

A generated 8-second orbit was produced as a possible motion source and assessed against criteria
fixed in advance, before any pipeline was built on it. Both takes failed on the same thing: **the
orbit stops halfway.** v2 produces 96 distinct frames and then holds one byte-identical frame from
t ≈ 3.9 s to the end — verified through two independent decode paths, so it is the source and not
the extractor. A scrub built on it would run for half its scroll range and then stop dead while the
user kept scrolling. At 1280×720 and 0.055 bits per pixel per frame it was also the one element that
would soften as the viewport grew, on a site that serves 2560-wide stills.

One correction: during the assessment I reported that take as failing dark-area compression at 57.1%
flat blocks against a 30% limit, and made that the headline reason. **That figure does not
reproduce** — re-measured across thresholds it sits between 16.8% and 26.4%, so it passes that
criterion. The rejection stands on the frozen tail and the resolution, not on compression. Full
numbers and the re-check in [ADR 10](docs/adr/0010-exclude-the-generated-video.md).

The site is seven images, and that is a decision rather than an omission.

---

## Decision records

| | |
|---|---|
| [1](docs/adr/0001-composite-on-canvas-not-stacked-dom.md) | Composite on one canvas, not stacked DOM layers |
| [2](docs/adr/0002-grade-in-float-quantize-once.md) | Grade in float and quantize exactly once, with a dither |
| [3](docs/adr/0003-measure-neutrality-relative-to-brightness.md) | Measure colour cast over near-neutral pixels, relatively |
| [4](docs/adr/0004-webp-not-avif-for-the-dark-scenes.md) | WebP q95, not AVIF, for the two near-black scenes |
| [5](docs/adr/0005-build-assets-in-ci-not-commit-them.md) | Build the derived assets in CI rather than committing them |
| [6](docs/adr/0006-easing-for-a-scroll-driven-clock.md) | Different easing curves because the user is the clock |
| [7](docs/adr/0007-measured-viewport-height-not-dvh.md) | Measure viewport height in JS; never `dvh` |
| [8](docs/adr/0008-three-bitmaps-resident-capped-by-css-width.md) | Three bitmaps resident, capped by CSS width |
| [9](docs/adr/0009-crop-01-void-deliberately.md) | Strip 01-void's matte, then crop it deliberately |
| [10](docs/adr/0010-exclude-the-generated-video.md) | Assess the generated video, then exclude it |

---

Mostafa Nofal — 2026. MIT.
