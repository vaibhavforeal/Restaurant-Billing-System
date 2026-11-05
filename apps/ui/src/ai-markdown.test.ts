import { describe, expect, it } from "vitest";
import { INLINE_PATTERN, parseAiText, parseInline } from "./ai-markdown";

const t = (text: string) => ({ type: "text", text });

describe("parseInline", () => {
  it("reads bold, italic and code", () => {
    expect(parseInline("Sales were **₹12,400** on *Tuesday*, see `item_sales`.")).toEqual([
      t("Sales were "), { type: "strong", children: [t("₹12,400")] }, t(" on "), { type: "em", children: [t("Tuesday")] }, t(", see "), { type: "code", text: "item_sales" }, t("."),
    ]);
    expect(parseInline("_slow_ day")).toEqual([{ type: "em", children: [t("slow")] }, t(" day")]);
    expect(parseInline("**Paneer *tikka***")).toEqual([{ type: "strong", children: [t("Paneer "), { type: "em", children: [t("tikka")] }] }]);
  });

  it("leaves lone stars, maths and snake_case alone", () => {
    expect(parseInline("2 * 3 = 6 and staff_activity_report")).toEqual([t("2 * 3 = 6 and staff_activity_report")]);
    expect(parseInline("**not closed")).toEqual([t("**not closed")]);
  });

  it("uses no lookbehind, which older iPad Safari (before 16.4) can't parse", () => {
    expect(INLINE_PATTERN.source).not.toMatch(/\(\?<[!=]/);
    expect(parseInline("see (_this_) and x_y_z")).toEqual([t("see ("), { type: "em", children: [t("this")] }, t(") and x_y_z")]);
  });

  it("keeps HTML as plain text", () => {
    expect(parseInline("<script>alert(1)</script> **hi**")).toEqual([t("<script>alert(1)</script> "), { type: "strong", children: [t("hi")] }]);
  });
});

describe("parseAiText", () => {
  it("splits paragraphs on blank lines and keeps line breaks inside one", () => {
    expect(parseAiText("Good day.\nBest since May.\n\nKeep it up.")).toEqual([
      { type: "p", lines: [[t("Good day.")], [t("Best since May.")]] },
      { type: "p", lines: [[t("Keep it up.")]] },
    ]);
  });

  it("reads -, * and • bullets, numbered lists and headings", () => {
    expect(parseAiText("## This week\n- **Paneer tikka**: 42 plates\n* Dal: 30\n• Naan: 80\n\n1. Promote paneer\n2) Watch voids")).toEqual([
      { type: "h", inline: [t("This week")] },
      { type: "ul", items: [[{ type: "strong", children: [t("Paneer tikka")] }, t(": 42 plates")], [t("Dal: 30")], [t("Naan: 80")]] },
      { type: "ol", start: 1, items: [[t("Promote paneer")], [t("Watch voids")]] },
    ]);
  });

  it("ends a list at the next plain line, and starts a numbered list where the model did", () => {
    expect(parseAiText("- One\nThat's all.\n3. Third")).toEqual([
      { type: "ul", items: [[t("One")]] },
      { type: "p", lines: [[t("That's all.")]] },
      { type: "ol", start: 3, items: [[t("Third")]] },
    ]);
  });

  it("gives nothing for blank text", () => {
    expect(parseAiText("  \n\n ")).toEqual([]);
  });
});
