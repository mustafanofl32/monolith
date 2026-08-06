import './styles.css';
import { buildModel, describe } from './scroll-model.js';
import { createBitmapStore } from './bitmap-store.js';
import { createRenderer } from './renderer.js';
import { measureViewport, pickWidth, pickFormat } from './viewport.js';

const MANIFEST_URL = `${import.meta.env.BASE_URL}scenes/manifest.json`;

async function main() {
  const manifest = await fetch(MANIFEST_URL).then((r) => {
    if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`);
    return r.json();
  });
  const basePath = `${import.meta.env.BASE_URL}scenes`;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return renderStill(manifest, basePath);

  return renderScrubbed(manifest, basePath);
}

/**
 * Reduced motion: one deliberate still, and the page scrolls as an ordinary document.
 *
 * 03-reveal, per the brief — the composition that reads on its own without the sequence around
 * it. Not a degraded animation: no canvas, no RAF, no speculative decoding, and the document
 * takes its natural height instead of the model's 7.4 viewports of scroll.
 */
function renderStill(manifest, basePath) {
  const scene = manifest.scenes.find((s) => s.id === '03-reveal') ?? manifest.scenes[0];
  const format = scene.formats[0];
  const widths = scene.widths;

  document.body.dataset.mode = 'still';
  const stage = document.querySelector('[data-stage]');
  stage.innerHTML = '';

  const img = document.createElement('img');
  img.className = 'still';
  img.decoding = 'async';
  img.fetchPriority = 'high';
  img.width = scene.intrinsic.width;
  img.height = scene.intrinsic.height;
  img.style.backgroundColor = scene.averageColour;
  img.alt = '';
  img.src = `${basePath}/${scene.variants[format][String(widths[widths.length - 1])].file}`;
  img.srcset = widths
    .map((w) => `${basePath}/${scene.variants[format][String(w)].file} ${w}w`)
    .join(', ');
  img.sizes = '100vw';
  stage.append(img);

  document.querySelector('[data-spacer]')?.remove();

  window.__monolith = { mode: 'still', scene: scene.id };
}

async function renderScrubbed(manifest, basePath) {
  const canvas = document.querySelector('[data-canvas]');
  const spacer = document.querySelector('[data-spacer]');

  let viewport = measureViewport();
  let model = buildModel(viewport.height);
  spacer.style.height = `${model.documentHeight}px`;

  const store = createBitmapStore({ manifest, basePath, pickWidth, pickFormat, viewport });

  const renderer = createRenderer({ canvas, manifest, store, onState: null });

  // Progressive start: paint the average colour immediately so the hero is never blank, then
  // draw scene 01 the instant its bitmap decodes. Nothing waits for the whole sequence.
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = manifest.scenes[0].averageColour;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const firstPaint = performance.now();
  store.prime(0).then(() => {
    window.__monolith.firstSceneMs = performance.now() - firstPaint;
  });

  // Never animate off-screen. IntersectionObserver gates the loop rather than a scroll listener,
  // so a page scrolled past the stage costs nothing at all.
  const observer = new IntersectionObserver(
    ([entry]) => (entry.isIntersecting ? renderer.start() : renderer.stop()),
    { threshold: 0 },
  );
  observer.observe(canvas);

  // A backgrounded tab should not decode frames nobody is looking at.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) renderer.stop();
    else if (canvas.getBoundingClientRect().bottom > 0) renderer.start();
  });

  window.addEventListener(
    'resize',
    () => {
      if (!renderer.handleResize()) return;
      viewport = measureViewport();
      model = renderer.model;
      spacer.style.height = `${model.documentHeight}px`;
    },
    { passive: true },
  );

  window.__monolith = {
    mode: 'scrub',
    get model() {
      return renderer.model;
    },
    get metrics() {
      return renderer.metrics();
    },
    resetMetrics: () => renderer.resetMetrics(),
    get store() {
      return store.stats();
    },
    describe: () => describe(renderer.model),
    manifest,
  };
}

main().catch((error) => {
  console.error(error);
  const stage = document.querySelector('[data-stage]');
  if (stage) stage.innerHTML = `<p class="failure">${String(error.message)}</p>`;
});
