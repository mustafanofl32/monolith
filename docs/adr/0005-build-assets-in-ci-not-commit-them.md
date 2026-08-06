# 5. Build the 74 derived assets in CI rather than committing them

**Status:** accepted

## Context

The pipeline turns seven 15.6 MB JPEGs into 74 encoded files totalling 5.28 MB. Those files could be
committed, or regenerated on every build.

## Decision

`src/scenes/` (the seven sources) is committed. `src/scenes/graded/` and `public/scenes/` are
gitignored and rebuilt by CI on every push via `npm run assets`.

## Why

**The deterministic seed is what makes this safe.** The dither uses a fixed mulberry32 seed, the
encoder settings are fixed constants, and the manifest deliberately carries no timestamp. Given the
same seven sources, the pipeline produces byte-identical output every time — `tests/manifest.test.js`
asserts each variant's on-disk size against the byte count the manifest recorded. Without that,
building in CI would be a source of churn: every push would rewrite 74 binaries with cosmetically
different bytes and no way to tell a real change from encoder noise.

With it, the opposite is true — a size mismatch means somebody changed the encode settings, and the
test says so.

Committing the output instead would put 5.28 MB of derived binaries in every clone, make every
pipeline tweak a large binary diff, and let the committed files drift from what the pipeline
actually produces.

## Cost

- CI does real image work: grade + encode is ~2 minutes of the build.
- A clone is not runnable until `npm run assets` has been run once. The README says so, and
  `npm run dev` is preceded by it in the documented flow.
- `sharp` becomes a hard build dependency rather than an authoring convenience.

## Alternatives rejected

- **Git LFS.** Considered and dropped: 15.6 MB of sources is under any LFS threshold worth having,
  and LFS makes the repo require a non-default clone step for a portfolio piece people will browse
  rather than clone.
- **Committing `public/scenes/`.** 5.28 MB of derived binaries in history, and a permanent
  opportunity for them to disagree with the pipeline.
- **A prebuilt release artefact.** More machinery than a two-minute deterministic build.
