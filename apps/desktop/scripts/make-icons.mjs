// Generates the app and tray icons (no external art, no binary tools): the
// companion pointer arrow, ink on paper. Run once: `npm run icons`; the PNGs
// are committed (assets/, build/icon.png).
//   build/icon.png            1024² app icon (electron-builder makes .icns/.ico from it)
//   assets/tray.png, @2x      Windows/Linux tray (black arrow, white edge)
//   assets/trayTemplate.png, @2x  macOS menu bar template (black + alpha)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The pointer from the overlay (src/renderer/overlay.tsx), on a 28×32 box.
const ARROW = [
  [2, 2], [2, 26], [8.5, 20], [13, 30], [17.5, 28], [13, 18.5], [22, 18.5],
];

function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const n = SS * SS;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Arrow in unit space, scaled into a box.
function arrowAt(u, v, box) {
  const x = (u - box.x) / box.s * 28;
  const y = (v - box.y) / box.s * 28;
  return inside(ARROW, x, y);
}
// Grow the arrow by `e` (in arrow units) for an edge.
function arrowEdge(u, v, box, e) {
  for (const [dx, dy] of [[e, 0], [-e, 0], [0, e], [0, -e], [e, e], [-e, -e], [e, -e], [-e, e]]) {
    if (arrowAt(u + (dx * box.s) / 28, v + (dy * box.s) / 28, box)) return true;
  }
  return false;
}

const INK = [0, 0, 0];
const PAPER = [255, 255, 255];

// App icon: an ink tile (radius ~22%) with a paper arrow.
const appIcon = png(1024, (u, v) => {
  const m = 0.08, r = 0.2;
  const inTile = (() => {
    if (u < m || u > 1 - m || v < m || v > 1 - m) return false;
    const cx = Math.min(Math.max(u, m + r), 1 - m - r);
    const cy = Math.min(Math.max(v, m + r), 1 - m - r);
    return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
  })();
  if (!inTile) return [0, 0, 0, 0];
  const box = { x: 0.3, y: 0.24, s: 0.48 };
  return arrowAt(u, v, box) ? [...PAPER, 1] : [...INK, 1];
});

const trayBox = { x: 0.16, y: 0.02, s: 0.86 };
const tray = (size) => png(size, (u, v) => (arrowAt(u, v, trayBox) ? [...INK, 1] : arrowEdge(u, v, trayBox, 1.6) ? [...PAPER, 1] : [0, 0, 0, 0]));
const template = (size) => png(size, (u, v) => (arrowAt(u, v, trayBox) ? [...INK, 1] : [0, 0, 0, 0]));

mkdirSync(join(root, "build"), { recursive: true });
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "build/icon.png"), appIcon);
writeFileSync(join(root, "assets/tray.png"), tray(16));
writeFileSync(join(root, "assets/tray@2x.png"), tray(32));
writeFileSync(join(root, "assets/trayTemplate.png"), template(16));
writeFileSync(join(root, "assets/trayTemplate@2x.png"), template(32));
console.log("icons written");
