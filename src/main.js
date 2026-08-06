import './styles.css';
import { buildModel, describe } from './scroll-model.js';
import { createBitmapStore } from './bitmap-store.js';
import { createRenderer } from './renderer.js';
import { createOverlay, createPreloader, CHAPTERS } from './overlay.js';
import { measureViewport, pickWidth, pickFormat } from './viewport.js';

const MANIFEST_URL = `${import.meta.env.BASE_URL}scenes/manifest.json`;

async function main() {
  const manifest = await fetch(MANIFEST_URL).then((r) => {
    if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`);
    return r.json();
  });
  const basePath = `${import.meta.env.BASE_URL}scenes`;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduced ? renderStill(manifest, basePath) : renderScrubbed(manifest, basePath);
}

/**
 * Reduced motion: one deliberate still, and the page scrolls as an ordinary document.
 *
 * 03-reveal — the composition that reads on its own without the sequence around it. Not a degraded
 * animation: no canvas, no rAF, no speculative decoding, no grain, and the document takes its
 * natural height instead of the model's 7.4 viewports. The words are all here, so nothing is lost
 * except the motion the visitor asked not to see.
 */
function renderStill(manifest, basePath) {
  const scene = manifest.scenes.find((s) => s.id === '03-reveal') ?? manifest.scenes[0];
  const format = scene.formats[0];
  const widths = scene.widths;

  document.body.dataset.mode = 'still';
  document.querySelector('[data-preloader]')?.remove();

  const film = document.querySelector('[data-film]');
  film.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'still-wrap';

  const img = document.createElement('img');
  img.className = 'still';
  img.decoding = 'async';
  img.fetchPriority = 'high';
  img.width = scene.intrinsic.width;
  img.height = scene.intrinsic.height;
  img.style.backgroundColor = scene.averageColour;
  img.alt = 'A monolith emerging from darkness, lit from one side.';
  img.src = `${basePath}/${scene.variants[format][String(widths[widths.length - 1])].file}`;
  img.srcset = widths.map((w) => `${basePath}/${scene.variants[format][String(w)].file} ${w}w`).join(', ');
  img.sizes = '100vw';

  const head = document.createElement('h1');
  head.className = 'chapter__heading';
  head.textContent = CHAPTERS[0].heading;

  const sub = document.createElement('p');
  sub.textContent = CHAPTERS[0].body;

  const meta = document.createElement('div');
  meta.className = 'still-meta';
  for (const chapter of CHAPTERS.slice(1)) {
    const p = document.createElement('p');
    p.textContent = `${chapter.heading} ${chapter.body}`;
    meta.append(p);
  }

  wrap.append(head, sub, img, meta);
  film.append(wrap);

  window.__monolith = { mode: 'still', scene: scene.id };
}

async function renderScrubbed(manifest, basePath) {
  const canvas = document.querySelector('[data-canvas]');
  const spacer = document.querySelector('[data-spacer]');
  const typeRoot = document.querySelector('[data-type]');
  const preloader = createPreloader(document.querySelector('[data-preloader]'));

  const viewport = measureViewport();
  let model = buildModel(viewport.height);
  // The sticky stage already occupies one viewport of normal flow, so the spacer carries only the
  // scroll range itself. Setting it to documentHeight would leave a whole dead viewport at the end
  // where the stage has unstuck and scrolled away.
  spacer.style.height = `${model.totalScroll}px`;

  const store = createBitmapStore({ manifest, basePath, pickWidth, pickFormat, viewport });
  const overlay = createOverlay({ root: typeRoot, model });
  // Paint the pre-entrance state now: the hero's mask starts closed so it has something to rise
  // from once the preloader clears.
  overlay.update(window.scrollY);
  const renderer = createRenderer({ canvas, manifest, store, onState: null });

  // Paint the manifest's average colour immediately so the hero is never blank and never flashes.
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = manifest.scenes[0].averageColour;
  ctx.fillRect(0, 0, canvas.width || 1, canvas.height || 1);

  // Preloader counts real decodes of the first two scenes and nothing else. If they are cached it
  // finishes instantly — a minimum duration would be inventing a wait the user does not have.
  const navStart = performance.now();
  let decoded = 0;
  const firstTwo = [0, 1].map((i) =>
    store.prime(i).then(() => {
      decoded++;
      preloader.set(decoded / 2);
    }),
  );

  await Promise.allSettled(firstTwo);
  window.__monolith.firstSceneMs = performance.now() - navStart;
  preloader.done();
  renderer.start();
  // 300ms into the preloader's 700ms fade — late enough that the rise is not hidden behind an
  // opaque panel, early enough that the two movements overlap instead of queueing.
  setTimeout(() => overlay.intro(), 300);

  // Never animate off-screen. Element-level, so a page scrolled past the stage costs nothing.
  const observer = new IntersectionObserver(
    ([entry]) => (entry.isIntersecting ? renderer.start() : renderer.stop()),
    { threshold: 0 },
  );
  observer.observe(canvas);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) renderer.stop();
    else if (canvas.getBoundingClientRect().bottom > 0) renderer.start();
  });

  // Type and progress are driven from scroll directly, not from the renderer's smoothed position:
  // the line must track the page exactly, and type that lagged the scroll would read as a bug.
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      overlay.update(window.scrollY);
      ticking = false;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  overlay.update(window.scrollY);

  window.addEventListener(
    'resize',
    () => {
      if (!renderer.handleResize()) return;
      model = renderer.model;
      spacer.style.height = `${model.totalScroll}px`;
      overlay.setModel(model);
      overlay.update(window.scrollY);
    },
    { passive: true },
  );

  // defineProperties, not Object.assign. Object.assign *invokes* a getter in the source literal and
  // copies the resulting value, so `get metrics()` there would have frozen a load-time snapshot —
  // it silently reported an empty frame table and a two-bitmap residency forever.
  Object.defineProperties(window.__monolith, {
    mode: { value: 'scrub', enumerable: true, writable: true },
    manifest: { value: manifest, enumerable: true },
    resetMetrics: { value: () => renderer.resetMetrics(), enumerable: true },
    describe: { value: () => describe(renderer.model), enumerable: true },
    running: { get: () => renderer.running, enumerable: true },
    model: { get: () => renderer.model, enumerable: true },
    metrics: { get: () => renderer.metrics(), enumerable: true },
    store: { get: () => store.stats(), enumerable: true },
  });
}

// Declared before main runs so the preloader can write into it without a race.
window.__monolith = { mode: 'loading' };

main().catch((error) => {
  console.error(error);
  document.querySelector('[data-preloader]')?.remove();
  const film = document.querySelector('[data-film]');
  if (film) {
    film.innerHTML = `<p class="failure">The scenes could not be loaded: ${String(error.message)}</p>`;
  }
});
