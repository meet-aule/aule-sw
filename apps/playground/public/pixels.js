// Aule's face in pixel art. The mascot is the same one, drawn by the same
// engine; here it is only drawn small, about SPRITE pixels a side, and shown
// enlarged a whole number of times, so each of its pixels is a square the eye
// can count. The page's #flat filter brings its shading down to a few tones
// and the style sheet outlines it a pixel wide. The arithmetic is pure, so the
// tests import it as it is.

/** About how many pixels a side the face is drawn with. */
export const SPRITE = 80;
// Under this many, a face is a smudge: it is drawn as the engine draws it.
const FEWEST = 48;
// The mascot's canvas has at most this many pixels for each of the page's.
const FINEST = 2;

/**
 * How to show a face in a box `box` pixels a side, on a screen with `ratio`
 * of its own pixels for each of the page's: the `side` it is drawn at, how
 * many `times` it is enlarged, and the width of a `line` one of its pixels
 * wide. Null where the box is too small for pixels to read.
 */
export function pixelsFor(box, ratio = 1) {
  const fine = Math.min(Math.max(ratio || 1, 1), FINEST);
  let times = Math.round((box * fine) / SPRITE);
  if (times < 2) times = (box * fine) / 2 >= FEWEST ? 2 : 0;
  if (!times) return null;
  return { side: Math.floor(box / times), times, line: 1 / fine };
}

/**
 * Has `mascot` drawn with all its pixels while `inPixels()` says it is shown in
 * them. The engine draws a mascot with fewer pixels when frames come slowly,
 * to keep up, and it takes a browser held at thirty frames a second (a laptop
 * or a tablet saving its battery) for a slow one. A face of SPRITE pixels has
 * nothing to save that way, and with half of them its mouth is gone.
 */
export function drawWhole(mascot, inPixels) {
  const tick = mascot.tick.bind(mascot);
  mascot.tick = (dt, time, quality) => tick(dt, time, inPixels() ? 1 : quality);
}

/**
 * Keeps a face in pixels as its box changes size. The face is the only child
 * of its box, and already has the character it will keep.
 */
export function pixelate(face) {
  const box = face.parentElement;
  if (face.mascot) drawWhole(face.mascot, () => box.classList.contains("pixels"));
  const fit = () => {
    const pixels = pixelsFor(Math.min(box.clientWidth, box.clientHeight), globalThis.devicePixelRatio);
    box.classList.toggle("pixels", Boolean(pixels));
    if (!pixels) return;
    box.style.setProperty("--side", `${pixels.side}px`);
    box.style.setProperty("--times", String(pixels.times));
    box.style.setProperty("--line", `${pixels.line}px`);
  };
  new ResizeObserver(fit).observe(box);
  fit();
}
