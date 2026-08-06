# 6. Different easing curves because the user is the clock

**Status:** accepted

## Context

`cubic-bezier(0.16, 1, 0.3, 1)` — expo-out — is the house curve for tasteful UI motion, and it was
the first thing reached for on the transitions.

## Decision

Transitions use two flatter curves. Expo-out is kept, but only for time-driven motion (the
preloader fade, the type reveal), never for anything driven by scroll position.

```js
export const EXPO_OUT   = [0.16, 1, 0.3, 1];    // time-driven only
export const TRAVEL_OUT = [0.62, 0.04, 0.34, 1]; // wipes and splits — 0.556 at t=0.5
export const BLEND_OUT  = [0.55, 0.06, 0.3, 1];  // dissolves        — 0.657 at t=0.5
export const SCALE_OUT  = [0.22, 1, 0.36, 1];
```

## Why

Expo-out reaches **0.972 by t = 0.5**. For a time-driven animation that is the point: it feels
responsive because it resolves early and the tail is a settle the eye reads as physics.

Under a scroll-driven clock the tail is not a settle — it is the middle of the gesture. The user
supplies `t` directly, so 97% of the transition happened in the first ~15% of the band and the
remaining 85% of their scrolling produced no visible change. Screenshots at the band midpoint showed
it plainly: the mask wipe had no visible edge, and the horizontal split was already fully open.

`TRAVEL_OUT` at 0.556 and `BLEND_OUT` at 0.657 keep the movement distributed across the band the
user is actually scrolling through. A test pins this (`tests/geometry.test.js`).

## Cost

- Two extra named curves and a rule about which applies where.
- The transitions are less "snappy" in isolation. That is correct here and would be wrong in a
  button.
- `cubicBezier()` needs a real solver — Newton-Raphson with a bisection fallback, because
  Newton stalls in expo-out's flat tail, which is exactly the region being evaluated.

## Alternatives rejected

- **Expo-out everywhere.** Produced transitions with no visible middle.
- **Linear.** Honest and mechanical; the band edges become visible as a change in rate.
- **Reducing band length to compensate.** Would make expo-out's front-loading less obvious by
  shortening the dead tail, at the cost of every transition being abrupt.
