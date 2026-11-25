import { describe, expect, it } from "vitest";
import type { InputTarget, SourceTarget } from "../src/catalog/settings.js";
import { OperationContext } from "../src/operations/context.js";
import { previewSetting, readSetting, writeSetting, type ReadArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

// Type-level checks: each line marked @ts-expect-error must fail to compile.
describe("registry argument types", () => {
  it("bind each ID to its own target and value", () => {
    const context = new OperationContext(new FakeTransport(), "URX44");
    const id = "input.gain" as "input.gain" | "source.gain";
    const input: InputTarget | SourceTarget = { input: 1 };
    const checks = () => {
      // @ts-expect-error a union of IDs with a union of targets
      void readSetting(context, id, input);
      // @ts-expect-error a source target for a physical input setting
      void readSetting(context, "input.gain", { source: "aux" });
      // @ts-expect-error a number for a switch
      void writeSetting(context, "input.phantom", { input: 1 }, 3);
      // @ts-expect-error a boolean for a gain
      void previewSetting("URX44", "input.gain", { input: 1 }, true);
      // @ts-expect-error a read-only setting cannot be written
      void writeSetting(context, "input.clip-safe-active", { input: 1 }, true);
      const pair: ReadArgs = Math.random() > 2 ? ["input.gain", { input: 1 }] : ["source.gain", { source: "aux" }];
      void readSetting(context, ...pair);
      const gain: Promise<{ value: number }> = readSetting(context, "input.gain", { input: 1 });
      void gain;
    };
    expect(typeof checks).toBe("function");
  });
});
