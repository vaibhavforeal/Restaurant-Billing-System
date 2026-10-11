import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const scripts = ["m10-takeaway.js", "kot-send.js"].map((name) => resolve("tools/e2e", name));

describe("browser gate helper scope", () => {
  it.each(scripts)("has no unresolved names in %s", (file) => {
    const program = ts.createProgram([file], {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    });
    const source = program.getSourceFile(file);
    expect(source).toBeDefined();
    const unresolved = program.getSemanticDiagnostics(source).filter((diagnostic) => diagnostic.code === 2304);
    expect(unresolved.map((diagnostic) => {
      const location = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      return `${diagnostic.file?.fileName}:${(location?.line ?? 0) + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    })).toEqual([]);
  });
});

describe("M10 disposable fixture", () => {
  it("starts on registered Pro and accepts the same installation's newer Basic grant", async () => {
    const { createM10Fixture } = await import("./e2e/m10-server.mts");
    const fixture = await createM10Fixture();
    try {
      const headers = { authorization: `Bearer ${fixture.adminToken}`, "x-forkflow-device": fixture.browserDevice };
      const status = await fixture.app.inject({ url: "/api/license", headers });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ plan: "pro", revision: 1, canOperate: true, deviceRegistered: true });
      const stations = await fixture.app.inject({ url: "/api/kot-stations", headers });
      expect(stations.statusCode).toBe(200);
      expect(stations.json().stations).toHaveLength(1);
      expect(stations.json().stations[0].printerId).toEqual(expect.any(String));
      const setupScript = readFileSync(fixture.browserSetupPath, "utf8");
      expect(setupScript).toContain(`window.__m10BasicLicense = ${JSON.stringify(fixture.basicLicense)}`);
      expect(setupScript).toContain(`localStorage.setItem("forkflow.device.v1", ${JSON.stringify(fixture.browserDevice)})`);
      const check = await fixture.app.inject({ method: "POST", url: "/api/license/check", headers });
      expect(check.json().outcome).toBe("disabled");
      const basic = await fixture.app.inject({ method: "PUT", url: "/api/license", payload: { license: fixture.basicLicense }, headers });
      expect(basic.statusCode).toBe(200);
      expect(basic.json()).toMatchObject({ plan: "basic", revision: 2, canOperate: true, deviceRegistered: true });
    } finally {
      await fixture.close();
    }
  });
});
