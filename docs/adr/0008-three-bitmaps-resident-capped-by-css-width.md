# 8. Keep three bitmaps resident, and cap the variant by CSS width rather than DPR

**Status:** accepted

## Context

A decoded `ImageBitmap` costs width × height × 4 bytes regardless of how small its encoded file was.
At 2560×1429 that is 14.6 MB each. Seven resident would be 102 MB.

## Decision

Previous, current and next only. Everything outside that window is `close()`d. Variant width is
chosen from `min(cssWidth × dpr, cap)` where `cap` is 1600 below a 900 px CSS viewport, and DPR is
itself clamped to 2.

## Why

**Three, not two:** scrolling upward has to be as smooth as scrolling downward, so the previous
scene must stay decoded. Three is the minimum that supports both directions without a decode during
a transition.

**`close()`, not garbage collection:** `ImageBitmap` holds memory outside the JS heap that the
collector will not reclaim. A dropped reference is a leak that does not appear in a heap snapshot.

**Capped by CSS width, not DPR alone:** a 390 px phone at DPR 3 demands 1170 physical pixels and,
uncapped, would be handed the 2560 variant — three of those is 43.9 MB on the device least able to
afford it. The cap costs nothing visible: 1600 across a 390 px viewport is still over 4× the CSS
resolution.

## Measured

| viewport | variants chosen | resident after first paint | peak resident |
|---|---|---|---|
| 375 × 812 | 640 | 1.7 MB | 2.6 MB |
| 768 × 1024 | 1024 | 4.5 MB | 6.7 MB |
| 1440 × 900 | 1600 | 10.9 MB | 16.4 MB |
| 2560 × 1440 | 1600 + 2560 | 19.4 MB | **41.9 MB** |

41.9 MB is the worst case and it belongs to a 2560 px desktop viewport, not to a phone.

## Cost

- A fast scroll that outruns decoding shows the previous scene held one beat longer rather than a
  blank. Verified: 137 scroll samples across slow, fast and upward passes produced 0 frames where
  the canvas failed to composite.
- A viewport resize across the 900 px boundary re-decodes. Existing bitmaps keep drawing until the
  replacements land, so nothing blanks.
- Jumping the scrollbar past two scenes decodes on arrival. The follower snaps rather than chases
  for jumps over 20% of total scroll, so this reads as a cut, not as a stutter.

## Alternatives rejected

- **All seven resident.** 102 MB at 2560w; a low-end phone will not give you that.
- **Two resident.** Upward scrolling decodes mid-transition.
- **DPR-driven selection alone.** Hands 2560 to a 390 px phone.
- **An LRU with a byte budget.** More machinery than a seven-item sequence with a known access
  pattern needs; the access pattern *is* prev/current/next.
