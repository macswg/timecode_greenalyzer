// Generate the bridge viewer's favicons / home-screen icons.
// Pure Node (zlib only) — no native deps. Run with: npm run build:icons
// Output: public/{favicon-32,apple-touch-icon,icon-192,icon-512}.png
// Design: rounded-rect black panel, faint grey inner border, two glowing
// green colon dots (the timecode separator) centered vertically.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

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

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // color type: RGBA
  ihdr.writeUInt8(0, 10);  // compression
  ihdr.writeUInt8(0, 11);  // filter
  ihdr.writeUInt8(0, 12);  // interlace
  const rowLen = size * 4;
  const raw = Buffer.alloc((rowLen + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rowLen + 1)] = 0; // filter byte: None
    rgba.copy(raw, y * (rowLen + 1) + 1, y * rowLen, (y + 1) * rowLen);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4); // transparent
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  };

  // Rounded-rect background. Returns true if (x,y) is inside a rounded
  // rectangle [x0..x0+w-1, y0..y0+h-1] with the given corner radius.
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

  const bgRadius = Math.round(size * 0.22);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (insideRounded(x, y, 0, 0, size, size, bgRadius)) set(x, y, 10, 10, 10);
    }
  }

  // Inner border (1 px at small sizes, 2 px at large) inset from edge.
  const inset = Math.max(2, Math.round(size * 0.06));
  const borderW = size >= 192 ? 2 : 1;
  const innerSize = size - inset * 2;
  const innerR = Math.max(0, bgRadius - inset);
  for (let y = inset; y < size - inset; y++) {
    for (let x = inset; x < size - inset; x++) {
      const onIn  = insideRounded(x, y, inset, inset, innerSize, innerSize, innerR);
      const onOut = insideRounded(x, y, inset + borderW, inset + borderW, innerSize - 2 * borderW, innerSize - 2 * borderW, Math.max(0, innerR - borderW));
      if (onIn && !onOut) set(x, y, 40, 40, 40);
    }
  }

  // Two colon dots — green, with a soft halo underneath.
  const dotSize = Math.max(4, Math.round(size * 0.18));
  const dotR    = Math.max(1, Math.round(dotSize * 0.22));
  const dotX    = Math.round((size - dotSize) / 2);
  const gap     = Math.round(size * 0.10);
  const totalH  = dotSize * 2 + gap;
  const dotYTop = Math.round((size - totalH) / 2);
  const dotYBot = dotYTop + dotSize + gap;

  // Halo: draw a slightly larger, dimmer version first.
  if (size >= 64) {
    const haloPad = Math.max(2, Math.round(size * 0.03));
    for (const dy of [dotYTop, dotYBot]) {
      for (let y = dy - haloPad; y < dy + dotSize + haloPad; y++) {
        for (let x = dotX - haloPad; x < dotX + dotSize + haloPad; x++) {
          if (insideRounded(x, y, dotX - haloPad, dy - haloPad, dotSize + 2 * haloPad, dotSize + 2 * haloPad, dotR + haloPad)) {
            set(x, y, 0, 90, 50);
          }
        }
      }
    }
  }
  for (const dy of [dotYTop, dotYBot]) {
    for (let y = dy; y < dy + dotSize; y++) {
      for (let x = dotX; x < dotX + dotSize; x++) {
        if (insideRounded(x, y, dotX, dy, dotSize, dotSize, dotR)) set(x, y, 0, 255, 136);
      }
    }
  }
  return encodePNG(size, rgba);
}

const targets = [
  [180, 'apple-touch-icon.png'],
  [192, 'icon-192.png'],
  [512, 'icon-512.png'],
  [32,  'favicon-32.png'],
];
for (const [size, name] of targets) {
  const png = renderIcon(size);
  writeFileSync(join(outDir, name), png);
  console.log(`wrote ${name.padEnd(24)} ${size}×${size}  ${png.length} bytes`);
}
