import { afterEach, describe, expect, it } from "vitest";
import { log, setLogSink } from "./log.server";

afterEach(() => setLogSink(null));

describe("structured logging", () => {
  it("serialises an undefined field as null instead of dropping it", () => {
    // A diagnostic that disappears exactly when the value is missing is worse
    // than useless: it was why a rejected session token logged no host.
    const lines: string[] = [];
    setLogSink((line) => lines.push(JSON.stringify(line, (_k, v) => (v === undefined ? null : v))));
    log.warn("status.unauthorized", { reason: "shop", tokenDestHost: undefined });
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect("tokenDestHost" in parsed).toBe(true);
    expect(parsed.tokenDestHost).toBeNull();
  });

  it("merges child fields into every line and keeps the order id", () => {
    const lines: Array<Record<string, unknown>> = [];
    setLogSink((line) => lines.push(line as unknown as Record<string, unknown>));
    log.child({ orderId: "5678" }).info("spin.execute.done", { sliceIndex: 3 });
    expect(lines[0]).toMatchObject({
      event: "spin.execute.done",
      orderId: "5678",
      sliceIndex: 3,
      level: "info",
    });
  });

  it("serialises an Error into name, message and stack", () => {
    const lines: Array<Record<string, unknown>> = [];
    setLogSink((line) => lines.push(line as unknown as Record<string, unknown>));
    log.error("gift.confirm.edit_failed", { error: new Error("boom") });
    expect(lines[0].error).toMatchObject({ name: "Error", message: "boom" });
  });
});
