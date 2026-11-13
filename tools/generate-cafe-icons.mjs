// MasalaPOS Cafe launcher and splash icons: the MasalaPOS "M" in ink on the website orange.
//   node tools/generate-cafe-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const target = new URL("../apps/cafe-android/assets/images/", import.meta.url);
mkdirSync(target, { recursive: true });
const ORANGE = [245, 138, 7, 255], INK = [28, 23, 20, 255], CLEAR = [0, 0, 0, 0], WHITE = [255, 255, 255, 255];

function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const payload = Buffer.concat([Buffer.from(type), data]); const size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload)); return Buffer.concat([size, payload, crc]); }
// The same "M" outline as the Captain app, in a 108-unit box; its 36..72 extent sits inside the adaptive-icon safe zone.
const M_MARK = [[36,32],[46,32],[54,48],[62,32],[72,32],[72,76],[62,76],[62,50],[54,64],[46,50],[46,76],[36,76]];
function inMark(px, py) { let inside = false; for (let i = 0, j = M_MARK.length - 1; i < M_MARK.length; j = i++) { const [xi, yi] = M_MARK[i], [xj, yj] = M_MARK[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside; } return inside; }

/** 4x4 supersampling keeps the diagonal edges smooth. */
function png(name, size, ground, ink) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let hits = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inMark(((x + (sx + 0.5) / 4) / size) * 108, ((y + (sy + 0.5) / 4) / size) * 108)) hits++;
    const t = hits / 16;
    const px = ground.map((g, i) => Math.round(g * (1 - t) + ink[i] * t));
    pixels.set(px, y * (size * 4 + 1) + 1 + x * 4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  writeFileSync(new URL(name, target), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
}

png("icon.png", 1024, ORANGE, INK);
png("android-icon-foreground.png", 432, CLEAR, INK);
png("android-icon-monochrome.png", 432, CLEAR, WHITE);
png("splash-icon.png", 512, CLEAR, INK);
console.log(`MasalaPOS Cafe icons written to ${fileURLToPath(target)}`);
