import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiStore } from "./store.js";

describe("AI settings store", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "ai-store-")); dirs.push(dir); return dir; };
  const key = randomBytes(32);

  it("starts with the defaults and no key", () => {
    const store = new AiStore(tempDir(), key);
    expect(store.settings()).toEqual({ enabled: false, provider: "openrouter", model: "google/gemma-4-31b-it:free", fallback: true });
    expect(store.key("openrouter")).toBeNull();
    expect(store.keyEnding("openrouter")).toBeNull();
  });

  it("saves settings and keeps them across restarts", () => {
    const dir = tempDir();
    new AiStore(dir, key).saveSettings({ enabled: true, model: "nvidia/nemotron-3-ultra-550b-a55b:free", fallback: false });
    expect(new AiStore(dir, key).settings()).toEqual({ enabled: true, provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", fallback: false });
  });

  it("seals the key on disk and reads it back", () => {
    const dir = tempDir();
    new AiStore(dir, key).setKey("openrouter", "sk-or-v1-abcd1234");
    expect(readFileSync(join(dir, "ai-assistant.json"), "utf8")).not.toContain("sk-or-v1-abcd1234");
    const reopened = new AiStore(dir, key);
    expect(reopened.key("openrouter")).toBe("sk-or-v1-abcd1234");
    expect(reopened.keyEnding("openrouter")).toBe("1234");
  });

  it("forgets a key sealed on another PC", () => {
    const dir = tempDir();
    new AiStore(dir, randomBytes(32)).setKey("openrouter", "sk-or-v1-abcd1234");
    const other = new AiStore(dir, key);
    expect(other.key("openrouter")).toBeNull();
    expect(other.keyEnding("openrouter")).toBeNull();
  });

  it("removes the key with null", () => {
    const store = new AiStore(tempDir(), key);
    store.setKey("openrouter", "sk-or-v1-abcd1234");
    store.setKey("openrouter", null);
    expect(store.key("openrouter")).toBeNull();
  });

  it("refuses to save a key without a secret key", () => {
    expect(() => new AiStore(tempDir(), undefined).setKey("openrouter", "sk-or-v1-abcd1234")).toThrow("Saving a key needs Windows credential protection");
  });

  it("adds usage per feature", () => {
    const store = new AiStore(tempDir(), key);
    store.recordUsage("ask", { inputTokens: 100, outputTokens: 20 });
    store.recordUsage("ask", { inputTokens: 100, outputTokens: 20 });
    expect(store.usage().ask).toEqual({ requests: 2, inputTokens: 200, outputTokens: 40 });
    expect(store.usage().describe).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("keeps settings when the file is unreadable JSON", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ai-assistant.json"), "{");
    expect(new AiStore(dir, key).settings().enabled).toBe(false);
  });
});
