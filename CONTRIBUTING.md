# Contributing

Thanks for looking. This is a portfolio piece rather than a library, so the useful contributions are
mostly corrections: a measurement that does not reproduce, a decision record whose reasoning has a
hole in it, a browser where it breaks.

## Setup

Node 20 or newer. Nothing else — no API keys, no Docker, no cloud account.

```bash
npm install
npm run assets     # required once: grades and encodes the seven sources (~2 min)
npm run dev
```

`npm run assets` is not optional. The 74 encoded variants are not committed
([ADR 5](docs/adr/0005-build-assets-in-ci-not-commit-them.md)), so `dev`, `build` and the contract
tests all need it to have run.

## Before you open a PR

```bash
npm test           # 37 tests
npm run build
npm run budget     # payload budget, the same check CI runs
```

The smoke tests need a build to exist and Playwright's Chromium to be installed. They skip
themselves with a printed reason if either is missing, so `npm test` still works on a fresh clone —
but they run in CI, so check them locally before pushing:

```bash
npx playwright install chromium
npm run build && npm test
```

## The rules this repo actually enforces

These are asserted by tests, not by convention. If you break one, CI will tell you.

1. **No scene filename outside `manifest.json`.** The runtime learns what exists by reading the
   manifest. Adding, renaming or removing a scene is a pipeline change, never a code change. There
   is exactly one allowed exception, and the test names it.
2. **The pipeline is byte-deterministic.** Fixed dither seed, fixed encoder settings, no timestamp
   in the manifest. Every variant's on-disk size is asserted against the byte count the manifest
   recorded. If you change an encoder setting, the test fails and you update the manifest — that is
   the intended workflow, not an obstacle.
3. **Nothing is upscaled.** No variant may be wider than its graded source.
4. **The payload budget is enforced, not documented.** Initial JS ≤ 40 kB gzipped and the hero asset
   ≤ 120 kB. `pipeline/check-budget.mjs` fails the build.
5. **No measured number is written down without a script that produces it.** If you add a claim to
   the README, add the script to `pipeline/` too.

## Adding or changing a scene

See [docs/adding-a-scene.md](docs/adding-a-scene.md). Short version: drop the file in
`src/scenes/`, add its id to the pipeline's ordered list, run `npm run assets`. No runtime code
changes.

## Style

- **Prefer the platform.** No framework, no animation library, no webfont. A new runtime dependency
  needs a one-line justification in the PR, and the answer is usually that it is not needed.
- **Comments explain *why*, not *what*.** A comment that restates the line below it is noise; a
  comment recording the alternative that was tried and failed is the valuable kind. Most of the
  comments in `src/` are of the second sort — please match that.
- **Non-obvious decisions get an ADR.** `docs/adr/`, numbered, with the cost stated and the rejected
  alternatives named. A decision record that lists no cost has not finished thinking.
- Conventional commits, in logical units.

## Reporting a wrong number

This is the most welcome kind of issue. Every figure in the README came from a script in
`pipeline/`, on one Windows 11 machine, in Chromium. If a number does not reproduce on your
hardware, that is worth knowing — say which script, what you got, and on what.

There is already one correction of this sort recorded in
[ADR 10](docs/adr/0010-exclude-the-generated-video.md), against my own earlier reporting. That is
the standard.
