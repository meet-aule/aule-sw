// Every text/background pair of every component in DESIGN.md, against WCAG's
// 4.5:1 (text), 3:1 (a graphic, see GRAPHIC_SUFFIX) or 7:1 (small text on the esp32 screen). The linter of
// @google/design.md only warns; this fails a test.
// Same file in aule-sw and aule-store.

const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export const over = (fg, bg) => {
  const a = fg.a ?? 1;
  return a >= 1 ? { r: fg.r, g: fg.g, b: fg.b } : { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
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
// The small screen is read from close and at a glance: text of 40 px or less
// that is not a title (a component named *-title) needs 7:1.
export const MIN_ESP32_TEXT = 7;
export const ESP32_MAX_PX = 40;
const px = (d) => (d.unit === "rem" ? d.value * 16 : d.value);

export function minimumFor(component, def) {
  if (component.endsWith(GRAPHIC_SUFFIX)) return MIN_GRAPHIC;
  const size = def.properties.get("typography")?.fontSize;
  if (component.startsWith("esp32-") && !component.endsWith("-title") && size && px(size) <= ESP32_MAX_PX) {
    return MIN_ESP32_TEXT;
  }
  return MIN_TEXT;
}

/**
 * { component, text, background, ratio, min } for each component that has both.
 * A colour with transparency is laid over its background first (and a
 * transparent background over `paper`).
 */
export function pairs(state) {
  const out = [];
  for (const [component, def] of state.components) {
    const text = def.properties.get("textColor");
    const surface = def.properties.get("backgroundColor");
    if (text?.type === "color" && surface?.type === "color") {
      // A transparent background lies over the page, and the text over that.
      const background = over(surface, state.colors.get("paper") ?? { r: 255, g: 255, b: 255 });
      out.push({
        component,
        text: text.hex,
        background: surface.hex,
        ratio: ratio(over(text, background), background),
        min: minimumFor(component, def),
      });
    }
  }
  return out;
}

export function contrastFailures(state) {
  return pairs(state).filter((p) => p.ratio < p.min);
}
