/**
 * Renders a byte buffer for snapshot tests.
 * - Printable ASCII (0x20–0x7E) stays literal
 * - LF (0x0A) becomes literal newline
 * - Everything else becomes <XX> uppercase hex
 * - After escape bytes (0x1B/0x1D), renders command byte + parameter bytes as hex based on command vocabulary
 */
export function renderBytes(buf: Buffer): string {
  // Command -> parameter byte count map
  const escParamCounts: Record<number, number> = {
    0x40: 0, // ESC @ (init)
    0x61: 1, // ESC a (align)
    0x45: 1, // ESC E (bold)
    0x64: 1, // ESC d (feed)
    0x70: 3, // ESC p (drawerKick)
  };

  const gsParamCounts: Record<number, number> = {
    0x21: 1, // GS ! (size)
    0x56: 2, // GS V (cut)
  };

  let result = "";
  let paramsToHex = 0; // Count down bytes to render as hex after command byte

  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]!;

    // If we're in the middle of consuming parameter bytes, render as hex
    if (paramsToHex > 0) {
      result += `<${byte.toString(16).toUpperCase().padStart(2, "0")}>`;
      paramsToHex--;
      continue;
    }

    // Check if starting an escape sequence
    if (byte === 0x1b) {
      result += "<1B>";
      // Next byte is the command byte; get its parameter count
      if (i + 1 < buf.length) {
        const cmdByte = buf[i + 1]!;
        paramsToHex = (escParamCounts[cmdByte] ?? 0) + 1; // +1 for the command byte itself
      }
      continue;
    }

    if (byte === 0x1d) {
      result += "<1D>";
      // Next byte is the command byte; get its parameter count
      if (i + 1 < buf.length) {
        const cmdByte = buf[i + 1]!;
        paramsToHex = (gsParamCounts[cmdByte] ?? 0) + 1; // +1 for the command byte itself
      }
      continue;
    }

    // Normal rendering
    if (byte === 0x0a) {
      result += "\n";
    } else if (byte >= 0x20 && byte <= 0x7e) {
      result += String.fromCharCode(byte);
    } else {
      result += `<${byte.toString(16).toUpperCase().padStart(2, "0")}>`;
    }
  }

  return result;
}
