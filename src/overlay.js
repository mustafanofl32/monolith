/**
 * The finish layer that lives in the DOM rather than on the canvas: chapter type, its parallax,
 * the scroll progress line, and the preloader.
 *
 * Type is DOM, not canvas, on purpose — it stays selectable, translatable, accessible to a screen
 * reader, and crisp at any devicePixelRatio without re-rendering.
 */

import { cubicBezier } from './easing.js';

/** Text moves at 0.7 of scroll speed against the scene behind it. The single strongest depth cue
 *  available on a flat page, and the reason the type feels attached to the world rather than
 *  printed on the glass. */
const PARALLAX = 0.7;

/** Opacity ramp for chapter type. Slightly eased so text does not pop. */
const fade = cubicBezier([0.4, 0, 0.3, 1]);

/**
 * Chapter copy. Text appears over scenes 01, 04 and 07 only — the three empty compositions.
 * Never over 03 or 06, which are full-frame subjects with nowhere for type to sit.
 */
export const CHAPTERS = [
  {
    scene: 0,
    kicker: null,
    heading: 'MONOLITH',
    body: 'A study in scroll-driven light',
    align: 'center',
  },
  {
    scene: 3,
    kicker: null,
    heading: 'Every surface remembers',
    body: 'the light that shaped it.',
    align: 'left',
  },
  {
    scene: 6,
    kicker: null,
    heading: 'Seven images.',
    body: 'Mostafa Nofal — 2026',
    align: 'center',
  },
];

export function createOverlay({ root, model }) {
  const nodes = CHAPTERS.map((chapter) => {
    const el = document.createElement('article');
    el.className = `chapter chapter--${chapter.align}`;
    el.dataset.scene = String(chapter.scene);

    const h = document.createElement('h1');
    h.className = 'chapter__heading';
    // Each line is its own masked element: the clip-path reveal rises per line, which reads as
    // typesetting rather than as one block sliding up.
    h.innerHTML = `<span class="reveal"><span class="reveal__inner">${chapter.heading}</span></span>`;

    const p = document.createElement('p');
    p.className = 'chapter__body';
    p.innerHTML = `<span class="reveal"><span class="reveal__inner">${chapter.body}</span></span>`;

    el.append(h, p);
    root.append(el);
    return { chapter, el, inner: el.querySelectorAll('.reveal__inner') };
  });

  const progress = document.createElement('div');
  progress.className = 'progress';
  progress.innerHTML = '<i></i>';
  root.append(progress);
  const bar = progress.querySelector('i');

  /**
   * Solo span for a scene — the stretch where it is the only scene drawing.
   *
   * Type lives strictly inside this. Letting it cross a transition band would mean the heading is
   * legible over two blended images at once, which is where scroll type usually looks cheap.
   */
  function soloSpan(sceneIndex) {
    const scene = model.scenes[sceneIndex];
    const before = model.bands.find((b) => b.to === sceneIndex);
    const after = model.bands.find((b) => b.from === sceneIndex);
    return { start: before ? before.end : scene.start, end: after ? after.start : scene.end };
  }

  /**
   * The hero's solo span starts at scroll 0, so a scroll-driven fade-in would leave the title
   * invisible until the visitor scrolls — the one moment the piece has to introduce itself. It
   * enters on load instead: opacity is already 1 and the mask runs once off the CSS transition.
   */
  let entered = false;

  return {
    update(scrollY) {
      for (const { chapter, el, inner } of nodes) {
        const { start, end } = soloSpan(chapter.scene);
        const length = Math.max(1, end - start);
        const t = (scrollY - start) / length;
        const opensAtTop = start <= 0;

        // In and out inside the scene's own solo span, with a hold in the middle.
        let visible = 0;
        if (t >= 0 && t <= 1) {
          if (t < 0.28) visible = opensAtTop ? 1 : fade(t / 0.28);
          else if (t > 0.78) visible = fade(Math.max(0, (1 - t) / 0.22));
          else visible = 1;
        }

        el.style.opacity = visible.toFixed(3);
        el.style.visibility = visible > 0.001 ? 'visible' : 'hidden';

        // Parallax: the type lags the scroll, so the scene behind appears to sit further away.
        const offset = (scrollY - (start + end) / 2) * (1 - PARALLAX);
        el.style.transform = `translate3d(0, ${offset.toFixed(1)}px, 0)`;

        // Masked reveal driven by the same progress, so type is uncovered as it arrives. The hero
        // is held down until `intro()` releases it, so its mask animates instead of appearing done.
        const scrolled = visible > 0 ? Math.min(1, visible * 1.15) : 0;
        const rise = opensAtTop && !entered ? 0 : scrolled;
        for (const node of inner) {
          node.style.transform = `translate3d(0, ${((1 - rise) * 108).toFixed(1)}%, 0)`;
        }
      }

      bar.style.transform = `scaleX(${Math.min(1, Math.max(0, scrollY / model.totalScroll)).toFixed(4)})`;
    },

    /** Releases the hero's masked reveal. Called once, after the preloader clears. */
    intro() {
      if (entered) return;
      entered = true;
      this.update(window.scrollY);
    },

    setModel(next) {
      model = next;
    },
  };
}

/**
 * Preloader.
 *
 * The count is tied to real decode progress and nothing else. If the first two scenes are already
 * in cache it finishes instantly and the overlay is gone in one frame — a fake minimum duration
 * would be inventing a wait the user does not have.
 */
export function createPreloader(el) {
  const value = el.querySelector('[data-count]');
  let shown = 0;

  return {
    set(fraction) {
      const target = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      // Only ever counts up: a re-render that momentarily reports less should not run backwards.
      if (target > shown) shown = target;
      value.textContent = String(shown).padStart(3, '0');
    },
    done() {
      value.textContent = '100';
      el.classList.add('is-done');
      // Removed from the tree after the fade so it can never trap focus or intercept a scroll.
      setTimeout(() => el.remove(), 900);
    },
  };
}
