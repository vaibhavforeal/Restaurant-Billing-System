import { createHash } from "node:crypto";
import { httpError } from "./http-error.js";

export const menuPhotoUrl = (id: string, hash: string | null) => hash ? `/api/menu-images/${id}/${hash}` : null;

/** Only bounded JPEG raster data is served. No URLs, SVG, or file paths. */
export function validateMenuPhoto(photo: string | null | undefined) {
  if (photo === undefined) return undefined;
  if (photo === null) return { data: null, hash: null };
  const prefix = "data:image/jpeg;base64,";
  const invalid = () => httpError(400, "Choose a valid JPEG photo up to 400 KB and 1600 pixels per side");
  if (!photo.startsWith(prefix)) throw invalid();
  const encoded = photo.slice(prefix.length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 400 * 1024 || bytes.length < 16 || bytes.toString("base64") !== encoded ||
    bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw invalid();
  let offset = 2, frame: number | null = null, scan = false;
  const components = new Map<number, number>();
  const quantization = new Set<number>(), huffman = new Set<string>();
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw invalid();
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw invalid();
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (frame === null || !scan || offset !== bytes.length) throw invalid();
      return { data: photo, hash: createHash("sha256").update(bytes).digest("hex") };
    }
    if (marker === undefined || marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) throw invalid();
    if (offset + 2 > bytes.length) throw invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw invalid();
    if (marker === 0xdb) {
      let position = offset + 2;
      if (position === offset + length) throw invalid();
      while (position < offset + length) {
        const table = bytes[position++]!, precision = table >> 4, id = table & 15;
        const size = 64 * (precision + 1);
        if (precision > 1 || id > 3 || position + size > offset + length) throw invalid();
        for (let index = 0; index < 64; index++) {
          if ((precision ? bytes.readUInt16BE(position + index * 2) : bytes[position + index]) === 0) throw invalid();
        }
        quantization.add(id); position += size;
      }
    }
    if (marker === 0xc4) {
      let position = offset + 2;
      if (position === offset + length) throw invalid();
      while (position < offset + length) {
        if (position + 17 > offset + length) throw invalid();
        const table = bytes[position++]!, kind = table >> 4, id = table & 15;
        if (kind > 1 || id > 3) throw invalid();
        let symbols = 0, available = 1;
        for (let index = 0; index < 16; index++) {
          const count = bytes[position++]!;
          symbols += count; available = available * 2 - count;
          if (available < 0) throw invalid();
        }
        if (!symbols || symbols > 256 || position + symbols > offset + length) throw invalid();
        huffman.add(`${kind}:${id}`); position += symbols;
      }
    }
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame !== null || length < 8 || bytes[offset + 2] !== 8) throw invalid();
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > 1600 || height > 1600) throw invalid();
      const count = bytes[offset + 7]!;
      if (count < 1 || count > 4 || length !== 8 + 3 * count) throw invalid();
      for (let index = 0; index < count; index++) {
        const position = offset + 8 + index * 3, id = bytes[position]!, sampling = bytes[position + 1]!, table = bytes[position + 2]!;
        if (components.has(id) || !(sampling >> 4) || (sampling >> 4) > 4 || !(sampling & 15) || (sampling & 15) > 4 || table > 3) throw invalid();
        components.set(id, table);
      }
      frame = marker;
    } else if ([0xc1, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      throw invalid();
    }
    if (marker === 0xda) {
      if (frame === null || length < 6) throw invalid();
      const count = bytes[offset + 2]!;
      if (count < 1 || count > components.size || length !== 6 + 2 * count) throw invalid();
      const ss = bytes[offset + length - 3]!, se = bytes[offset + length - 2]!, approximation = bytes[offset + length - 1]!;
      const high = approximation >> 4, low = approximation & 15;
      if (frame === 0xc0 && (ss !== 0 || se !== 63 || approximation !== 0)) throw invalid();
      if (frame === 0xc2 && (ss > se || se > 63 || (ss === 0 && se !== 0) || (ss > 0 && count !== 1) || high > 13 || low > 13 || (high !== 0 && high !== low + 1))) throw invalid();
      const selected = new Set<number>();
      for (let index = 0; index < count; index++) {
        const id = bytes[offset + 3 + index * 2]!, tables = bytes[offset + 4 + index * 2]!, dc = tables >> 4, ac = tables & 15;
        if (!components.has(id) || selected.has(id) || !quantization.has(components.get(id)!) || dc > 3 || ac > 3 ||
          (ss === 0 && !huffman.has(`0:${dc}`)) || (se > 0 && !huffman.has(`1:${ac}`))) throw invalid();
        selected.add(id);
      }
      offset += length;
      let hasData = false;
      // Entropy bytes may escape FF and contain restart markers. Continue at
      // the next real marker so later progressive scans are validated too.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; hasData = true; continue; }
        const start = offset++;
        while (bytes[offset] === 0xff) offset++;
        const next = bytes[offset];
        if (next === 0x00) { offset++; hasData = true; continue; }
        if (next !== undefined && next >= 0xd0 && next <= 0xd7) { offset++; continue; }
        offset = start; break;
      }
      if (!hasData) throw invalid();
      scan = true;
      continue;
    }
    offset += length;
  }
  throw invalid();
}
