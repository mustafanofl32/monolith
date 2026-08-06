# 1. Composite the scenes on one canvas, not as stacked DOM layers

**Status:** accepted

## Context

Seven full-screen images have to blend into one another as the page scrolls. The obvious approach
is seven absolutely-positioned `<img>` elements and a scroll handler that animates `opacity`.

## Decision

One `<canvas>`. Both scenes for a transition are decoded to `ImageBitmap` and drawn into a single
2D context each frame with `drawImage`.

## Why

Two of the six transitions cannot be expressed as opacity at all. `mask-wipe-up` is a hard-edged
boundary travelling up the frame with the outgoing scene fully opaque on one side and fully absent
on the other; `split-horizontal` cuts the outgoing scene into two halves that separate. CSS can
approximate the first with an animated `clip-path` and the second with two duplicated elements, but
then two of the six transitions are a different mechanism from the other four, with a different
performance profile and a different set of bugs.

Layer count is the other half of it. Seven full-screen composited layers each get their own GPU
texture; at 2560×1440 that is roughly 14.7 MB of VRAM per layer whether or not it is visible. The
canvas holds exactly one destination surface, and residency is managed explicitly (ADR 8).

## Cost

- Type on canvas would be unselectable and invisible to a screen reader, so the type layer stays in
  the DOM and is positioned over the canvas — two coordinate systems to keep in agreement.
- No CSS transition or animation applies. Every curve is evaluated in JS (ADR 6).
- The canvas backing store must be resized manually on every real viewport change.
- Images are decoded twice conceptually: once by the browser into a bitmap, once per frame into the
  canvas. The second is a GPU blit, and it measures at 0.1–0.3 ms p50 (see README).

## Alternatives rejected

- **Stacked `<img>` with opacity.** Cannot express the wipe or the split; seven compositor layers.
- **WebGL.** Would make every transition trivial and add a shader pipeline, a context-loss path, and
  a fallback for machines that block WebGL — for six transitions that 2D canvas already runs in
  under a millisecond.
- **CSS `cross-fade()` / `mask-image`.** Patchy support and no way to drive them from a smoothed
  scroll value at frame rate without writing the same JS loop anyway.
