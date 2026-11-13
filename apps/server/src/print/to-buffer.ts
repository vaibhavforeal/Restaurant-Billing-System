/** The shared slip builders return plain bytes; the server's queue, sinks and database take a Node `Buffer`. */
export function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
