import { describe, expect, it } from "vitest";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting, type ReadArgs, type WriteArgs } from "../src/operations/registry.js";
import { settingHandlers } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const rejected = {
  kind: "failure",
  failure: { kind: "cause", code: "device_rejected", phase: "response" },
  evidence: { state: "rejected", responseCode: "7" },
};
const readAny = (c: OperationContext, id: string, target: unknown) => readSetting(c, ...([id, target] as unknown as ReadArgs));
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as WriteArgs));
async function failed(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}
const at = (paramId: number, y: number) => ({ paramId, x: "0", y: `${y}` });
const MONITOR = { function: "Monitor", parameter1: "Monitor 2", parameter2: "Level" };

describe("knob assignments and bank (F12-K)", () => {
  it("read the three components in order at every bank and knob, keeping the strings as received", async () => {
    for (const bank of [1, 2, 3, 4]) {
      for (const [index, knob] of ["a", "b", "c", "d"].entries()) {
        const y = (bank - 1) * 4 + index;
        const transport = new FakeTransport().script("getText", read("Unknown "), read(""), read(" x"));
        transport.timers = false;
        const reading = await readAny(new OperationContext(transport, "URX22"), "knob.assignment", { bank, knob });
        const value = reading.value as unknown as Record<string, { value: string; observedAt: string }>;
        expect([value["function"]?.value, value["parameter1"]?.value, value["parameter2"]?.value]).toEqual(["Unknown ", "", " x"]);
        expect(transport.calls.map(({ method, address }) => ({ method, address })), `${bank} ${knob}`).toEqual([
          { method: "getText", address: at(770, y) },
          { method: "getText", address: at(771, y) },
          { method: "getText", address: at(772, y) },
        ]);
      }
    }
    // A failing second component fails the whole read; the third is not requested.
    const partial = new FakeTransport().script("getText", read("Monitor"), read(7 as unknown as string));
    expect((await failed(readAny(new OperationContext(partial, "URX44"), "knob.assignment", { bank: 1, knob: "a" })))?.code).toBeDefined();
    expect(partial.calls.length).toBe(2);
  });

  it("write a legal triple as three ordered strings, keeping accepted steps on a later rejection", async () => {
    const transport = new FakeTransport().script("setText", accepted, accepted, accepted);
    const result = await writeAny(new OperationContext(transport, "URX44"), "knob.assignment", { bank: 2, knob: "c" }, MONITOR);
    expect(transport.calls.map(({ address, value }) => ({ address, value }))).toEqual([
      { address: at(770, 6), value: "Monitor" },
      { address: at(771, 6), value: "Monitor 2" },
      { address: at(772, 6), value: "Level" },
    ]);
    expect((result as { steps?: unknown }).steps).toEqual([
      { component: "function", requested: "Monitor", planned: "Monitor", outcome: "accepted" },
      { component: "parameter1", requested: "Monitor 2", planned: "Monitor 2", outcome: "accepted" },
      { component: "parameter2", requested: "Level", planned: "Level", outcome: "accepted" },
    ]);
    const empty = new FakeTransport().script("setText", accepted, accepted, accepted);
    await writeAny(new OperationContext(empty, "URX44"), "knob.assignment", { bank: 1, knob: "a" }, { function: "No Assign", parameter1: "", parameter2: "" });
    expect(empty.calls.map((call) => call.value)).toEqual(["No Assign", "", ""]);
    const partial = new FakeTransport().script("setText", accepted, rejected);
    const failure = await failed(writeAny(new OperationContext(partial, "URX44"), "knob.assignment", { bank: 1, knob: "b" }, MONITOR));
    expect(failure?.code).toBe("device_rejected");
    expect((failure?.progress as { steps: unknown }).steps).toEqual([
      { component: "function", requested: "Monitor", planned: "Monitor", outcome: "accepted" },
      { component: "parameter1", requested: "Monitor 2", planned: "Monitor 2", outcome: "rejected", responseCode: "7" },
      { component: "parameter2", requested: "Level", planned: "Level", outcome: "not_sent" },
    ]);
    expect(partial.calls.length).toBe(2);
  });

  it("refuse an illegal triple or selector before any request, and read the bank 1…4", async () => {
    const none = new FakeTransport();
    const c = new OperationContext(none, "URX44");
    for (const value of [
      { function: "Monitor", parameter1: "Monitor 3", parameter2: "Level" },
      { function: "monitor", parameter1: "Monitor 1", parameter2: "Level" },
      { function: "Brightness", parameter1: "Screen", parameter2: " " },
      { function: "Oscillator", parameter1: "Level" },
      { function: "No Assign", parameter1: "", parameter2: "", extra: "" },
    ]) {
      expect((await failed(writeAny(c, "knob.assignment", { bank: 1, knob: "a" }, value)))?.code, JSON.stringify(value)).toBe("invalid_input");
    }
    for (const target of [{ bank: 0, knob: "a" }, { bank: 5, knob: "a" }, { bank: 1.5, knob: "a" }, { bank: 1, knob: "A" }, { bank: 1 }, { knob: "a" }]) {
      expect((await failed(readAny(c, "knob.assignment", target)))?.code, JSON.stringify(target)).toBe("invalid_input");
    }
    expect(none.calls).toEqual([]);
    expect(previewSetting("URX44", "knob.assignment", { bank: 3, knob: "d" }, MONITOR)).toEqual({ requested: MONITOR, planned: MONITOR });
    for (const [raw, value] of [
      ["0", 1],
      ["3", 4],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await readAny(new OperationContext(transport, "URX44"), "knob.bank", {})).value).toBe(value);
      expect(transport.calls[0]?.address).toEqual(at(769, 0));
    }
    for (const raw of ["4", "-1"]) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failed(readAny(new OperationContext(transport, "URX44"), "knob.bank", {})))?.code, raw).toBe("invalid_response");
    }
    expect((await failed(writeAny(new OperationContext(new FakeTransport(), "URX44"), "knob.bank", {}, 2)))?.code).toBe("unsupported_operation");
  });
});

describe("integration and SEND display target (F12-I, F13-S)", () => {
  it("read integration status zero/nonzero, and the Post Fader Send source per FX bus", async () => {
    for (const [raw, value] of [
      ["0", false],
      ["1", true],
      ["2", true],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await readAny(new OperationContext(transport, "URX22"), "integration.active", {})).value, raw).toBe(value);
      expect(transport.calls[0]?.address).toEqual(at(816, 0));
    }
    expect((await failed(writeAny(new OperationContext(new FakeTransport(), "URX44"), "integration.active", {}, true)))?.code).toBe("unsupported_operation");
    for (const [bus, paramId] of [
      ["fx-1", 879],
      ["fx-2", 880],
    ] as const) {
      for (const [token, raw] of [
        ["mix-1", "288"],
        ["mix-2", "290"],
      ] as const) {
        const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
        const c = new OperationContext(transport, "URX44");
        expect((await readAny(c, "integration.post-fader-source", { bus })).value).toBe(token);
        await writeAny(c, "integration.post-fader-source", { bus }, token);
        expect(transport.calls.map(({ address, value }) => ({ address, value }))).toEqual([
          { address: at(paramId, 0), value: undefined },
          { address: at(paramId, 0), value: raw },
        ]);
      }
    }
    for (const raw of ["0", "256", "289", "291", "4294967295"]) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failed(readAny(new OperationContext(transport, "URX44"), "integration.post-fader-source", { bus: "fx-1" })))?.code, raw).toBe("invalid_response");
    }
    expect((await failed(readAny(new OperationContext(new FakeTransport(), "URX44"), "integration.post-fader-source", { bus: "mix-1" })))?.code).toBe(
      "unsupported_operation",
    );
    expect(() => previewSetting("URX44", "integration.post-fader-source", { bus: "fx-1" }, "none" as never)).toThrow(/invalid_input/);
  });

  it("read and write the five SEND display targets once at 763", async () => {
    for (const [token, raw] of [
      ["stereo", "0"],
      ["fx-1", "16"],
      ["fx-2", "17"],
      ["mix-1", "32"],
      ["mix-2", "34"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
      const c = new OperationContext(transport, "URX22");
      expect((await readAny(c, "panel.sends-target", {})).value).toBe(token);
      await writeAny(c, "panel.sends-target", {}, token);
      expect(transport.calls.map(({ address, value }) => ({ address, value }))).toEqual([
        { address: at(763, 0), value: undefined },
        { address: at(763, 0), value: raw },
      ]);
    }
    for (const raw of ["1", "18", "33", "48"]) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failed(readAny(new OperationContext(transport, "URX44"), "panel.sends-target", {})))?.code, raw).toBe("invalid_response");
    }
  });
});

describe("read-only settings expose no write path", () => {
  it("have no plan, write, validation or dry run in the public handler table", () => {
    for (const id of ["knob.bank", "integration.active"] as const) {
      const handler = settingHandlers[id] as unknown as Record<string, unknown>;
      expect(["plan", "write", "validate", "dryRun"].filter((key) => key in handler), id).toEqual([]);
      expect(typeof handler["read"], id).toBe("function");
    }
  });
});
