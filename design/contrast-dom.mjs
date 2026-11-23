// The contrast of what a page really paints: the computed style of every piece
// of text in a real browser, in the state the page is in (a disabled button, an
// error alert), with transparency and `opacity` laid over what is behind. The
// test of DESIGN.md measures the tokens; this measures the pages, and is what
// catches `disabled:opacity-60` or a colour that never came from a token.
// Same file in aule-sw and aule-store.

/** Runs in the page. Returns every text element with its final colours and ratio. */
export function measureInPage() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // Any CSS colour (rgb, oklab, color-mix results...) as 8-bit RGBA.
  const parse = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const over = (fg, bg) => {
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  };
  const mix = (outside, inside, o) => ({
    r: inside.r * o + outside.r * (1 - o),
    g: inside.g * o + outside.g * (1 - o),
    b: inside.b * o + outside.b * (1 - o),
    a: 1,
  });
  const lum = ({ r, g, b }) => {
    const c = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = ({ r, g, b }) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      const id = e.id ? `#${e.id}` : "";
      const cls = typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      parts.unshift(e.tagName.toLowerCase() + id + cls);
    }
    return parts.join(" > ");
  };

  const out = [];
  const white = { r: 255, g: 255, b: 255, a: 1 };
  for (const el of document.body.querySelectorAll("*")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own.length) continue;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "OPTION"].includes(el.tagName)) continue;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.visibility === "hidden" || style.display === "none" || rect.width <= 1 || rect.height <= 1) continue;

    // The chain from the page to the element.
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.unshift(e);
    const styles = chain.map((e) => getComputedStyle(e));
    if (styles.some((s) => s.backgroundImage !== "none")) {
      out.push({ skipped: "background-image", where: path(el), text: own[0].textContent.trim().slice(0, 40) });
      continue;
    }
    // Everything above the outermost faded element (or the element itself) is the outside.
    let start = styles.findIndex((s) => parseFloat(s.opacity) < 1);
    if (start === -1) start = chain.length - 1;
    let outside = white;
    for (let i = 0; i < start; i++) outside = over(parse(styles[i].backgroundColor), outside);
    let inside = outside;
    let opacity = 1;
    for (let i = start; i < chain.length; i++) {
      inside = over(parse(styles[i].backgroundColor), inside);
      opacity *= parseFloat(styles[i].opacity);
    }
    const text = over(parse(style.color), inside);
    const background = mix(outside, inside, opacity);
    const foreground = mix(outside, text, opacity);
    out.push({
      where: path(el),
      text: own[0].textContent.trim().slice(0, 40),
      color: hex(foreground),
      background: hex(background),
      ratio: ratio(foreground, background),
      size: parseFloat(style.fontSize),
      opacity,
    });
  }
  return out;
}

/** Every piece of text under `min`, as readable lines. */
export async function contrastProblems(page, min = 4.5) {
  // What is measured is where the page ends up, not the middle of a transition.
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  const all = await page.evaluate(measureInPage);
  const measured = all.filter((m) => !m.skipped);
  return {
    measured: measured.length,
    skipped: all.length - measured.length,
    problems: measured
      .filter((m) => m.ratio < min)
      .map((m) => `${m.where} "${m.text}": ${m.color} on ${m.background} is ${m.ratio.toFixed(2)}:1 (needs ${min})`),
  };
}

/**
 * Runs in the page. The edge of every form control (input, select, text area,
 * check box, radio) against what is around it: WCAG 1.4.11 asks 3:1. A control
 * that is visually hidden and drawn by the element after it (a chip, a card that
 * stands for a choice) is measured on that element. Without a border, the fill
 * has to do it.
 */
export function measureControlsInPage() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const parse = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = ({ r, g, b }) => {
    const c = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = ({ r, g, b }) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 3; e = e.parentElement) {
      parts.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/)[0] : ""));
    }
    return parts.join(" > ");
  };
  const out = [];
  for (const input of document.body.querySelectorAll("input, select, textarea")) {
    if (["hidden", "submit", "button", "reset", "image", "range", "color", "file"].includes(input.type)) continue;
    const own = getComputedStyle(input);
    const proxy = parseFloat(own.opacity) === 0 || (own.position === "absolute" && own.pointerEvents === "none");
    const el = proxy ? input.nextElementSibling ?? input.parentElement : input;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width <= 1 || rect.height <= 1) continue;
    const ancestors = [];
    for (let x = el.parentElement; x; x = x.parentElement) ancestors.unshift(x);
    let outside = { r: 255, g: 255, b: 255, a: 1 };
    for (const x of ancestors) outside = over(parse(getComputedStyle(x).backgroundColor), outside);
    const width = parseFloat(style.borderTopWidth);
    const bordered = width > 0 && style.borderTopStyle !== "none" && style.borderTopStyle !== "hidden";
    const edge = bordered ? over(parse(style.borderTopColor), outside) : over(parse(style.backgroundColor), outside);
    out.push({
      where: path(input) + (proxy ? " (drawn by the next element)" : ""),
      type: input.tagName === "INPUT" ? input.type : input.tagName.toLowerCase(),
      how: bordered ? `border ${hex(edge)}` : `no border, fill ${hex(edge)}`,
      ratio: ratio(edge, outside),
      outside: hex(outside),
    });
  }
  return out;
}

/** Every control whose edge is under `min` (3:1), as readable lines. */
export async function controlProblems(page, min = 3) {
  const all = await page.evaluate(measureControlsInPage);
  return {
    measured: all.length,
    problems: all.filter((c) => c.ratio < min).map((c) => `${c.where} [${c.type}]: ${c.how} on ${c.outside} is ${c.ratio.toFixed(2)}:1 (needs ${min})`),
  };
}
