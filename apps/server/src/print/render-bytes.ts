/**
 * Renders a byte buffer for snapshot tests.
 * - Printable ASCII (0x20–0x7E) stays literal
 * - LF (0x0A) becomes literal newline
 * - Everything else becomes <XX> uppercase hex
 * - After escape bytes (0x1B/0x1D), render next 2 bytes as hex
 */
export function renderBytes(buf: Buffer): string {
  let result = "";
  let escapeCount = 0; // Count down bytes to render as hex after escape

  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]!;

    // Check if starting an escape sequence
    if (byte === 0x1b || byte === 0x1d) {
      escapeCount = 2; // Render next 2 bytes as hex
      result += `<${byte.toString(16).toUpperCase().padStart(2, "0")}>`;
      continue;
    }

    // Render the byte
    if (escapeCount > 0) {
      result += `<${byte.toString(16).toUpperCase().padStart(2, "0")}>`;
      escapeCount--;
    } else if (byte === 0x0a) {
      result += "\n";
    } else if (byte >= 0x20 && byte <= 0x7e) {
      result += String.fromCharCode(byte);
    } else {
      result += `<${byte.toString(16).toUpperCase().padStart(2, "0")}>`;
    }
  }

  return result;
}
