/**
 * Decoded-bitmap residency.
 *
 * Holds previous / current / next decoded and closes everything else. The reason is arithmetic:
 * a decoded bitmap is width x height x 4 bytes regardless of how small its encoded file was, so
 * at 2560w that is 2560 x 1429 x 4 = 14.6 MB *each*. Three resident is 43.9 MB. All seven would
 * be 102 MB, which a low-end phone will not give you.
 *
 * `ImageBitmap` also holds memory outside the JS heap that the garbage collector will not reclaim
 * — it has to be told, via close(). A dropped reference here is a leak that never shows up in a
 * heap snapshot.
 */

import { residentSet } from './scroll-model.js';

export function createBitmapStore({ manifest, basePath, pickWidth, pickFormat, viewport }) {
  /** sceneIndex -> { bitmap, width, key } */
  const resident = new Map();
  /** key -> Promise, so a scene is never fetched twice concurrently. */
  const inFlight = new Map();

  let decodeCount = 0;
  let bytesFetched = 0;
  let currentViewport = viewport;

  const keyFor = (scene, width, format) => `${scene.id}@${width}.${format}`;

  async function load(sceneIndex) {
    const scene = manifest.scenes[sceneIndex];
    const width = pickWidth(scene, currentViewport);
    const format = await pickFormat(scene);
    const key = keyFor(scene, width, format);

    const held = resident.get(sceneIndex);
    if (held?.key === key) return held.bitmap;
    if (inFlight.has(key)) return inFlight.get(key);

    const variant = scene.variants[format][String(width)];
    const url = `${basePath}/${variant.file}`;

    const promise = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const blob = await response.blob();
      bytesFetched += blob.size;
      const bitmap = await createImageBitmap(blob);
      decodeCount++;

      // A variant swap may have landed while this was decoding.
      const previous = resident.get(sceneIndex);
      if (previous && previous.key !== key) previous.bitmap.close();

      resident.set(sceneIndex, { bitmap, width, key, format });
      inFlight.delete(key);
      return bitmap;
    })();

    inFlight.set(key, promise);
    return promise;
  }

  return {
    /** Bitmap for a scene if it is decoded and resident now, else null. Never blocks. */
    get(sceneIndex) {
      return resident.get(sceneIndex)?.bitmap ?? null;
    },

    has(sceneIndex) {
      return resident.has(sceneIndex);
    },

    /** Ensures prev/current/next are loading, and releases everything outside that window. */
    ensure(model, primary) {
      const wanted = residentSet(model, primary);

      for (const [index, entry] of resident) {
        if (!wanted.has(index)) {
          entry.bitmap.close();
          resident.delete(index);
        }
      }

      const promises = [];
      for (const index of wanted) {
        if (!resident.has(index)) promises.push(load(index).catch(() => null));
      }
      return promises;
    },

    /** Loads one scene and resolves when it is drawable. Used for first paint. */
    prime(sceneIndex) {
      return load(sceneIndex);
    },

    /**
     * Re-selects variants after a real resize. Existing bitmaps keep drawing until the new ones
     * decode, so the sequence never blanks and scroll position is untouched.
     */
    setViewport(next) {
      currentViewport = next;
    },

    stats() {
      let bytes = 0;
      for (const { bitmap } of resident.values()) bytes += bitmap.width * bitmap.height * 4;
      return {
        residentScenes: resident.size,
        decodedBytes: bytes,
        decodeCount,
        bytesFetched,
        widths: [...resident.values()].map((e) => e.width),
      };
    },

    destroy() {
      for (const { bitmap } of resident.values()) bitmap.close();
      resident.clear();
      inFlight.clear();
    },
  };
}
