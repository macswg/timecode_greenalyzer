// One-shot: render 10 timecode-themed icon design options and a contact
// sheet to icon-previews/. Not committed — pick one and we'll wire it
// into build-icons.mjs.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'icon-previews');
mkdirSync(outDir, { recursive: true });

const SIZE = 192;
const GREEN  = [0, 255, 136];
const AMBER  = [255, 170, 0];
const RED    = [255, 59, 59];
const BLUE   = [59, 156, 255];
const CYAN   = [80, 220, 220];
const MAG    = [220, 80, 200];
const YEL    = [220, 220, 60];
const WHT    = [220, 220, 220];
const BG     = [10, 10, 10];
const BORDER = [40, 40, 40];

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8); ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10); ihdr.writeUInt8(0, 11); ihdr.writeUInt8(0, 12);
  const rowLen = w * 4;
  const raw = Buffer.alloc((rowLen + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (rowLen + 1)] = 0;
    rgba.copy(raw, y * (rowLen + 1) + 1, y * rowLen, (y + 1) * rowLen);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Drawing helpers (size-bound to SIZE for the per-icon canvas).
function newCanvas(w = SIZE, h = SIZE) { return { w, h, rgba: Buffer.alloc(w * h * 4) }; }
function set(cv, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 4;
  cv.rgba[i] = r; cv.rgba[i+1] = g; cv.rgba[i+2] = b; cv.rgba[i+3] = a;
}
function insideRounded(x, y, x0, y0, w, h, radius) {
  const lx = x - x0, ly = y - y0;
  if (lx < 0 || ly < 0 || lx >= w || ly >= h) return false;
  let cx = 0, cy = 0;
  if (lx < radius) cx = radius - lx;
  else if (lx >= w - radius) cx = lx - (w - radius - 1);
  if (ly < radius) cy = radius - ly;
  else if (ly >= h - radius) cy = ly - (h - radius - 1);
  return !(cx > 0 && cy > 0 && cx * cx + cy * cy > radius * radius);
}
function fillRoundedRect(cv, x0, y0, w, h, radius, r, g, b) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++)
      if (insideRounded(x, y, x0, y0, w, h, radius)) set(cv, x, y, r, g, b);
}
function fillRect(cv, x0, y0, w, h, r, g, b) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++)
      set(cv, x, y, r, g, b);
}
function strokeRect(cv, x0, y0, w, h, t, r, g, b) {
  fillRect(cv, x0, y0, w, t, r, g, b);
  fillRect(cv, x0, y0 + h - t, w, t, r, g, b);
  fillRect(cv, x0, y0, t, h, r, g, b);
  fillRect(cv, x0 + w - t, y0, t, h, r, g, b);
}
function fillCircle(cv, cx, cy, radius, r, g, b) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) set(cv, x, y, r, g, b);
    }
  }
}
function strokeCircle(cv, cx, cy, radius, thickness, r, g, b) {
  const ro2 = radius * radius;
  const ri2 = Math.max(0, (radius - thickness)) * Math.max(0, (radius - thickness));
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= ro2 && d2 >= ri2) set(cv, x, y, r, g, b);
    }
  }
}

// Common rounded-black panel + faint border.
function base() {
  const cv = newCanvas();
  const bgR = Math.round(SIZE * 0.22);
  fillRoundedRect(cv, 0, 0, SIZE, SIZE, bgR, BG[0], BG[1], BG[2]);
  const inset = Math.round(SIZE * 0.06);
  const innerSize = SIZE - inset * 2;
  const innerR = Math.max(0, bgR - inset);
  const bw = 2;
  for (let y = inset; y < SIZE - inset; y++) {
    for (let x = inset; x < SIZE - inset; x++) {
      const onIn  = insideRounded(x, y, inset, inset, innerSize, innerSize, innerR);
      const onOut = insideRounded(x, y, inset + bw, inset + bw, innerSize - 2 * bw, innerSize - 2 * bw, Math.max(0, innerR - bw));
      if (onIn && !onOut) set(cv, x, y, BORDER[0], BORDER[1], BORDER[2]);
    }
  }
  return cv;
}

// ───── 10 designs ─────────────────────────────────────────────────────

// 1. Colon dots (current). Two stacked green rounded squares.
function design_colon(cv) {
  const d = Math.round(SIZE * 0.18);
  const r = Math.round(d * 0.22);
  const x = Math.round((SIZE - d) / 2);
  const gap = Math.round(SIZE * 0.10);
  const yTop = Math.round((SIZE - (d * 2 + gap)) / 2);
  fillRoundedRect(cv, x, yTop, d, d, r, ...GREEN);
  fillRoundedRect(cv, x, yTop + d + gap, d, d, r, ...GREEN);
}

// 2. Seven-segment "88". Two LCD-style 8 digits, all segments lit.
function sevenSeg(cv, x0, y0, w, h, t) {
  // 7 bars laid out as rounded thin rects. All segments lit (digit "8").
  const r = Math.max(1, Math.round(t / 2));
  // top
  fillRoundedRect(cv, x0 + t, y0, w - 2 * t, t, r, ...GREEN);
  // middle
  fillRoundedRect(cv, x0 + t, y0 + Math.round(h / 2) - Math.round(t / 2), w - 2 * t, t, r, ...GREEN);
  // bottom
  fillRoundedRect(cv, x0 + t, y0 + h - t, w - 2 * t, t, r, ...GREEN);
  // top-left, top-right, bottom-left, bottom-right verticals
  const halfH = Math.round(h / 2);
  fillRoundedRect(cv, x0, y0 + t, t, halfH - t, r, ...GREEN);
  fillRoundedRect(cv, x0 + w - t, y0 + t, t, halfH - t, r, ...GREEN);
  fillRoundedRect(cv, x0, y0 + halfH, t, halfH - t, r, ...GREEN);
  fillRoundedRect(cv, x0 + w - t, y0 + halfH, t, halfH - t, r, ...GREEN);
}
function design_eights(cv) {
  const w = Math.round(SIZE * 0.30);
  const h = Math.round(SIZE * 0.55);
  const t = Math.max(4, Math.round(w * 0.14));
  const gap = Math.round(SIZE * 0.05);
  const x0 = Math.round((SIZE - (w * 2 + gap)) / 2);
  const y0 = Math.round((SIZE - h) / 2);
  sevenSeg(cv, x0, y0, w, h, t);
  sevenSeg(cv, x0 + w + gap, y0, w, h, t);
}

// 3. Clapperboard. Striped wedge across the top, plate below.
function design_clapper(cv) {
  const inset = Math.round(SIZE * 0.16);
  const w = SIZE - inset * 2;
  const stripeH = Math.round(SIZE * 0.18);
  const plateY = inset + stripeH + Math.round(SIZE * 0.02);
  // Stripe band — diagonal alternating white/black, drawn as parallelograms
  // approximated by checking x - skew*y per pixel.
  const skew = 0.5;
  const stripeW = Math.round(SIZE * 0.085);
  for (let y = 0; y < stripeH; y++) {
    for (let x = 0; x < w; x++) {
      const k = Math.floor((x + skew * y) / stripeW);
      const c = (k % 2 === 0) ? GREEN : [25, 25, 25];
      set(cv, inset + x, inset + y, c[0], c[1], c[2]);
    }
  }
  // Plate
  fillRoundedRect(cv, inset, plateY, w, SIZE - plateY - inset, 4, 22, 22, 22);
  strokeRect(cv, inset, plateY, w, SIZE - plateY - inset, 1, 60, 60, 60);
  // Two horizontal info lines on the plate (green)
  const lineY1 = plateY + Math.round(SIZE * 0.06);
  const lineY2 = plateY + Math.round(SIZE * 0.13);
  fillRect(cv, inset + 10, lineY1, w - 20, 4, ...GREEN);
  fillRect(cv, inset + 10, lineY2, w - 20, 4, ...GREEN);
}

// 4. Film reel. Outer ring + hub + four perforation holes around the rim.
function design_reel(cv) {
  const cx = SIZE / 2, cy = SIZE / 2;
  const outerR = Math.round(SIZE * 0.36);
  const ringT = Math.max(4, Math.round(SIZE * 0.035));
  strokeCircle(cv, cx, cy, outerR, ringT, ...GREEN);
  // hub
  fillCircle(cv, cx, cy, Math.round(SIZE * 0.07), ...GREEN);
  // spokes
  const spokeT = Math.max(3, Math.round(SIZE * 0.025));
  // 4 perforation holes (drawn as small dark circles on the rim band)
  const holeR = Math.round(SIZE * 0.045);
  const orbR = outerR - ringT * 2 - holeR - 2;
  const holes = 6;
  for (let i = 0; i < holes; i++) {
    const a = (i / holes) * Math.PI * 2;
    fillCircle(cv, cx + Math.cos(a) * orbR, cy + Math.sin(a) * orbR, holeR, ...GREEN);
  }
}

// 5. SMPTE color bars. Seven vertical stripes, classic 75% palette.
function design_bars(cv) {
  const inset = Math.round(SIZE * 0.16);
  const w = SIZE - inset * 2;
  const h = SIZE - inset * 2;
  const cols = [WHT, YEL, CYAN, GREEN, MAG, RED, BLUE];
  const stripeW = Math.floor(w / cols.length);
  for (let i = 0; i < cols.length; i++) {
    const x0 = inset + i * stripeW;
    const last = i === cols.length - 1;
    const sw = last ? (w - i * stripeW) : stripeW;
    const [r, g, b] = cols[i];
    fillRect(cv, x0, inset, sw, h, r, g, b);
  }
}

// 6. Biphase square wave. A pulse train across the icon.
function design_biphase(cv) {
  const inset = Math.round(SIZE * 0.18);
  const w = SIZE - inset * 2;
  const cy = Math.round(SIZE / 2);
  const amp = Math.round(SIZE * 0.18);
  const cycles = 4; // 4 high + 4 low across w
  const cellW = w / (cycles * 2);
  const t = Math.max(3, Math.round(SIZE * 0.025));
  // pattern: H L H H L H L H — make it look like biphase with mixed run lengths
  const pattern = [1, 0, 1, 1, 0, 1, 0, 0];
  let prevY = cy + (pattern[0] ? -amp : amp);
  for (let i = 0; i < pattern.length; i++) {
    const x0 = inset + Math.round(i * cellW);
    const x1 = inset + Math.round((i + 1) * cellW);
    const y = cy + (pattern[i] ? -amp : amp);
    // horizontal segment at y
    for (let x = x0; x < x1; x++) for (let dy = 0; dy < t; dy++) set(cv, x, y - t/2 + dy, ...GREEN);
    // vertical edge from prevY to y at x0 (skip first)
    if (i > 0 && y !== prevY) {
      const y1 = Math.min(prevY, y), y2 = Math.max(prevY, y);
      for (let yy = y1; yy <= y2; yy++) for (let dx = 0; dx < t; dx++) set(cv, x0 - t/2 + dx, yy, ...GREEN);
    }
    prevY = y;
  }
}

// 7. Vectorscope. Circle with crosshair and an off-center burst dot.
function design_scope(cv) {
  const cx = SIZE / 2, cy = SIZE / 2;
  const r = Math.round(SIZE * 0.34);
  const t = Math.max(2, Math.round(SIZE * 0.018));
  strokeCircle(cv, cx, cy, r, t, ...GREEN);
  // crosshair
  fillRect(cv, cx - r, cy - 1, r * 2, 2, 60, 90, 70);
  fillRect(cv, cx - 1, cy - r, 2, r * 2, 60, 90, 70);
  // burst point
  fillCircle(cv, cx + r * 0.45, cy - r * 0.4, Math.round(SIZE * 0.04), ...GREEN);
  // small tick at top
  fillRect(cv, cx - 2, cy - r - 6, 4, 6, ...GREEN);
}

// 8. Frame corners. Four L-shaped brackets — like "safe area" markers.
function design_corners(cv) {
  const inset = Math.round(SIZE * 0.18);
  const arm = Math.round(SIZE * 0.18);
  const t = Math.max(4, Math.round(SIZE * 0.035));
  // top-left
  fillRect(cv, inset, inset, arm, t, ...GREEN);
  fillRect(cv, inset, inset, t, arm, ...GREEN);
  // top-right
  fillRect(cv, SIZE - inset - arm, inset, arm, t, ...GREEN);
  fillRect(cv, SIZE - inset - t, inset, t, arm, ...GREEN);
  // bottom-left
  fillRect(cv, inset, SIZE - inset - t, arm, t, ...GREEN);
  fillRect(cv, inset, SIZE - inset - arm, t, arm, ...GREEN);
  // bottom-right
  fillRect(cv, SIZE - inset - arm, SIZE - inset - t, arm, t, ...GREEN);
  fillRect(cv, SIZE - inset - t, SIZE - inset - arm, t, arm, ...GREEN);
  // tiny center dot to suggest "frame center"
  fillCircle(cv, SIZE / 2, SIZE / 2, Math.round(SIZE * 0.02), ...GREEN);
}

// 9. Sprocket strip. Vertical column of film perforations down the center.
function design_sprocket(cv) {
  const holes = 5;
  const holeW = Math.round(SIZE * 0.16);
  const holeH = Math.round(SIZE * 0.10);
  const holeR = Math.round(SIZE * 0.02);
  const totalH = holes * holeH + (holes - 1) * Math.round(SIZE * 0.04);
  let y = Math.round((SIZE - totalH) / 2);
  const x = Math.round((SIZE - holeW) / 2);
  for (let i = 0; i < holes; i++) {
    fillRoundedRect(cv, x, y, holeW, holeH, holeR, ...GREEN);
    y += holeH + Math.round(SIZE * 0.04);
  }
  // film edge lines on either side
  const edgeT = 3;
  fillRect(cv, x - Math.round(SIZE * 0.05), Math.round(SIZE * 0.16), edgeT, SIZE - Math.round(SIZE * 0.32), 50, 50, 50);
  fillRect(cv, x + holeW + Math.round(SIZE * 0.05) - edgeT, Math.round(SIZE * 0.16), edgeT, SIZE - Math.round(SIZE * 0.32), 50, 50, 50);
}

// 10. Big "00". Two LCD-style rounded ring zeros side by side.
function design_zeros(cv) {
  const w = Math.round(SIZE * 0.30);
  const h = Math.round(SIZE * 0.55);
  const t = Math.max(5, Math.round(w * 0.20));
  const gap = Math.round(SIZE * 0.05);
  const x0 = Math.round((SIZE - (w * 2 + gap)) / 2);
  const y0 = Math.round((SIZE - h) / 2);
  function zero(x) {
    fillRoundedRect(cv, x, y0, w, h, Math.round(w * 0.35), ...GREEN);
    fillRoundedRect(cv, x + t, y0 + t, w - 2 * t, h - 2 * t, Math.max(0, Math.round(w * 0.25)), BG[0], BG[1], BG[2]);
  }
  zero(x0);
  zero(x0 + w + gap);
}

// ───── render all + contact sheet ────────────────────────────────────

const designs = [
  ['1-colon',     design_colon],
  ['2-eights',    design_eights],
  ['3-clapper',   design_clapper],
  ['4-reel',      design_reel],
  ['5-bars',      design_bars],
  ['6-biphase',   design_biphase],
  ['7-scope',     design_scope],
  ['8-corners',   design_corners],
  ['9-sprocket',  design_sprocket],
  ['10-zeros',    design_zeros],
];

const rendered = designs.map(([name, fn]) => {
  const cv = base();
  fn(cv);
  writeFileSync(join(outDir, `${name}.png`), encodePNG(cv.w, cv.h, cv.rgba));
  return { name, cv };
});

// Contact sheet: 2 rows × 5 cols
const COLS = 5, ROWS = 2, GAP = 24;
const sheetW = COLS * SIZE + (COLS + 1) * GAP;
const sheetH = ROWS * SIZE + (ROWS + 1) * GAP;
const sheet = newCanvas(sheetW, sheetH);
for (let i = 0; i < sheetW * sheetH; i++) {
  sheet.rgba[i * 4] = 22; sheet.rgba[i * 4 + 1] = 22; sheet.rgba[i * 4 + 2] = 24; sheet.rgba[i * 4 + 3] = 255;
}
rendered.forEach((cv, i) => {
  const col = i % COLS, row = Math.floor(i / COLS);
  const dx = GAP + col * (SIZE + GAP);
  const dy = GAP + row * (SIZE + GAP);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const si = (y * SIZE + x) * 4;
      const a = cv.cv.rgba[si + 3];
      if (a === 0) continue;
      const di = ((dy + y) * sheetW + (dx + x)) * 4;
      sheet.rgba[di]     = cv.cv.rgba[si];
      sheet.rgba[di + 1] = cv.cv.rgba[si + 1];
      sheet.rgba[di + 2] = cv.cv.rgba[si + 2];
      sheet.rgba[di + 3] = 255;
    }
  }
});
writeFileSync(join(outDir, 'contact-sheet.png'), encodePNG(sheetW, sheetH, sheet.rgba));
console.log(`wrote ${rendered.length} icons + contact-sheet.png in ${outDir}`);
