// Reuse the desktop's original ForkFlow F mark, inside the maskable safe area.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
const target = new URL("../apps/ui/public/captain/", import.meta.url);
mkdirSync(target, { recursive: true });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const payload = Buffer.concat([Buffer.from(type), data]); const size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload)); return Buffer.concat([size, payload, crc]); }
for (const size of [192, 512]) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const xx = x / size, yy = y / size;
    const ink = xx >= .30 && xx < .42 && yy >= .25 && yy < .75 || xx >= .42 && xx < .70 && yy >= .25 && yy < .36 || xx >= .42 && xx < .63 && yy >= .46 && yy < .57;
    pixels.set(ink ? [255, 255, 255, 255] : [185, 35, 53, 255], y * (size * 4 + 1) + 1 + x * 4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  writeFileSync(new URL(`icon-${size}.png`, target), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
}
console.log(`Captain icons written to ${fileURLToPath(target)}`);
