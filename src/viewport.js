/**
 * Viewport measurement and variant selection.
 *
 * Two decisions live here, both about not trusting the obvious signal.
 *
 * VIEWPORT HEIGHT. Measured in JS and cached, recomputed only on a *real* resize. Not `100dvh`:
 * that unit is defined to track the collapsing mobile URL bar, so scroll ranges derived from it
 * move mid-gesture and every scene boundary shifts underneath the user. A naive `resize` listener
 * has the same problem, because URL-bar collapse fires one. So a resize only counts when the width
 * changed, or the height changed by more than 15% — URL-bar collapse is typically 60–120px
 * (8–13%), an orientation change is far larger.
 *
 * VARIANT WIDTH. Capped by CSS viewport width, not by devicePixelRatio alone. DPR alone is what
 * lets a 390px phone at DPR 3 ask for the 2560 variant: three resident bitmaps at 2560x1429x4 is
 * 43.9 MB, which is fine on a desktop and reckless on a low-end phone.
 */

/** Above this fraction, a height change is a real layout change rather than browser chrome. */
const REAL_RESIZE_THRESHOLD = 0.15;

/** DPR is useful but uncapped it doubles memory for detail nobody can resolve. */
const MAX_DPR = 2;

/** Below this CSS width, never reach past the 1600 variant. */
const NARROW_VIEWPORT = 900;
const NARROW_MAX_WIDTH = 1600;

export function measureViewport() {
  return {
    width: window.innerWidth,
    // visualViewport tracks the *visible* area and shrinks with the URL bar; innerHeight is the
    // layout viewport and behaves like lvh. The layout viewport is what the scroll model wants.
    height: window.innerHeight,
    dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR),
  };
}

/** True when the change is worth rebuilding the model for. */
export function isRealResize(previous, next) {
  if (!previous) return true;
  if (previous.width !== next.width) return true;
  const delta = Math.abs(next.height - previous.height) / Math.max(1, previous.height);
  return delta > REAL_RESIZE_THRESHOLD;
}

/**
 * Chooses the variant width for a scene.
 *
 * Picks the smallest available width that still covers the device's physical pixel demand, so a
 * 640px phone never downloads 2560. Falls back to the largest available when demand exceeds
 * everything on offer — 01-void has no 2560 variant at all, because its content is 2100px wide
 * after cropping and upscaling would invent pixels.
 */
export function pickWidth(scene, viewport) {
  const cap = viewport.width < NARROW_VIEWPORT ? NARROW_MAX_WIDTH : Infinity;
  const demand = Math.min(viewport.width * viewport.dpr, cap);

  const available = [...scene.widths].sort((a, b) => a - b);
  return available.find((w) => w >= demand) ?? available[available.length - 1];
}

/**
 * Chooses the format, honouring the manifest's per-scene priority order.
 *
 * 01-void and 07-return deliberately omit AVIF: on near-black dithered gradients AVIF's
 * rate-distortion machinery discards the dither and reintroduces banding, and it only matches
 * WebP's appearance at 25% over the first-paint budget. The manifest is the authority, not a
 * global format preference.
 */
export async function pickFormat(scene) {
  for (const format of scene.formats) {
    if (await formatSupported(format)) return format;
  }
  return scene.formats[scene.formats.length - 1];
}

const supportCache = new Map();

function formatSupported(format) {
  if (format === 'jpeg') return Promise.resolve(true);
  if (supportCache.has(format)) return supportCache.get(format);

  // A 1x1 probe of each codec. createImageBitmap rejects what the decoder cannot read, which is
  // the same code path the renderer uses — more reliable than canvas.toDataURL sniffing, which
  // reports *encode* support and can disagree with decode support.
  const probes = {
    avif:
      'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAMAAAAABNjb2xybmNseAACAAIABoAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgABogQEDQgMgkQAAAAB8dSLfI=',
    webp: 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
  };

  const probe = probes[format];
  if (!probe) return Promise.resolve(false);

  const result = fetch(probe)
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b))
    .then((bmp) => {
      bmp.close();
      return true;
    })
    .catch(() => false);

  supportCache.set(format, result);
  return result;
}
