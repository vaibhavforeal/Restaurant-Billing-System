import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { AI_OFFLINE_TEXT, aiErrorText, appendTurn, historyForRequest, type ChatTurn } from "./ask-chat";

describe("Ask MasalaPOS helpers", () => {
  it("appendTurn keeps order", () => {
    const turns = appendTurn(appendTurn([], "user", "Top dish?"), "assistant", "Paneer tikka.");
    expect(turns).toEqual([{ role: "user", text: "Top dish?" }, { role: "assistant", text: "Paneer tikka." }]);
  });

  it("historyForRequest sends at most 10 turns", () => {
    const turns: ChatTurn[] = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `t${i}` }));
    expect(historyForRequest(turns).map((t) => t.text)).toEqual(["t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12", "t13"]);
  });

  it("aiErrorText prefers the server message and falls back to the offline copy", () => {
    expect(aiErrorText(new ApiError(429, "OpenRouter's free limit is used up for today."))).toBe("OpenRouter's free limit is used up for today.");
    expect(aiErrorText(new TypeError("Failed to fetch"))).toBe(AI_OFFLINE_TEXT);
    expect(AI_OFFLINE_TEXT).toBe("The AI assistant needs internet. Everything else keeps working.");
  });
});
