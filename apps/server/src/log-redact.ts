/**
 * Redacts the value of any `token` query parameter in a URL.
 * Returns the URL with `token=<redacted>` instead of the actual token.
 */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/g, "$1<redacted>");
}
