// Every text/background pair of every component in DESIGN.md, against WCAG's
// 4.5:1 (text) or 3:1 (a graphic, see GRAPHIC_SUFFIX). The linter of
// @google/design.md only warns; this fails a test.
// Same file in aule-sw and aule-store.

const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const over = (fg, bg) => {
  const a = fg.a ?? 1;
  return a >= 1 ? fg : { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
};
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A component named *-stroke is a graphic (a border, an icon); the rest is text. */
export const GRAPHIC_SUFFIX = "-stroke";
export const MIN_TEXT = 4.5;
export const MIN_GRAPHIC = 3;

/**
 * { component, text, background, ratio, min } for each component that has both.
 * A colour with transparency is laid over its background first.
 */
export function pairs(state) {
  const out = [];
  for (const [component, def] of state.components) {
    const text = def.properties.get("textColor");
    const background = def.properties.get("backgroundColor");
    if (text?.type === "color" && background?.type === "color") {
      const graphic = component.endsWith(GRAPHIC_SUFFIX);
      out.push({
        component,
        text: text.hex,
        background: background.hex,
        ratio: ratio(over(text, background), background),
        min: graphic ? MIN_GRAPHIC : MIN_TEXT,
      });
    }
  }
  return out;
}

export function contrastFailures(state) {
  return pairs(state).filter((p) => p.ratio < p.min);
}
