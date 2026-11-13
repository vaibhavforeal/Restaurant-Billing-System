/** True when a name has a character a thermal printer's built-in font cannot print (anything outside 0x20 to 0x7e). */
export function hasUnprintable(text: string): boolean {
  return /[^\x20-\x7e]/.test(text);
}
