# 7. Measure the viewport height in JS; never derive scroll ranges from `dvh`

**Status:** accepted

## Context

Every scene length is expressed in viewport heights and resolved to pixels. The modern CSS answer is
`100dvh`, and `dvh` was proposed for this.

## Decision

Scroll ranges come from a single `window.innerHeight` measurement, cached and recomputed only on a
*real* resize. The stage's CSS layout uses `100svh` (with a `100vh` `@supports` fallback), and that
value never feeds the scroll model.

## Why

`dvh` is *defined* to track the dynamic viewport — it follows the mobile URL bar as it collapses and
expands. That is the right unit for "fill exactly what the user can see right now" and the wrong one
for anything durable, because scroll ranges derived from it shift mid-gesture: the user scrolls, the
URL bar collapses, every scene boundary moves underneath them, and the scene they were watching
jumps. `svh` and `lvh` are the stable pair. `innerHeight` is the layout viewport and behaves like
`lvh`, which is what the model wants.

A naive `resize` listener reintroduces the same bug, because URL-bar collapse fires one. So a resize
only counts when the width changed, or the height changed by more than 15% — URL-bar collapse is
typically 60–120 px (8–13%), an orientation change is far larger. Pinned in
`tests/geometry.test.js`.

`visualViewport` was also rejected for the model: it tracks the visible area and shrinks with the
URL bar, which is the same problem wearing a different API.

## Cost

- The model cannot be expressed in CSS at all; the spacer's height is set from JS.
- The 15% threshold is a heuristic. A device with unusually large chrome, or a desktop window
  dragged shorter by exactly 14%, will not rebuild until the next real resize. The consequence is
  cosmetic — scene ranges are slightly off for that session, nothing breaks.
- One measurement is taken before first paint, so it must not be taken while the page is still
  laying out.

## Alternatives rejected

- **`100dvh`.** Causes precisely the bug the requirement was written to prevent.
- **`100vh`.** The large viewport: on mobile the stage sits partly under the browser chrome.
- **Recompute on every `resize` event.** Fires on URL-bar collapse.
