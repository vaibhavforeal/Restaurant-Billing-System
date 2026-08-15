import { describe, it, expect } from "vitest";
import { makeFakeSink } from "./sinks.js";

describe("makeFakeSink", () => {
  it("captures sent bytes", async () => {
    const fake = makeFakeSink();
    const target = { kind: "network" as const, connection: "192.168.1.100" };
    const bytes = Buffer.from("test data");

    await fake.send(target, bytes);

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.target).toEqual(target);
    expect(fake.sent[0]!.bytes.toString()).toBe("test data");
  });

  it("fails when configured via failNext", async () => {
    const fake = makeFakeSink();
    fake.failNext("simulated error");

    await expect(
      fake.send({ kind: "network", connection: "test" }, Buffer.from("data"))
    ).rejects.toThrow("simulated error");
  });

  it("only fails once then succeeds again", async () => {
    const fake = makeFakeSink();
    fake.failNext("first failure");

    await expect(
      fake.send({ kind: "network", connection: "test" }, Buffer.from("data"))
    ).rejects.toThrow("first failure");

    // Second send should succeed
    await fake.send({ kind: "network", connection: "test" }, Buffer.from("data"));
    expect(fake.sent).toHaveLength(1);
  });
});
