/**
 * The render loop.
 *
 * Owns the canvas, the RAF loop, the scroll follower, and the frame-time instrumentation.
 */

import { buildModel, locate } from './scroll-model.js';
import { TRANSITION_FNS, drawScene } from './transitions.js';
import { kenBurnsScale } from './cover-fit.js';
import { measureViewport, isRealResize } from './viewport.js';

/**
 * Scroll follower coefficient, per frame at 60Hz.
 *
 * Started at the suggested 0.08 and it felt like the image was being dragged behind the scroll —
 * about 200ms to converge, which on a fast flick leaves the canvas visibly catching up after the
 * scrollbar has stopped. 0.14 keeps the wheel-notch quantisation smoothed while tracking closely
 * enough that the image feels attached to the input rather than towed by it.
 *
 * Applied through a dt-corrected exponential rather than as a raw per-frame factor, because a
 * fixed factor is frame-rate dependent: the same 0.14 converges twice as fast at 120Hz as at
 * 60Hz, which would make the feel of the site a property of the display.
 */
const FOLLOW = 0.14;
const FOLLOW_TAU = -(1 / 60) / Math.log(1 - FOLLOW);

/** Beyond this fraction of total scroll, stop chasing and jump — a scrollbar drag should land. */
const SNAP_FRACTION = 0.2;

export function createRenderer({ canvas, manifest, store, onState }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2d context unavailable');

  let viewport = measureViewport();
  let model = buildModel(viewport.height);
  let displayed = window.scrollY;
  let running = false;
  let raf = 0;
  let last = 0;

  // Frame times bucketed by phase. An overall average would be 60% dominated by the cheap
  // single-scene path and would hide a drop that only happens inside a transition — which is
  // exactly when the user is looking at the motion.
  const buckets = new Map();
  const record = (bucket, ms) => {
    let arr = buckets.get(bucket);
    if (!arr) buckets.set(bucket, (arr = []));
    if (arr.length < 4000) arr.push(ms);
  };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * viewport.dpr));
    const h = Math.max(1, Math.round(rect.height * viewport.dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function paintBackdrop(sceneIndex) {
    ctx.fillStyle = manifest.scenes[sceneIndex]?.averageColour ?? '#0b0b0c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function frame(now) {
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60;
    last = now;
    const started = performance.now();

    resize();

    const target = Math.min(Math.max(window.scrollY, 0), model.totalScroll);
    const distance = target - displayed;
    if (Math.abs(distance) > model.totalScroll * SNAP_FRACTION) {
      displayed = target;
    } else {
      displayed += distance * (1 - Math.exp(-dt / FOLLOW_TAU));
    }

    const at = locate(model, displayed);
    store.ensure(model, at.primary);

    const dw = canvas.width;
    const dh = canvas.height;
    const primaryBitmap = store.get(at.primary);

    // Paint-first: the manifest's average colour stands in until a bitmap exists, so the hero is
    // never blank and never flashes white.
    if (!primaryBitmap) paintBackdrop(at.primary);

    let bucket;
    if (at.band && store.get(at.secondary)) {
      bucket = `band ${at.band.from + 1}->${at.band.to + 1}`;
      TRANSITION_FNS[at.band.transition](
        ctx,
        { bitmap: primaryBitmap, progress: at.primaryProgress },
        { bitmap: store.get(at.secondary), progress: at.secondaryProgress },
        at.progress,
        dw,
        dh,
      );
    } else {
      bucket = 'solo';
      if (primaryBitmap) {
        drawScene(ctx, primaryBitmap, dw, dh, { scale: kenBurnsScale(at.primaryProgress) });
      }
    }

    record(bucket, performance.now() - started);
    onState?.({ at, displayed, target, model, viewport });

    if (running) raf = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    get running() {
      return running;
    },
    /**
     * Real resize only. Rebuilds the model and re-selects variants without touching scroll
     * position, so the sequence continues from where it was rather than restarting.
     */
    handleResize() {
      const next = measureViewport();
      if (!isRealResize(viewport, next)) return false;
      const scrollFraction = model.totalScroll ? displayed / model.totalScroll : 0;
      viewport = next;
      model = buildModel(viewport.height);
      displayed = scrollFraction * model.totalScroll;
      store.setViewport(viewport);
      resize();
      return true;
    },
    get model() {
      return model;
    },
    metrics() {
      const out = {};
      for (const [name, samples] of buckets) {
        const sorted = [...samples].sort((a, b) => a - b);
        const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
        out[name] = {
          frames: sorted.length,
          meanMs: +(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)).toFixed(3),
          p50Ms: +at(0.5).toFixed(3),
          p95Ms: +at(0.95).toFixed(3),
          worstMs: +(sorted[sorted.length - 1] ?? 0).toFixed(3),
          over16ms: sorted.filter((v) => v > 16.67).length,
        };
      }
      return out;
    },
    resetMetrics() {
      buckets.clear();
    },
  };
}
