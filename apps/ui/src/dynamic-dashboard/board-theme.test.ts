import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { boardThemeClass } from "./board-theme";
import { BoardRoot } from "./BoardRoot";

describe("dashboard theme bridge", () => {
  it("turns on BoardUI dark mode only for the app's dark theme", () => {
    expect(boardThemeClass("dark")).toBe("dark");
    expect(boardThemeClass("light")).toBe("");
    expect(boardThemeClass(undefined)).toBe("");
    expect(boardThemeClass(null)).toBe("");
    expect(boardThemeClass("DARK")).toBe("");
  });

  it("renders the isolated root without dark mode when there is no document theme", () => {
    const html = renderToStaticMarkup(createElement(BoardRoot, null, "x"));
    expect(html).toContain('class="boardui-root"');
    expect(html).not.toContain("dark");
  });
});
