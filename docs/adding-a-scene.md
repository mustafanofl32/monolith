# Worked example: adding an eighth scene

The point of the manifest is that adding a scene is a **pipeline change, not a code change**. This
walks through it end to end so that claim is checkable rather than asserted.

A test enforces it: `tests/manifest.test.js` fails if any scene filename appears anywhere in `src/`
or `index.html`.

---

## 1. Drop the file in

```
src/scenes/08-echo.jpeg
```

Any resolution. The pipeline reads the intrinsic size and generates only the variant widths that
fit — a 1400 px-wide source gets 640 and 1024 and stops, because upscaling would be inventing
detail (`tests/manifest.test.js` asserts no variant exceeds its source).

## 2. Add its id to the ordered list

`pipeline/lib/stats.mjs` — one line. This array is the running order.

```js
export const SCENES = [
  '01-void',
  // ...
  '07-return',
  '08-echo',        // <- added
];
```

## 3. Give the scroll model a length and a transition

`src/scroll-model.js`. Three arrays, all of which must stay in step: `LENGTH_VH` gains one entry,
`BAND_RATIO` and `TRANSITIONS` each gain one (there is always one fewer band than scene).

```js
const LENGTH_VH  = [1.4, 1.4, 1.4, 1.4, 1.4, 1.7, 1.7, 1.4];
const BAND_RATIO = [0.35, 0.35, 0.175, 0.35, 0.35, 0.45, 0.35];

export const TRANSITIONS = [
  // ...
  'long-dissolve',
  'mask-wipe-up',   // <- reuse one, or write a new one (step 5)
];
```

Note this is the one place a scene's *position* is encoded rather than its name. The model knows
there are eight scenes; it never learns what they are called.

## 4. Rebuild

```bash
npm run assets
npm test
```

`npm run assets` regrades all eight together — the grade is a *relative* operation, so a new scene
shifts the shared black point and every other scene is re-encoded to match. That is the intended
behaviour and the reason the assets are rebuilt rather than committed
([ADR 5](adr/0005-build-assets-in-ci-not-commit-them.md)).

Two things to check in the output:

- **Its stretch is not capped.** `capped: true` in `grade-report.json` means the levels stretch hit
  the 1.35× ceiling and the scene did not fully reach the shared black and white points. That is
  the guard working, not a failure — but look at the result.
- **Its neutral share is usable.** Below ~5% and the cast measurement is running on too few pixels
  to be stable (01-void sits at 3%, and after grading drops to 0.0% — see
  [ADR 3](adr/0003-measure-neutrality-relative-to-brightness.md)).

## 5. Only if you want a new transition

`src/transitions.js` exports `TRANSITION_FNS`, keyed by the name the model uses. A transition is a
function that draws two scenes into one context:

```js
'iris-in'(ctx, from, to, progress, dw, dh) {
  drawScene(ctx, from.bitmap, dw, dh, { scale: kenBurnsScale(from.progress) });
  const r = easeTravel(progress) * Math.hypot(dw, dh) * 0.5;
  ctx.save();
  ctx.beginPath();
  ctx.arc(dw / 2, dh / 2, r, 0, Math.PI * 2);
  ctx.clip();
  drawScene(ctx, to.bitmap, dw, dh, { scale: kenBurnsScale(to.progress) });
  ctx.restore();
}
```

Use `easeTravel` or `easeBlend`, **not** `easeOut`. Under a scroll-driven clock the user supplies
`progress` directly, and expo-out reaches 0.972 by the halfway point — the whole transition would
happen in the first 15% of the band and the rest would be a static hold. A test enforces this for
the shipped curves ([ADR 6](adr/0006-easing-for-a-scroll-driven-clock.md)).

`from.progress` and `to.progress` are each scene's own 0..1 through its **whole** range, not the
band's. They keep advancing across the band, which is what stops Ken Burns from visibly jumping
scale at a band edge.

## 6. Check the arithmetic and the result

```bash
npm run model                       # the resolved ranges at a 900px viewport
npm run build && npm run preview
node pipeline/verify.mjs http://localhost:4173 tmp/verify
```

`verify.mjs` reports frame cost per band, so a new transition that is expensive shows up as its own
row rather than being averaged away.

Watch the **solo span** in `npm run model`. A scene whose solo span is short arrives and starts
dissolving almost at once — that is why scenes 06 and 07 are 1.7 viewports rather than 1.4, and a
test pins the minimum.

---

## What you did not have to touch

`main.js`, `renderer.js`, `bitmap-store.js`, `viewport.js`, `cover-fit.js`, `index.html`, the CSS.
The runtime reads the count, the ids, the widths, the formats and the intrinsic dimensions out of
`manifest.json` at boot. It does not know how many scenes there are until it asks.
