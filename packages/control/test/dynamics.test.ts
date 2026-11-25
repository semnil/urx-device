import { describe, expect, it } from "vitest";
import { ATTACK_STOPS_RAW, HOLD_STOPS_RAW, RATIO_STOPS_RAW, RELEASE_STOPS_RAW } from "../src/catalog/dynamics-stops.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };

async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

const table = [
  ["channel.gate.threshold", 29, "0"],
  ["channel.gate.range", 30, "0"],
  ["channel.gate.attack", 31, "92"],
  ["channel.gate.hold", 32, "2"],
  ["channel.gate.decay", 33, "93"],
  ["channel.comp.threshold", 35, "0"],
  ["channel.comp.ratio", 36, "100"],
  ["channel.comp.knee", 37, "0"],
  ["channel.comp.gain", 38, "0"],
  ["channel.comp.attack", 39, "92"],
  ["channel.comp.release", 40, "93"],
  ["channel.comp.auto-makeup", 41, "1"],
  ["channel.comp.one-knob.on", 42, "1"],
  ["channel.comp.one-knob.level", 43, "50"],
] as const;

const plan = (id: string, value: unknown) => previewSetting("URX44", id as never, { channel: 1 } as never, value as never).planned;

describe("GATE and COMP (F04-D)", () => {
  it("read each setting once at its mono address; fixed stereo has none", async () => {
    for (const [id, paramId, raw] of table) {
      for (const channel of [1, 4]) {
        const transport = new FakeTransport().script("getNumeric", read(raw));
        transport.timers = false;
        await readSetting(new OperationContext(transport, "URX44V"), id, { channel });
        expect(transport.calls.map((call) => call.address), id).toEqual([{ paramId, x: "0", y: `${channel - 1}` }]);
      }
      const none = new FakeTransport();
      expect((await failureOf(readSetting(new OperationContext(none, "URX22"), id, { channel: 3 })))?.code, id).toBe(
        "unsupported_operation",
      );
      expect(none.calls).toEqual([]);
    }
  });

  it("plan dB settings on 0.01 dB within their ranges, checked first", () => {
    expect(plan("channel.gate.threshold", -72)).toBe(-72);
    expect(plan("channel.gate.threshold", -0.005)).toBe(-0.01);
    expect(plan("channel.comp.threshold", -54)).toBe(-54);
    expect(plan("channel.comp.gain", 18)).toBe(18);
    for (const [id, bad] of [
      ["channel.gate.threshold", -72.01],
      ["channel.gate.threshold", 0.01],
      ["channel.comp.threshold", -54.01],
      ["channel.comp.gain", 18.01],
      ["channel.comp.gain", -0.01],
    ] as const) {
      expect(() => plan(id, bad), `${id} ${bad}`).toThrow();
    }
  });

  it("take -inf only for the gate range and inf only for the ratio", async () => {
    expect(plan("channel.gate.range", "-inf")).toBe("-inf");
    expect(() => plan("channel.gate.range", -73)).toThrow();
    expect(() => plan("channel.gate.threshold", "-inf")).toThrow();
    expect(plan("channel.comp.ratio", "inf")).toBe("inf");
    for (const bad of [Infinity, "Infinity", "INF:1", "3:1", 500.01, 0.99]) {
      expect(() => plan("channel.comp.ratio", bad), String(bad)).toThrow();
    }
    const transport = new FakeTransport().script("setNumeric", accepted, accepted);
    const c = new OperationContext(transport, "URX44");
    await writeSetting(c, "channel.gate.range", { channel: 2 }, "-inf");
    await writeSetting(c, "channel.comp.ratio", { channel: 2 }, "inf");
    expect(transport.calls.map((call) => call.value)).toEqual(["-32768", "65535"]);
  });

  it("plan times and ratios on their nonuniform stops with lower ties", () => {
    const tables = [
      ["channel.gate.attack", ATTACK_STOPS_RAW, 1000],
      ["channel.comp.attack", ATTACK_STOPS_RAW, 1000],
      ["channel.gate.hold", HOLD_STOPS_RAW, 100],
      ["channel.gate.decay", RELEASE_STOPS_RAW, 10],
      ["channel.comp.release", RELEASE_STOPS_RAW, 10],
      ["channel.comp.ratio", RATIO_STOPS_RAW, 100],
    ] as const;
    for (const [id, stops, scale] of tables) {
      const first = (stops[0] as number) / scale;
      const last = (stops[stops.length - 1] as number) / scale;
      expect(plan(id, first), id).toBe(first);
      expect(plan(id, last), id).toBe(last);
      for (let i = 0; i + 1 < stops.length; i += 1) {
        const lower = (stops[i] as number) / scale;
        const upper = (stops[i + 1] as number) / scale;
        const midpoint = ((stops[i] as number) + (stops[i + 1] as number)) / 2 / scale;
        expect(plan(id, midpoint), `${id} ${midpoint}`).toBe(lower);
        expect(plan(id, (midpoint + upper) / 2), `${id} above ${midpoint}`).toBe(upper);
      }
      expect(() => plan(id, first - 0.001), id).toThrow();
      expect(() => plan(id, last + 0.01), id).toThrow();
    }
  });

  it("decode reads without snapping and refuse raw values outside the definition", async () => {
    const cases = [
      ["channel.gate.attack", "100", 0.1],
      ["channel.gate.hold", "196000", 1960],
      ["channel.comp.release", "9990", 999],
      ["channel.comp.ratio", "65534", 655.34],
      ["channel.comp.ratio", "65535", "inf"],
      ["channel.gate.range", "-32768", "-inf"],
      ["channel.gate.range", "-1501", -15.01],
      ["channel.comp.knee", "2", "hard"],
    ] as const;
    for (const [id, raw, value] of cases) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await readSetting(new OperationContext(transport, "URX44"), id, { channel: 1 })).value, id).toBe(value);
    }
    for (const [id, raw] of [
      ["channel.gate.attack", "91"],
      ["channel.gate.hold", "1"],
      ["channel.comp.release", "92"],
      ["channel.comp.ratio", "99"],
      ["channel.gate.range", "-7201"],
      ["channel.comp.knee", "3"],
      ["channel.comp.one-knob.level", "101"],
      ["channel.comp.auto-makeup", "2"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readSetting(new OperationContext(transport, "URX44"), id, { channel: 1 })))?.code, id).toBe(
        "invalid_response",
      );
    }
  });

  it("refuse a side on the mono channels before any request", async () => {
    const transport = new FakeTransport();
    const c = new OperationContext(transport, "URX44");
    for (const [id] of table) {
      for (const target of [{ channel: 1, side: "left" }, { channel: 1, side: "both" }]) {
        expect((await failureOf(readSetting(c, id, target as never)))?.code, id).toBe("invalid_input");
      }
    }
    expect(transport.calls).toEqual([]);
  });

  it("carry every 0.01 dB value of each dB range unchanged through write and read (F18-P)", async () => {
    const ranges = [
      ["channel.gate.threshold", -7200, 0],
      ["channel.gate.range", -7200, 0],
      ["channel.comp.threshold", -5400, 0],
      ["channel.comp.gain", 0, 1800],
    ] as const;
    for (const [id, low, high] of ranges) {
      const raws: string[] = [];
      const writes = new FakeTransport();
      const values: number[] = [];
      for (let centi = low; centi <= high; centi += 1) {
        values.push(centi / 100);
        raws.push(`${centi}`);
      }
      writes.timers = false;
      writes.script("setNumeric", ...values.map(() => accepted));
      const w = new OperationContext(writes, "URX44");
      for (const value of values) {
        const result = await writeSetting(w, ...([id, { channel: 1 }, value] as unknown as WriteArgs));
        if (result.planned !== value) {
          expect(result.planned, `${id} ${value}`).toBe(value);
        }
      }
      expect(writes.calls.map((call) => call.value), id).toEqual(raws);
      const reads = new FakeTransport().script("getNumeric", ...raws.map(read));
      reads.timers = false;
      const r = new OperationContext(reads, "URX44");
      const observed: unknown[] = [];
      for (let i = 0; i < raws.length; i += 1) {
        observed.push((await readSetting(r, id, { channel: 1 })).value);
      }
      expect(observed, id).toEqual(values);
    }
    expect(plan("channel.comp.gain", 7.06)).toBe(7.06);
    expect(plan("channel.comp.gain", 7.065)).toBe(7.06);
    expect(plan("channel.comp.gain", 7.0651)).toBe(7.07);
    expect(plan("channel.gate.threshold", -2.375)).toBe(-2.38);
    expect(plan("channel.gate.range", -0.005)).toBe(-0.01);
  });
});

