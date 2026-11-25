import { describe, expect, it } from "vitest";
import { MONO_CHANNELS, STEREO_CHANNELS } from "../src/catalog/channels.js";
import { ATTACK_STOPS_RAW, RATIO_STOPS_RAW, RELEASE_STOPS_RAW } from "../src/catalog/dynamics-stops.js";
import { settingDefinitions } from "../src/catalog/settings.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting, type ReadArgs, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const models = ["URX22", "URX44", "URX44V"] as const;

const readAny = (c: OperationContext, id: string, target: unknown) => readSetting(c, ...([id, target] as unknown as ReadArgs));
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as WriteArgs));
const plan = (id: string, value: unknown, band?: string) =>
  previewSetting("URX44", ...([id, band === undefined ? { channel: 1 } : { channel: 1, band }, value] as unknown as WriteArgs))
    .planned;

async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

/** The F04-M table: [id, band, paramId, wire method suffix]. */
const paths = [
  ["channel.ssmcs.preset", undefined, 91, "Text"],
  ["channel.ssmcs.comp-drive", undefined, 95, "Numeric"],
  ["channel.ssmcs.morphing", undefined, 93, "Numeric"],
  ["channel.ssmcs.output-gain", undefined, 117, "Numeric"],
  ["channel.ssmcs.comp.attack", undefined, 96, "Numeric"],
  ["channel.ssmcs.comp.release", undefined, 97, "Numeric"],
  ["channel.ssmcs.comp.ratio", undefined, 98, "Numeric"],
  ["channel.ssmcs.comp.knee", undefined, 99, "Numeric"],
  ["channel.ssmcs.sidechain.on", undefined, 102, "Numeric"],
  ["channel.ssmcs.sidechain.q", undefined, 103, "Numeric"],
  ["channel.ssmcs.sidechain.frequency", undefined, 104, "Numeric"],
  ["channel.ssmcs.sidechain.gain", undefined, 105, "Numeric"],
  ["channel.ssmcs.eq.band.on", "low", 107, "Numeric"],
  ["channel.ssmcs.eq.band.on", "mid", 110, "Numeric"],
  ["channel.ssmcs.eq.band.on", "high", 114, "Numeric"],
  ["channel.ssmcs.eq.band.frequency", "low", 108, "Numeric"],
  ["channel.ssmcs.eq.band.frequency", "mid", 112, "Numeric"],
  ["channel.ssmcs.eq.band.frequency", "high", 115, "Numeric"],
  ["channel.ssmcs.eq.band.gain", "low", 109, "Numeric"],
  ["channel.ssmcs.eq.band.gain", "mid", 113, "Numeric"],
  ["channel.ssmcs.eq.band.gain", "high", 116, "Numeric"],
  ["channel.ssmcs.eq.band.q", "mid", 111, "Numeric"],
] as const;

/** Raw values valid for each path's read, used to drive the address checks. */
const sample: Record<string, string> = { "channel.ssmcs.preset": "0001", "channel.ssmcs.comp.attack": "57", "channel.ssmcs.comp.release": "24" };
const sampleOf = (id: string, band?: string) =>
  sample[id] ?? (id.endsWith("frequency") && band === "high" ? "60" : id.endsWith("frequency") ? "4" : "0");

/** Every raw 0…n−1 of a table, written then read back through one context each. */
async function roundTrip(id: string, band: string | undefined, raws: number[], valueOf: (raw: number) => number) {
  const target = band === undefined ? { channel: 2 } : { channel: 2, band };
  const writes = new FakeTransport();
  writes.timers = false;
  const reads = new FakeTransport();
  reads.timers = false;
  const w = new OperationContext(writes, "URX44");
  const r = new OperationContext(reads, "URX44");
  const planned: unknown[] = [];
  const observed: unknown[] = [];
  for (const raw of raws) {
    writes.script("setNumeric", accepted);
    planned.push((await writeAny(w, id, target, valueOf(raw))).planned);
    reads.script("getNumeric", read(`${raw}`));
    observed.push((await readAny(r, id, target)).value);
  }
  expect(writes.calls.map((call) => call.value), id).toEqual(raws.map(String));
  expect(planned, id).toEqual(raws.map(valueOf));
  expect(observed, id).toEqual(raws.map(valueOf));
}

const range = (low: number, high: number) => Array.from({ length: high - low + 1 }, (_, i) => low + i);

describe("SSMCS controls (F04-M)", () => {
  it("read and write each path once at its mono address; fixed stereo and a side are refused", async () => {
    for (const model of models) {
      for (const channel of MONO_CHANNELS[model]) {
        for (const [id, band, paramId, wire] of paths) {
          const target = band === undefined ? { channel } : { channel, band };
          const raw = sampleOf(id, band);
          const transport = new FakeTransport().script(`get${wire}`, read(raw)).script(`set${wire}`, accepted);
          transport.timers = false;
          const c = new OperationContext(transport, model);
          const { value } = await readAny(c, id, target);
          await writeAny(c, id, target, value);
          const at = { paramId, x: "0", y: `${channel - 1}` };
          expect(transport.calls.map(({ method, address, value: sent }) => ({ method, address, value: sent })), `${model} ${id} ${band}`).toEqual([
            { method: `get${wire}`, address: at, value: undefined },
            { method: `set${wire}`, address: at, value: raw },
          ]);
        }
      }
      const none = new FakeTransport();
      const c = new OperationContext(none, model);
      for (const [id, band] of paths) {
        const stereo = band === undefined ? { channel: STEREO_CHANNELS[model][0] } : { channel: STEREO_CHANNELS[model][0], band };
        expect((await failureOf(readAny(c, id, stereo)))?.code, id).toBe("unsupported_operation");
        const sided = band === undefined ? { channel: 1, side: "left" } : { channel: 1, band, side: "left" };
        expect((await failureOf(readAny(c, id, sided)))?.code, id).toBe("invalid_input");
      }
      expect(none.calls).toEqual([]);
    }
  });

  it("have no band type, no low/high Q and no public internal Threshold/Makeup", async () => {
    const transport = new FakeTransport();
    const c = new OperationContext(transport, "URX44");
    for (const band of ["low", "high"]) {
      expect((await failureOf(readAny(c, "channel.ssmcs.eq.band.q", { channel: 1, band })))?.code).toBe("unsupported_operation");
      expect((await failureOf(writeAny(c, "channel.ssmcs.eq.band.q", { channel: 1, band }, 1)))?.code).toBe(
        "unsupported_operation",
      );
    }
    for (const id of ["channel.ssmcs.eq.band.type", "channel.ssmcs.comp.threshold", "channel.ssmcs.comp.makeup"]) {
      expect(Object.hasOwn(settingDefinitions, id), id).toBe(false);
      expect((await failureOf(readAny(c, id, { channel: 1 })))?.code, id).toBe("invalid_input");
    }
    expect((await failureOf(readAny(c, "channel.ssmcs.eq.band.on", { channel: 1, band: "low-mid" })))?.code).toBe("invalid_input");
    expect(transport.calls).toEqual([]);
    const ids = Object.keys(settingDefinitions).filter((id) => id.startsWith("channel.ssmcs."));
    for (const id of ids) {
      const rule = (settingDefinitions as unknown as Record<string, { rule?: { address: object } }>)[id]?.rule;
      expect(JSON.stringify(rule?.address ?? {}), id).not.toMatch(/:10[01]\b/);
    }
  });

  it("map every preset 1…34 to its four-digit string, and nothing else", async () => {
    const writes = new FakeTransport();
    const reads = new FakeTransport();
    for (let preset = 1; preset <= 34; preset += 1) {
      writes.script("setText", accepted);
      await writeAny(new OperationContext(writes, "URX44"), "channel.ssmcs.preset", { channel: 1 }, preset);
      reads.script("getText", read(`${preset}`.padStart(4, "0")));
      expect((await readAny(new OperationContext(reads, "URX44"), "channel.ssmcs.preset", { channel: 1 })).value).toBe(preset);
    }
    expect(writes.calls.map((call) => call.value)).toEqual(range(1, 34).map((n) => `${n}`.padStart(4, "0")));
    for (const bad of [0, 35, 1.5, "7", "0007", Number.NaN]) {
      expect(() => plan("channel.ssmcs.preset", bad), String(bad)).toThrow();
    }
    for (const bad of ["0000", "0035", "7", "07", "00007", " 001", "0001 ", "000a", "+001", ""]) {
      const transport = new FakeTransport().script("getText", read(bad));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), "channel.ssmcs.preset", { channel: 1 })))?.code, JSON.stringify(bad)).toBe(
        "invalid_response",
      );
    }
  });

  it("round-trip every step of the uniform controls and check ranges and lower ties", async () => {
    await roundTrip("channel.ssmcs.comp-drive", undefined, range(0, 200), (raw) => raw / 20);
    await roundTrip("channel.ssmcs.morphing", undefined, range(0, 120), (raw) => raw);
    for (const [id, band] of [
      ["channel.ssmcs.output-gain", undefined],
      ["channel.ssmcs.sidechain.gain", undefined],
      ["channel.ssmcs.eq.band.gain", "low"],
      ["channel.ssmcs.eq.band.gain", "mid"],
      ["channel.ssmcs.eq.band.gain", "high"],
    ] as const) {
      await roundTrip(id, band, range(0, 360), (raw) => (raw - 180) / 10);
      expect([plan(id, 0.05, band), plan(id, 0.0501, band), plan(id, -0.05, band)], id).toEqual([0, 0.1, -0.1]);
      expect(() => plan(id, 18.1, band), id).toThrow();
      expect(() => plan(id, -18.1, band), id).toThrow();
    }
    expect([plan("channel.ssmcs.comp-drive", 0.025), plan("channel.ssmcs.comp-drive", 0.0251)]).toEqual([0, 0.05]);
    expect(() => plan("channel.ssmcs.comp-drive", 10.05)).toThrow();
    expect([plan("channel.ssmcs.morphing", 0.5), plan("channel.ssmcs.morphing", 119.51)]).toEqual([0, 120]);
    expect(() => plan("channel.ssmcs.morphing", 121)).toThrow();
  });

  it("round-trip every attack, release and ratio index, with infinity at the last ratio index", async () => {
    await roundTrip("channel.ssmcs.comp.attack", undefined, range(57, 283), (raw) => (ATTACK_STOPS_RAW[raw - 57] as number) / 1000);
    await roundTrip("channel.ssmcs.comp.release", undefined, range(24, 300), (raw) => (RELEASE_STOPS_RAW[raw - 24] as number) / 10);
    await roundTrip("channel.ssmcs.comp.ratio", undefined, range(0, 119), (raw) => (RATIO_STOPS_RAW[raw] as number) / 100);
    expect(plan("channel.ssmcs.comp.ratio", "inf")).toBe("inf");
    const transport = new FakeTransport().script("setNumeric", accepted).script("getNumeric", read("120"));
    const c = new OperationContext(transport, "URX44");
    await writeAny(c, "channel.ssmcs.comp.ratio", { channel: 1 }, "inf");
    expect((await readAny(c, "channel.ssmcs.comp.ratio", { channel: 1 })).value).toBe("inf");
    expect(transport.calls.map((call) => call.value)).toEqual(["120", undefined]);
    for (const bad of [Infinity, "Infinity", "INF:1", 500.01, 0.99]) {
      expect(() => plan("channel.ssmcs.comp.ratio", bad), String(bad)).toThrow();
    }
    for (const [id, raw] of [
      ["channel.ssmcs.comp.ratio", "121"],
      ["channel.ssmcs.comp.ratio", "-1"],
      ["channel.ssmcs.comp.attack", "56"],
      ["channel.ssmcs.comp.attack", "284"],
      ["channel.ssmcs.comp.release", "23"],
      ["channel.ssmcs.comp.release", "301"],
    ] as const) {
      const t = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(t, "URX44"), id, { channel: 1 })))?.code, `${id} ${raw}`).toBe("invalid_response");
    }
    // Ties in the public unit go to the lower stop.
    expect([plan("channel.ssmcs.comp.attack", 0.0935), plan("channel.ssmcs.comp.attack", 0.09351)]).toEqual([0.092, 0.095]);
    expect(plan("channel.ssmcs.comp.ratio", 1.025)).toBe(1);
  });

  it("round-trip every Q and frequency step, with each band's frequency window", async () => {
    const q = [
      0.5, 0.53, 0.56, 0.59, 0.63, 0.67, 0.71, 0.75, 0.79, 0.84, 0.89, 0.94, 1, 1.06, 1.12, 1.19, 1.26, 1.33, 1.41, 1.5, 1.59, 1.68, 1.78, 1.89,
      2, 2.12, 2.24, 2.38, 2.52, 2.67, 2.83, 3, 3.17, 3.36, 3.56, 3.78, 4, 4.24, 4.49, 4.76, 5.04, 5.34, 5.66, 5.99, 6.35, 6.73, 7.13, 7.55, 8,
      8.48, 8.98, 9.51, 10.08, 10.68, 11.31, 11.99, 12.7, 13.45, 14.25, 15.1, 16,
    ];
    expect(q.length).toBe(61);
    await roundTrip("channel.ssmcs.sidechain.q", undefined, range(0, 60), (raw) => q[raw] as number);
    await roundTrip("channel.ssmcs.eq.band.q", "mid", range(0, 60), (raw) => q[raw] as number);
    expect([plan("channel.ssmcs.sidechain.q", 0.515), plan("channel.ssmcs.sidechain.q", 0.5151)]).toEqual([0.5, 0.53]);
    // R40 grades above 20 Hz: the named step, not 20 × 10^((r − 4) / 40).
    const r40 = [10, 10.6, 11.2, 11.8, 12.5, 13.2, 14, 15, 16, 17, 18, 19, 20, 21.2, 22.4, 23.6, 25, 26.5, 28, 30, 31.5, 33.5, 35.5, 37.5, 40, 42.5, 45, 47.5, 50, 53, 56, 60, 63, 67, 71, 75, 80, 85, 90, 95];
    const hz = (raw: number) => {
      const k = raw - 4 + 52;
      return Math.round((r40[k % 40] as number) * 10 ** (Math.floor(k / 40) - 1) * 10) / 10;
    };
    expect([hz(4), hz(72), hz(60), hz(124)]).toEqual([20, 1000, 500, 20000]);
    await roundTrip("channel.ssmcs.sidechain.frequency", undefined, range(4, 124), hz);
    for (const [band, low, high] of [
      ["low", 4, 72],
      ["mid", 4, 124],
      ["high", 60, 124],
    ] as const) {
      await roundTrip("channel.ssmcs.eq.band.frequency", band, range(low, high), hz);
      expect(() => plan("channel.ssmcs.eq.band.frequency", hz(low) - 0.1, band), band).toThrow();
      expect(() => plan("channel.ssmcs.eq.band.frequency", hz(high) + 0.1, band), band).toThrow();
      for (const raw of [low - 1, high + 1]) {
        const t = new FakeTransport().script("getNumeric", read(`${raw}`));
        expect((await failureOf(readAny(new OperationContext(t, "URX44"), "channel.ssmcs.eq.band.frequency", { channel: 1, band })))?.code, `${band} ${raw}`).toBe(
          "invalid_response",
        );
      }
    }
    expect([plan("channel.ssmcs.sidechain.frequency", 21.8), plan("channel.ssmcs.sidechain.frequency", 21.81)]).toEqual([21.2, 22.4]);
    expect(plan("channel.ssmcs.sidechain.frequency", 1002.37)).toBe(1000);
  });
});
