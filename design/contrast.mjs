// Every text/background pair of every component in DESIGN.md, against WCAG's
// 4.5:1. The linter of @google/design.md only warns; this fails a test.
// Same file in aule-sw and aule-store.

const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** { component, text, background, ratio } for each component that has both. */
export function pairs(state) {
  const out = [];
  for (const [component, def] of state.components) {
    const text = def.properties.get("textColor");
    const background = def.properties.get("backgroundColor");
    if (text?.type === "color" && background?.type === "color") {
      out.push({ component, text: text.hex, background: background.hex, ratio: ratio(text, background) });
    }
  }
  return out;
}

export const MIN_RATIO = 4.5;

export function contrastFailures(state, min = MIN_RATIO) {
  return pairs(state).filter((p) => p.ratio < min);
}
