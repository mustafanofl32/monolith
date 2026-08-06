/**
 * Cover-fit geometry for drawImage.
 *
 * Computes the source rectangle to sample so that a bitmap fills the destination completely at any
 * aspect ratio, without distortion and without letterboxing. Cropping happens on the source side
 * rather than by scaling the destination, so a `scale` above 1 (Ken Burns) tightens the crop
 * instead of pushing pixels outside the canvas.
 *
 * Aspect comes from the bitmap's own dimensions, which come from the manifest. Nothing here
 * assumes 16:9 — 01-void is 1.791809:1 after its crop and the other six are 1.791667:1, and a
 * hardcoded ratio would shave a hairline off one of them at 2560w.
 */

/**
 * @param sw,sh   source bitmap dimensions
 * @param dw,dh   destination (canvas backing store) dimensions
 * @param scale   >= 1. Zooms in by tightening the source window.
 * @param panX,panY  -1..1, offset of the source window within the available slack.
 */
export function coverRect(sw, sh, dw, dh, scale = 1, panX = 0, panY = 0) {
  const destAspect = dw / dh;
  const srcAspect = sw / sh;

  // The largest source window with the destination's aspect ratio.
  let winW;
  let winH;
  if (srcAspect > destAspect) {
    // Source is wider: full height, crop the sides.
    winH = sh;
    winW = sh * destAspect;
  } else {
    winW = sw;
    winH = sw / destAspect;
  }

  // Ken Burns tightens the window rather than enlarging the drawn image.
  winW /= scale;
  winH /= scale;

  const slackX = sw - winW;
  const slackY = sh - winH;

  const sx = slackX * 0.5 * (1 + clamp(panX));
  const sy = slackY * 0.5 * (1 + clamp(panY));

  return {
    sx: Math.max(0, Math.min(sx, slackX)),
    sy: Math.max(0, Math.min(sy, slackY)),
    sw: winW,
    sh: winH,
    dx: 0,
    dy: 0,
    dw,
    dh,
  };
}

function clamp(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * Ken Burns scale for a scene, from its own 0..1 progress.
 *
 * 1.00 -> 1.06 across the scene's whole range, and linear on purpose. Easing it would make the
 * drift accelerate somewhere, which is noticeable; a constant creep reads as presence rather than
 * as motion. Driven by the scene's own progress, not the band's, so it keeps advancing smoothly
 * through a transition instead of restarting at the band edge.
 */
export function kenBurnsScale(sceneProgress) {
  return 1 + 0.06 * clamp01(sceneProgress);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
