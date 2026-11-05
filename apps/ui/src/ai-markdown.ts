/**
 * The small part of Markdown AI models write (bold, italic, code, bullet and numbered lists, headings), parsed into plain data that
 * AiText renders as React elements. Nothing is ever turned into HTML, so model output can't inject markup.
 */
export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string };
export type Block =
  | { type: "p"; lines: Inline[][] }
  | { type: "ul"; items: Inline[][] }
  | { type: "ol"; start: number; items: Inline[][] }
  | { type: "h"; inline: Inline[] };

// `code`, then **bold** (lazy, so "**a** and **b**" is two), then *italic*, then _italic_ only between non-word characters (so snake_case
// stays as it is). Bold and italic must hug their text: "2 * 3" is not italic. No lookbehind: Safari before 16.4 (older iPads running the
// Captain and Kitchen apps from the same bundle) can't parse one, so the character before an _italic_ is matched and given back as text.
export const INLINE_PATTERN = /`([^`\n]+)`|\*\*(?=\S)([^\n]*?\S\**)\*\*|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu;
const INLINE = INLINE_PATTERN;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (piece: string) => {
    if (!piece) return;
    const last = out.at(-1);
    if (last?.type === "text") last.text += piece; else out.push({ type: "text", text: piece });
  };
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    push(text.slice(at, match.index));
    const [, code, bold, starEm, before, underEm] = match;
    if (code !== undefined) out.push({ type: "code", text: code });
    else if (bold !== undefined) out.push({ type: "strong", children: parseInline(bold) });
    else {
      if (before) push(before);
      out.push({ type: "em", children: parseInline((starEm ?? underEm)!) });
    }
    at = match.index + match[0].length;
  }
  push(text.slice(at));
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export function parseAiText(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const last = blocks.at(-1);
    if (!line.trim()) { if (last) blocks.push({ type: "p", lines: [] }); continue; }
    const heading = HEADING.exec(line), bullet = BULLET.exec(line), numbered = NUMBERED.exec(line);
    if (heading) blocks.push({ type: "h", inline: parseInline(heading[1]!.trim()) });
    else if (bullet) {
      if (last?.type === "ul") last.items.push(parseInline(bullet[1]!.trim()));
      else blocks.push({ type: "ul", items: [parseInline(bullet[1]!.trim())] });
    } else if (numbered) {
      if (last?.type === "ol") last.items.push(parseInline(numbered[2]!.trim()));
      else blocks.push({ type: "ol", start: Number(numbered[1]), items: [parseInline(numbered[2]!.trim())] });
    } else if (last?.type === "p") last.lines.push(parseInline(line.trim()));
    else blocks.push({ type: "p", lines: [parseInline(line.trim())] });
  }
  // A blank line opens an empty paragraph so the next line starts a new block; drop the ones nothing filled.
  return blocks.filter((b) => b.type !== "p" || b.lines.length > 0);
}
