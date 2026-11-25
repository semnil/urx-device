import { describe, expect, it } from "vitest";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };

async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

const switches = [
  ["channel.hpf.on", 25, "1"],
  ["channel.gate.on", 28, "1"],
  ["channel.comp.on", 34, "1"],
  ["channel.eq.on", 44, "1"],
  ["channel.ssmcs.on", 89, "1"],
  ["channel.ssmcs.comp.on", 94, "0"],
  ["channel.ssmcs.eq.on", 106, "0"],
] as const;

describe("processing switches (F04-S)", () => {
  it("write on with each switch's own polarity at its mono address", async () => {
    for (const [id, paramId, on] of switches) {
      const transport = new FakeTransport().script("setNumeric", accepted, accepted);
      const c = new OperationContext(transport, "URX44");
      await writeSetting(c, id, { channel: 3 }, true);
      await writeSetting(c, id, { channel: 3 }, false);
      expect(transport.calls.map((call) => [call.address, call.value]), id).toEqual([
        [{ paramId, x: "0", y: "2" }, on],
        [{ paramId, x: "0", y: "2" }, on === "1" ? "0" : "1"],
      ]);
    }
  });

  it("decode with the same polarity and refuse other raw values", async () => {
    const transport = new FakeTransport().script("getNumeric", read("0"), read("1"), read("2"));
    const c = new OperationContext(transport, "URX44");
    expect((await readSetting(c, "channel.ssmcs.comp.on", { channel: 1 })).value).toBe(true);
    expect((await readSetting(c, "channel.ssmcs.eq.on", { channel: 1 })).value).toBe(false);
    expect((await failureOf(readSetting(c, "channel.hpf.on", { channel: 1 })))?.code).toBe("invalid_response");
  });

  it("have fixed stereo only for the EQ switch", async () => {
    const transport = new FakeTransport().script("setNumeric", accepted);
    const c = new OperationContext(transport, "URX22");
    await writeSetting(c, "channel.eq.on", { channel: 5 }, true);
    expect(transport.calls[0]?.address).toEqual({ paramId: 213, x: "0", y: "1" });
    const none = new FakeTransport();
    const n = new OperationContext(none, "URX22");
    for (const [id] of switches.filter(([id]) => id !== "channel.eq.on")) {
      expect((await failureOf(readSetting(n, id, { channel: 3 })))?.code, id).toBe("unsupported_operation");
    }
    expect((await failureOf(readSetting(n, "channel.processing-mode", { channel: 3 })))?.code).toBe("unsupported_operation");
    expect(none.calls).toEqual([]);
  });

  it("write the processing mode at ID 21 only", async () => {
    const transport = new FakeTransport().script("setNumeric", accepted).script("getNumeric", read("1"), read("2"));
    const c = new OperationContext(transport, "URX44V");
    await writeSetting(c, "channel.processing-mode", { channel: 2 }, "ssmcs");
    expect((await readSetting(c, "channel.processing-mode", { channel: 2 })).value).toBe("ssmcs");
    expect((await failureOf(readSetting(c, "channel.processing-mode", { channel: 2 })))?.code).toBe("invalid_response");
    expect(transport.calls.map((call) => [call.method, call.address.paramId, call.value])).toEqual([
      ["setNumeric", 21, "1"],
      ["getNumeric", 21, undefined],
      ["getNumeric", 21, undefined],
    ]);
  });
});

describe("HPF frequency (F04-S)", () => {
  it("plans the nearest writable stop with lower ties, 40 … 120 Hz checked first", () => {
    const plan = (hz: number) => previewSetting("URX44", "channel.hpf.frequency", { channel: 1 }, hz).planned;
    expect(plan(40)).toBe(40);
    expect(plan(120)).toBe(118);
    expect(plan(41.25)).toBe(40);
    expect(plan(41.26)).toBe(42.5);
    expect(plan(103)).toBe(100);
    expect(plan(109)).toBe(106);
    for (const hz of [39.9, 120.1, Number.NaN, Infinity]) {
      expect(() => plan(hz), String(hz)).toThrow();
    }
  });

  it("writes the stop × 10 and reads 20 … 600 Hz without snapping", async () => {
    const transport = new FakeTransport()
      .script("setNumeric", accepted)
      .script("getNumeric", read("200"), read("6000"), read("1234"), read("199"), read("6001"));
    const c = new OperationContext(transport, "URX44");
    await writeSetting(c, "channel.hpf.frequency", { channel: 4 }, 42.6);
    expect(transport.calls[0]).toMatchObject({ address: { paramId: 26, x: "0", y: "3" }, value: "425" });
    expect((await readSetting(c, "channel.hpf.frequency", { channel: 4 })).value).toBe(20);
    expect((await readSetting(c, "channel.hpf.frequency", { channel: 4 })).value).toBe(600);
    expect((await readSetting(c, "channel.hpf.frequency", { channel: 4 })).value).toBe(123.4);
    for (let i = 0; i < 2; i += 1) {
      expect((await failureOf(readSetting(c, "channel.hpf.frequency", { channel: 4 })))?.code).toBe("invalid_response");
    }
  });
});
