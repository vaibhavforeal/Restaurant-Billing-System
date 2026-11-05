import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiStore } from "./store.js";

describe("AI assistant store", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "ai-store-")); dirs.push(dir); return dir; };

  it("starts switched on locally, with no service status yet", () => {
    const store = new AiStore(tempDir());
    expect(store.localEnabled()).toBe(true);
    expect(store.service()).toBeNull();
  });

  it("keeps the local switch and the service status across restarts", () => {
    const dir = tempDir();
    const store = new AiStore(dir);
    store.setLocalEnabled(false);
    store.setService({ enabled: true, dailyLimit: 40, usedToday: 3, checkedAt: 1000 });
    const reopened = new AiStore(dir);
    expect(reopened.localEnabled()).toBe(false);
    expect(reopened.service()).toEqual({ enabled: true, dailyLimit: 40, usedToday: 3, checkedAt: 1000 });
  });

  it("drops a key saved by an older version on the next write", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ai-assistant.json"), JSON.stringify({ settings: { enabled: true, model: "x", fallback: true }, keys: { openrouter: "sealed" }, usage: { ask: { requests: 2, inputTokens: 10, outputTokens: 4 } } }));
    const store = new AiStore(dir);
    expect(store.usage().ask).toEqual({ requests: 2, inputTokens: 10, outputTokens: 4 });
    store.setLocalEnabled(true);
    const file = readFileSync(join(dir, "ai-assistant.json"), "utf8");
    expect(file).not.toContain("sealed");
    expect(file).not.toContain("model");
  });

  it("adds usage per feature", () => {
    const store = new AiStore(tempDir());
    store.recordUsage("ask", { inputTokens: 100, outputTokens: 20 });
    store.recordUsage("ask", { inputTokens: 100, outputTokens: 20, requests: 3 });
    expect(store.usage().ask).toEqual({ requests: 4, inputTokens: 200, outputTokens: 40 });
    expect(store.usage()).toEqual({ ask: { requests: 4, inputTokens: 200, outputTokens: 40 }, daySummary: { requests: 0, inputTokens: 0, outputTokens: 0 }, describe: { requests: 0, inputTokens: 0, outputTokens: 0 } });
  });

  it("survives an unreadable file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ai-assistant.json"), "{");
    expect(new AiStore(dir).localEnabled()).toBe(true);
  });
});
