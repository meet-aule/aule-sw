// Draws a visual (contracts/visuals/visual.v1.schema.json) as SVG. It is a
// plain function from the description to a string, with no network, no image
// model and no state, so a drawing appears the moment the tutor asks for it.
// Black on white only: the same descriptions go to an e-ink screen.

import { wordsIn } from "./i18n.js";

export const TOPIC = "aule.visual";

// The device's e-ink panel is 800x480 (Good Display GDEY075T7); drawing at
// that aspect so a layout here translates one-to-one to the device. W and H are
// the single source: fitted(), positions and the viewBox all follow them.
const W = 800;
const H = 480;
const INK = "#111";
// The 7.5" panel shows four greys, so a second group of things can be a real
// grey — clearer than an outline, and it still tells apart from the black ones.
const GREY = "#8a8a8a";
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Numbers in a drawing are for reading: no long decimal tails.
const show = (n) => String(Math.round(n * 100) / 100);

// A character of this font is a little over half as wide as it is tall. That
// estimate is enough to shrink a long text until it fits the room it has;
// nothing is ever cut off.
const GLYPH = 0.58;
const fitted = (value, size, room) =>
  Math.round(Math.max(8, Math.min(size, room / (Math.max(String(value).length, 1) * GLYPH))) * 10) / 10;

const text = (x, y, value, { size = 18, anchor = "middle", weight = 400, room = W - 40 } = {}) =>
  `<text x="${x}" y="${y}" font-size="${fitted(value, size, room)}" font-weight="${weight}" text-anchor="${anchor}">${escape(value)}</text>`;

const line = (x1, y1, x2, y2, width = 2) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${INK}" stroke-width="${width}"/>`;

const rect = (x, y, w, h, fill = "none") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${INK}" stroke-width="2"/>`;

// A tight a/b token like 3/4 is a fraction to stack. A division written with
// spaces ("12 / 4") keeps its slash and stays plain text, so the two read apart.
const FRACTION = /(\d+)\/(\d+)/g;

// A line split into runs: plain text, and {num, den} fractions, left to right.
function runs(raw) {
  const parts = [];
  let last = 0;
  for (const match of raw.matchAll(FRACTION)) {
    if (match.index > last) parts.push({ text: raw.slice(last, match.index) });
    parts.push({ num: match[1], den: match[2] });
    last = match.index + match[0].length;
  }
  if (last < raw.length) parts.push({ text: raw.slice(last) });
  return parts.length ? parts : [{ text: raw }];
}

// Numerator and denominator are a little smaller than the surrounding text.
const DIGIT = 0.78;

// How wide a run is at a given size. A stacked fraction is as wide as its taller
// column of digits plus a little air; it is also taller than a line of text,
// which the caller leaves vertical room for.
function runWidth(run, size) {
  if (run.text !== undefined) return run.text.length * size * GLYPH;
  return Math.max(run.num.length, run.den.length) * size * DIGIT * GLYPH + size * 0.5;
}

// Draws a line of text with any a/b written as a stacked fraction, the whole
// line centred on x with its text baseline at y.
function inlineMath(x, y, raw, size) {
  const parts = runs(raw);
  let left = x - parts.reduce((sum, run) => sum + runWidth(run, size), 0) / 2;
  let out = "";
  for (const run of parts) {
    const w = runWidth(run, size);
    if (run.text !== undefined) {
      out += `<text x="${left}" y="${y}" font-size="${size}" font-weight="600" text-anchor="start">${escape(run.text)}</text>`;
    } else {
      const cx = left + w / 2;
      const small = Math.round(size * DIGIT * 10) / 10;
      const bar = y - size * 0.3;
      const half = (w - size * 0.5) / 2;
      out +=
        `<text x="${cx}" y="${bar - size * 0.12}" font-size="${small}" font-weight="600" text-anchor="middle">${escape(run.num)}</text>` +
        line(cx - half, bar, cx + half, bar, 2) +
        `<text x="${cx}" y="${bar + small * 0.95}" font-size="${small}" font-weight="600" text-anchor="middle">${escape(run.den)}</text>`;
    }
    left += w;
  }
  return out;
}

function exercise(v, top) {
  const lines = v.lines;
  const base = lines.length <= 2 ? 44 : lines.length <= 4 ? 32 : 26;
  // One size for every line, shrunk until the widest fits — stacked fractions
  // measured too — so the statement reads as one block and nothing is cut off.
  const widest = Math.max(
    ...lines.map((raw) => runs(raw).reduce((sum, run) => sum + runWidth(run, base), 0)),
    1,
  );
  const size = Math.round(Math.min(base, (base * (W - 40)) / widest) * 10) / 10;
  const gap = size * 1.6;
  const first = top + (H - top - gap * (lines.length - 1)) / 2;
  return lines.map((raw, i) => inlineMath(W / 2, first + i * gap, raw, size)).join("");
}

// Transparent hit areas share the exact geometry of the ink underneath them.
// The light and dark outlines remain legible over either a filled or an empty cell.
function target(id, label, shape, board) {
  return `<g role="button" tabindex="0" data-part="${id}" aria-label="${escape(label)}" aria-pressed="${board.point === id}" data-marked="${board.mark === id}">` +
    `<${shape} class="board-hit"/><${shape} class="board-outline"/><${shape} class="board-trace"/></g>`;
}

function fractionBars(v, top, board) {
  const left = 60;
  const width = board && v.fractions.every(f => f.labelled === false) ? W - 2 * left : 440;
  const gap = board ? 26 : 18;
  const height = Math.min(board ? 84 : 52, (H - top - 30) / v.fractions.length - gap);
  const groupHeight = (height + gap) * v.fractions.length - gap;
  const firstY = board ? top + (H - top - groupHeight) / 2 : top + 10;
  return v.fractions
    .map((fraction, i) => {
      const y = firstY + i * (height + gap);
      const parts = fraction.denominator;
      const part = width / parts;
      // More parts than the bar holds (an improper fraction) fill the whole bar.
      // Shaded parts are separated by white lines, so they can still be counted.
      const shaded = Math.min(fraction.numerator, parts);
      let cells = "";
      for (let k = 0; k < parts; k += 1) {
        const x = left + k * part;
        cells += `<rect x="${x}" y="${y}" width="${part}" height="${height}" fill="${k < shaded ? INK : "#fff"}"/>`;
      }
      for (let k = 1; k < parts; k += 1) {
        const x = left + k * part;
        cells += `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + height}" stroke="${k < shaded ? "#fff" : INK}" stroke-width="2"/>`;
      }
      cells += rect(left, y, width, height);
      // Nothing is written next to a shape whose fraction is the question.
      if (board) {
        for (let k = 0; k < parts; k += 1) {
          const cell = k + 1;
          const label = wordsIn(board.language, "first.board_cell", { row: i + 1, cell, total: parts });
          cells += target(`r${i + 1}c${cell}`, label, `rect x="${left + k * part + 2}" y="${y + 2}" width="${part - 4}" height="${height - 4}"`, board);
        }
      }
      if (fraction.labelled === false) return cells;
      const label = fraction.label ?? `${fraction.numerator}/${fraction.denominator}`;
      return cells + text(left + width + 20, y + height / 2 + 8, label, { size: 24, anchor: "start", weight: 600, room: W - left - width - 30 });
    })
    .join("");
}

function fractionCircle(v, top) {
  // Same fractions as fraction_bars, drawn as pie slices: a circle cut into the
  // denominator, the numerator shaded solid and the rest left open. Black on
  // white, so a shaded slice reads on the e-ink screen.
  const items = v.fractions;
  const slot = (W - 40) / items.length;
  const radius = Math.min(slot * 0.34, (H - top - 56) * 0.46);
  const cy = top + (H - top) / 2 - 8;
  return items
    .map((fraction, i) => {
      const cx = 20 + slot * i + slot / 2;
      const parts = fraction.denominator;
      const shaded = Math.min(fraction.numerator, parts);
      let out = "";
      if (parts === 1) {
        out += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${shaded >= 1 ? INK : "#fff"}" stroke="${INK}" stroke-width="2"/>`;
      } else {
        for (let k = 0; k < parts; k += 1) {
          const a0 = -Math.PI / 2 + (k / parts) * 2 * Math.PI;
          const a1 = -Math.PI / 2 + ((k + 1) / parts) * 2 * Math.PI;
          const x0 = cx + radius * Math.cos(a0);
          const y0 = cy + radius * Math.sin(a0);
          const x1 = cx + radius * Math.cos(a1);
          const y1 = cy + radius * Math.sin(a1);
          const large = a1 - a0 > Math.PI ? 1 : 0;
          out += `<path d="M ${cx} ${cy} L ${show(x0)} ${show(y0)} A ${radius} ${radius} 0 ${large} 1 ${show(x1)} ${show(y1)} Z" fill="${k < shaded ? INK : "#fff"}" stroke="${INK}" stroke-width="2"/>`;
        }
      }
      if (fraction.labelled === false) return out;
      const label = fraction.label ?? `${fraction.numerator}/${fraction.denominator}`;
      return out + text(cx, cy + radius + 28, label, { size: 22, weight: 600, room: slot - 8 });
    })
    .join("");
}

function numberLine(v, top) {
  const left = 50;
  const right = W - 50;
  const y = top + (H - top) * 0.62;
  const span = v.to - v.from;
  if (!(span > 0)) throw new Error("number_line: to must be greater than from");
  const x = (n) => left + ((n - v.from) / span) * (right - left);
  // Too many ticks to read: keep every k-th one.
  const count = Math.floor(span / v.step + 1e-9);
  const every = Math.ceil(count / 20);
  let out = line(left, y, right, y, 3);
  for (let i = 0; i <= count; i += every) {
    const n = v.from + i * v.step;
    out += line(x(n), y - 9, x(n), y + 9) + text(x(n), y + 32, show(n), { size: 16 });
  }
  for (const mark of v.marks ?? []) {
    if (mark < v.from || mark > v.to) continue;
    out += `<circle cx="${x(mark)}" cy="${y}" r="8" fill="${INK}"/>`;
  }
  for (const jump of v.jumps ?? []) {
    const a = x(Math.max(v.from, Math.min(v.to, jump.from)));
    const b = x(Math.max(v.from, Math.min(v.to, jump.to)));
    const lift = Math.min(70, 24 + Math.abs(b - a) / 4);
    out += `<path d="M ${a} ${y - 12} Q ${(a + b) / 2} ${y - 12 - lift * 2} ${b} ${y - 12}" fill="none" stroke="${INK}" stroke-width="2" marker-end="url(#arrow)"/>`;
    if (jump.label) out += text((a + b) / 2, y - 22 - lift, jump.label, { size: 18, weight: 600, room: 160 });
  }
  return out;
}

function dotArray(v, top) {
  const cell = Math.min((W - 80) / v.columns, (H - top - 20) / v.rows, 56);
  const left = (W - cell * v.columns) / 2;
  const first = top + (H - top - cell * v.rows) / 2;
  let out = "";
  for (let r = 0; r < v.rows; r += 1) {
    for (let c = 0; c < v.columns; c += 1) {
      out += `<circle cx="${left + c * cell + cell / 2}" cy="${first + r * cell + cell / 2}" r="${cell * 0.32}" fill="${INK}"/>`;
    }
  }
  return out;
}

function counters(v, top) {
  const labelled = v.groups.some((group) => group.label);
  const gap = 28; // blank space between one group and the next
  const area = { width: W - 60, height: H - top - (labelled ? 52 : 24) };
  // Each group is laid out as a near-square block of counters.
  const blocks = v.groups.map((group) => {
    const columns = Math.max(1, Math.round(Math.sqrt(group.count)));
    return { ...group, columns, rows: Math.ceil(group.count / columns) };
  });
  const columns = blocks.reduce((sum, block) => sum + block.columns, 0);
  const rows = Math.max(...blocks.map((block) => block.rows));
  const cell = Math.min((area.width - gap * (blocks.length - 1)) / columns, area.height / rows, 64);
  const radius = cell * 0.36;
  const width = blocks.reduce((sum, block) => sum + block.columns * cell, 0) + gap * (blocks.length - 1);
  const firstRow = top + (area.height - rows * cell) / 2 + 6;
  let left = (W - width) / 2;
  let out = "";
  for (const block of blocks) {
    for (let i = 0; i < block.count; i += 1) {
      const cx = left + (i % block.columns) * cell + cell / 2;
      const cy = firstRow + Math.floor(i / block.columns) * cell + cell / 2;
      // "open" counters are grey, solid ones are black: two groups tell apart
      // on the four-grey e-ink screen without colour.
      out +=
        block.fill === "open"
          ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${GREY}" stroke="${INK}" stroke-width="2"/>`
          : `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${INK}"/>`;
    }
    if (block.label) {
      out += text(left + (block.columns * cell) / 2, firstRow + rows * cell + 26, block.label, {
        size: 18,
        weight: 600,
        room: block.columns * cell + gap,
      });
    }
    left += block.columns * cell + gap;
  }
  return out;
}

function table(v, top) {
  const columns = v.headers.length;
  const rows = [v.headers, ...v.cells.map((row) => Array.from({ length: columns }, (_, i) => row[i] ?? ""))];
  const width = Math.min(W - 60, columns * 170);
  const cell = width / columns;
  const height = Math.min(46, (H - top - 16) / rows.length);
  const left = (W - width) / 2;
  return rows
    .map((row, r) =>
      row
        .map(
          (value, c) =>
            rect(left + c * cell, top + 6 + r * height, cell, height) +
            text(left + c * cell + cell / 2, top + 6 + r * height + height / 2 + 6, value, {
              size: 18,
              weight: r === 0 ? 700 : 400,
              room: cell - 12,
            }),
        )
        .join(""),
    )
    .join("");
}

function barChart(v, top) {
  const base = H - 44;
  const left = 60;
  const slot = (W - left - 30) / v.bars.length;
  const tallest = Math.max(...v.bars.map((bar) => bar.value), 1);
  const scale = (base - top - 26) / tallest;
  return (
    line(left - 10, base, W - 20, base, 3) +
    v.bars
      .map((bar, i) => {
        const height = bar.value * scale;
        const x = left + i * slot + slot * 0.2;
        return (
          rect(x, base - height, slot * 0.6, height, INK) +
          text(x + slot * 0.3, base - height - 8, show(bar.value), { size: 16, weight: 600 }) +
          text(x + slot * 0.3, base + 24, bar.label, { size: 16, room: slot - 6 })
        );
      })
      .join("")
  );
}

function rectangle(v, top, board) {
  const room = { w: W - 220, h: H - top - 80 };
  const scale = Math.min(room.w / v.width, room.h / v.height);
  const w = Math.max(v.width * scale, 40);
  const h = Math.max(v.height * scale, 40);
  const x = (W - w) / 2;
  const y = top + (H - top - h) / 2 - 10;
  const unit = v.unit ? ` ${v.unit}` : "";
  const labelSize = board ? 32 : 20;
  const sides = [
    ["top", x, y, x + w, y],
    ["right", x + w, y, x + w, y + h],
    ["bottom", x, y + h, x + w, y + h],
    ["left", x, y, x, y + h],
  ];
  const targets = board ? sides.map(([id, x1, y1, x2, y2]) =>
    target(id, wordsIn(board.language, `first.board_${id}`), `line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`, board)).join("") : "";
  return (
    rect(x, y, w, h) +
    text(x + w / 2, y + h + (board ? 40 : 30), `${show(v.width)}${unit}`, { size: labelSize, weight: 600 }) +
    text(x + w + 14, y + h / 2 + 7, `${show(v.height)}${unit}`, { size: labelSize, anchor: "start", weight: 600, room: W - x - w - 24 }) + targets
  );
}

// A polygon is described by how to build it, never by pixels: a number of equal
// sides, the three lengths of a triangle, or its corners. All three become the
// same list of corners, so one drawing serves every shape there will ever be.
// Corners are in the shape's own units with y upwards, in order around it.
function corners(v) {
  if (v.regular) {
    // The bottom side lies flat and is side 1; the rest follow round.
    const n = v.regular;
    const first = -Math.PI / 2 - Math.PI / n;
    return Array.from({ length: n }, (_, i) => {
      const angle = first + (2 * Math.PI * i) / n;
      return [Math.cos(angle), Math.sin(angle)];
    });
  }
  if (v.sides) {
    const [base, left, right] = v.sides;
    const longest = Math.max(base, left, right);
    if (longest >= base + left + right - longest) throw new Error("those sides do not make a triangle");
    const x = (base * base + left * left - right * right) / (2 * base);
    return [[0, 0], [base, 0], [x, Math.sqrt(Math.max(left * left - x * x, 0))]];
  }
  return v.points;
}

// What is written next to side i (from corner i to the next one).
function sideLabel(v, i) {
  const unit = v.unit ? ` ${v.unit}` : "";
  if (v.sides) {
    // Given as base, left, right; the corners go base, right, left.
    const given = [0, 2, 1][i];
    return v.labels?.[given] ?? `${show(v.sides[given])}${unit}`;
  }
  if (v.labels?.[i] !== undefined) return v.labels[i];
  return v.regular && v.side && i === 0 ? `${show(v.side)}${unit}` : "";
}

function polygon(v, top) {
  const shape = corners(v);
  const xs = shape.map(([x]) => x);
  const ys = shape.map(([, y]) => y);
  const span = { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  if (!(span.w > 0 && span.h > 0)) throw new Error("those corners do not make a shape");
  const room = { w: W - 320, h: H - top - 110 };
  const scale = Math.min(room.w / span.w, room.h / span.h);
  const left = (W - span.w * scale) / 2;
  const bottom = top + (H - top + span.h * scale) / 2 - 12;
  const at = shape.map(([x, y]) => ({
    x: left + (x - Math.min(...xs)) * scale,
    y: bottom - (y - Math.min(...ys)) * scale,
  }));
  const n = at.length;
  // Which way round the corners go, to tell the outside of each side from the
  // inside and a corner that points in from one that points out.
  const turn = Math.sign(at.reduce((sum, p, i) => sum + p.x * at[(i + 1) % n].y - at[(i + 1) % n].x * p.y, 0));
  const towards = (from, to, length) => {
    const d = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: ((to.x - from.x) / d) * length, y: ((to.y - from.y) / d) * length };
  };

  let out = `<path d="M ${at.map((p) => `${p.x} ${p.y}`).join(" L ")} Z" fill="none" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`;
  for (let i = 0; i < n; i++) {
    const here = at[i];
    const next = at[(i + 1) % n];
    const before = at[(i + n - 1) % n];
    // A small square in every corner that is a right angle.
    const u = towards(here, next, 16);
    const w = towards(here, before, 16);
    const pointsOut = Math.sign((here.x - before.x) * (next.y - here.y) - (here.y - before.y) * (next.x - here.x)) === turn;
    if (pointsOut && Math.abs(u.x * w.x + u.y * w.y) < 0.5) {
      out += `<path d="M ${here.x + u.x} ${here.y + u.y} l ${w.x} ${w.y} l ${-u.x} ${-u.y}" fill="none" stroke="${INK}" stroke-width="1.5"/>`;
    }
    const label = sideLabel(v, i);
    if (!label) continue;
    // Outside the shape, level with the middle of its side.
    const mid = { x: (here.x + next.x) / 2, y: (here.y + next.y) / 2 };
    const out2 = { x: (turn * u.y) / 16, y: (-turn * u.x) / 16 };
    const anchor = out2.x > 0.35 ? "start" : out2.x < -0.35 ? "end" : "middle";
    const x = mid.x + out2.x * 14;
    const y = mid.y + out2.y * 14 + (out2.y > 0.35 ? 16 : out2.y < -0.35 ? -4 : 7);
    const space = anchor === "start" ? W - x - 12 : anchor === "end" ? x - 12 : W - 40;
    out += text(x, y, label, { size: 20, anchor, weight: 600, room: space });
  }
  return out;
}

// A clock face with its two hands. The short hand moves with the minutes, as
// on a real clock: at 3:30 it is halfway between the 3 and the 4.
function clock(v, top) {
  const cx = W / 2;
  const cy = top + (H - top) / 2;
  const r = Math.min((H - top) / 2 - 14, 190);
  const at = (turn, length) => [cx + Math.sin(turn * 2 * Math.PI) * length, cy - Math.cos(turn * 2 * Math.PI) * length];
  const minute = v.minute ?? 0;
  let out = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="${INK}" stroke-width="4"/>`;
  for (let tick = 0; tick < 60; tick += 1) {
    const [x1, y1] = at(tick / 60, r - (tick % 5 === 0 ? 14 : 7));
    const [x2, y2] = at(tick / 60, r - 2);
    out += line(x1, y1, x2, y2, tick % 5 === 0 ? 3 : 1);
  }
  for (let n = 1; n <= 12; n += 1) {
    const [x, y] = at(n / 12, r - 36);
    out += text(x, y + 9, n, { size: 26, weight: 600, room: 60 });
  }
  const hand = (turn, length, width) => {
    const [x, y] = at(turn, length);
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${INK}" stroke-width="${width}" stroke-linecap="round"/>`;
  };
  // Both hands stop short of the numbers, so none is covered.
  out += hand(((v.hour % 12) + minute / 60) / 12, r * 0.45, 9);
  out += hand(minute / 60, r - 62, 5);
  return out + `<circle cx="${cx}" cy="${cy}" r="8" fill="${INK}"/>`;
}

// The tune of the student's voice in a pronunciation drill, drawn by the
// agent from a measurement: the voiced stretches as a line around the
// speaker's own middle pitch, and an arrow for the way the end should go.
function contour(v, top) {
  const left = 60;
  const right = W - 140;
  const middle = top + (H - top) / 2;
  const half = (H - top) / 2 - 40;
  const x = (i) => left + (i / Math.max(1, v.count - 1)) * (right - left);
  const y = (semitones) => middle - (Math.max(-12, Math.min(12, semitones)) / 12) * half;
  let out = `<line x1="${left}" y1="${middle}" x2="${right}" y2="${middle}" stroke="${GREY}" stroke-width="2" stroke-dasharray="6 8"/>`;
  for (const segment of v.segments) {
    const points = segment.values.map((value, i) => `${x(segment.from + i)},${y(value)}`).join(" ");
    out += segment.values.length === 1
      ? `<circle cx="${x(segment.from)}" cy="${y(segment.values[0])}" r="6" fill="${INK}"/>`
      : `<polyline points="${points}" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  // Where the end should go: a grey arrow after the line.
  const rise = v.expected === "rising" ? -1 : 1;
  const ax = right + 40;
  out += `<path d="M ${ax} ${middle - rise * 50} L ${ax + 60} ${middle + rise * 50}" stroke="${GREY}" stroke-width="8" stroke-linecap="round" marker-end="url(#arrow)"/>`;
  return out;
}

const KINDS = {
  exercise,
  fraction_bars: fractionBars,
  fraction_circle: fractionCircle,
  number_line: numberLine,
  dot_array: dotArray,
  counters,
  table,
  bar_chart: barChart,
  rectangle,
  polygon,
  clock,
  contour,
};

/** The visual as an SVG document. Throws on a kind it does not know. */
export function renderVisual(visual, board = undefined) {
  const draw = KINDS[visual?.kind];
  if (!draw) throw new Error(`unknown kind of visual: ${visual?.kind}`);
  const top = visual.title ? 58 : 20;
  const title = visual.title ? text(W / 2, 38, visual.title, { size: 22, weight: 600 }) : "";
  const boardTitle = board && wordsIn(board.language, "first.board_title");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="${board ? "group" : "img"}" aria-label="${escape(visual.title ?? (board ? boardTitle : visual.kind))}" font-family="${FONT}" fill="${INK}">` +
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${INK}"/></marker></defs>` +
    `<rect width="${W}" height="${H}" fill="#fff"/>` +
    title +
    draw(visual, top, board) +
    "</svg>"
  );
}
