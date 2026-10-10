// btoa/atob only: runs in Node and Cloudflare Workers without Buffer.
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes standard or URL-safe base64, with or without padding. */
export function fromBase64(text: string): Uint8Array {
  const standard = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
