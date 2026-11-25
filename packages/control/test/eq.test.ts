import { describe, expect, it } from "vitest";
import { MONO_CHANNELS, STEREO_CHANNELS } from "../src/catalog/channels.js";
import { EQ_BANDS, EQ_RULES } from "../src/catalog/eq.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import {
  previewSetting,
  readSetting,
  writeSetting,
  type ReadArgs,
  type WriteArgs,
} from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const models = ["URX22", "URX44", "URX44V"] as const;

async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

const readAny = (c: OperationContext, id: string, target: unknown) =>
  readSetting(c, ...([id, target] as unknown as ReadArgs));
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as WriteArgs));
const plan = (id: string, value: unknown, band = "low") =>
  previewSetting("URX44", id as never, { channel: 1, band } as never, value as never).planned;

/** Each channel of a model with its anchor and y. */
function channels(model: (typeof models)[number]) {
  return [
    ...MONO_CHANNELS[model].map((channel) => ({ channel, anchor: 44, y: `${channel - 1}` })),
    ...STEREO_CHANNELS[model].map((channel, position) => ({ channel, anchor: 213, y: `${position}` })),
  ];
}

const bandFields = [
  ["channel.eq.band.on", 0, "1"],
  ["channel.eq.band.q", 2, "71"],
  ["channel.eq.band.frequency", 3, "10004"],
  ["channel.eq.band.gain", 4, "-237"],
] as const;
const oneKnobFields = [
  ["channel.eq.one-knob.on", 2, "0"],
  ["channel.eq.one-knob.type", 3, "1"],
  ["channel.eq.one-knob.level", 4, "100"],
] as const;

describe("ordinary EQ (F04-E)", () => {
  it("read each band field once at anchor + 5 + 5i + field, mono and fixed stereo", async () => {
    for (const model of models) {
      for (const { channel, anchor, y } of channels(model)) {
        for (const [ordinal, band] of EQ_BANDS.entries()) {
          const fields = [...bandFields, ...(band === "low" || band === "high" ? [["channel.eq.band.type", 1, "2"] as const] : [])];
          for (const [id, offset, raw] of fields) {
            const transport = new FakeTransport().script("getNumeric", read(raw));
            transport.timers = false;
            await readAny(new OperationContext(transport, model), id, { channel, band });
            expect(transport.calls.map((call) => call.address), `${model} ${channel} ${band} ${id}`).toEqual([
              { paramId: anchor + 5 + 5 * ordinal + offset, x: "0", y },
            ]);
          }
        }
        for (const [id, offset, raw] of oneKnobFields) {
          const transport = new FakeTransport().script("getNumeric", read(raw));
          transport.timers = false;
          await readAny(new OperationContext(transport, model), id, { channel });
          expect(transport.calls.map((call) => call.address), `${model} ${channel} ${id}`).toEqual([
            { paramId: anchor + offset, x: "0", y },
          ]);
        }
      }
    }
  });

  it("write each setting with one request and nothing else", async () => {
    const cases = [
      ["channel.eq.band.on", { channel: 2, band: "high-mid" }, true, { paramId: 44 + 15, value: "1" }],
      ["channel.eq.band.type", { channel: 5, band: "high" }, "lpf", { paramId: 213 + 21, value: "2" }],
      ["channel.eq.band.q", { channel: 1, band: "low-mid" }, 0.71, { paramId: 44 + 12, value: "71" }],
      ["channel.eq.band.frequency", { channel: 1, band: "low" }, 1000.4, { paramId: 44 + 8, value: "10004" }],
      ["channel.eq.band.gain", { channel: 7, band: "high" }, -2.37, { paramId: 213 + 24, value: "-237" }],
      ["channel.eq.one-knob.on", { channel: 3 }, false, { paramId: 46, value: "0" }],
      ["channel.eq.one-knob.type", { channel: 9 }, "loudness", { paramId: 216, value: "2" }],
      ["channel.eq.one-knob.level", { channel: 4 }, 37, { paramId: 48, value: "37" }],
    ] as const;
    for (const [id, target, value, expected] of cases) {
      const transport = new FakeTransport().script("setNumeric", accepted);
      const result = await writeAny(new OperationContext(transport, "URX44"), id, target, value);
      expect(result.planned, id).toBe(value);
      expect(
        transport.calls.map((call) => ({ method: call.method, paramId: call.address.paramId, value: call.value })),
        id,
      ).toEqual([{ method: "setNumeric", paramId: expected.paramId, value: expected.value }]);
    }
  });

  it("refuse a middle-band type, a missing or extra band and a side before any request", async () => {
    const transport = new FakeTransport();
    const c = new OperationContext(transport, "URX44");
    for (const band of ["low-mid", "high-mid"]) {
      expect((await failureOf(readAny(c, "channel.eq.band.type", { channel: 1, band })))?.code).toBe("unsupported_operation");
      expect((await failureOf(writeAny(c, "channel.eq.band.type", { channel: 5, band }, "peaking")))?.code).toBe(
        "unsupported_operation",
      );
    }
    for (const target of [{ channel: 1 }, { channel: 1, band: "mid" }, { channel: 1, band: 0 }, { channel: 1, band: "low", side: "left" }]) {
      expect((await failureOf(readAny(c, "channel.eq.band.gain", target)))?.code, JSON.stringify(target)).toBe("invalid_input");
    }
    for (const target of [{ channel: 1, band: "low" }, { channel: 5, side: "right" }, { channel: 6 }]) {
      expect((await failureOf(readAny(c, "channel.eq.one-knob.level", target)))?.code, JSON.stringify(target)).toBe(
        "invalid_input",
      );
    }
    expect(transport.calls).toEqual([]);
    // An explicit undefined side is no side, as for whole-channel targets.
    const plain = new FakeTransport().script("getNumeric", read("0"), read("0"));
    const p = new OperationContext(plain, "URX44");
    await readAny(p, "channel.eq.band.gain", { channel: 1, band: "low", side: undefined });
    await readAny(p, "channel.eq.one-knob.level", { channel: 1, side: undefined });
    expect(plain.calls.length).toBe(2);
  });

  it("plan each band type and refuse the other band's filter", () => {
    expect(plan("channel.eq.band.type", "hpf", "low")).toBe("hpf");
    expect(plan("channel.eq.band.type", "shelving", "high")).toBe("shelving");
    expect(() => plan("channel.eq.band.type", "lpf", "low")).toThrow();
    expect(() => plan("channel.eq.band.type", "hpf", "high")).toThrow();
    expect(() => plan("channel.eq.band.type", "Peaking", "low")).toThrow();
  });

  it("check ranges first, then round to the step with lower ties", () => {
    const steps = [
      ["channel.eq.band.q", 0.5, 16, 0.01, [0.71, 0.715, 0.7151], [0.71, 0.71, 0.72]],
      ["channel.eq.band.frequency", 20, 20000, 0.1, [1000.4, 1000.45, 1000.4501], [1000.4, 1000.4, 1000.5]],
      ["channel.eq.band.gain", -18, 18, 0.01, [-2.37, -2.375, -2.3751], [-2.37, -2.38, -2.38]],
    ] as const;
    for (const [id, min, max, step, inputs, planned] of steps) {
      expect(plan(id, min), id).toBe(min);
      expect(plan(id, max), id).toBe(max);
      expect(inputs.map((value) => plan(id, value)), id).toEqual(planned);
      for (const bad of [min - step, max + step, Number.NaN, Infinity, "1"]) {
        expect(() => plan(id, bad), `${id} ${bad}`).toThrow();
      }
    }
    const level = (value: unknown) =>
      previewSetting("URX44", "channel.eq.one-knob.level", { channel: 1 }, value as number).planned;
    expect([0, 100, 36.5, 36.51].map(level)).toEqual([0, 100, 36, 37]);
    for (const bad of [-1, 101, "50"]) {
      expect(() => level(bad)).toThrow();
    }
  });

  it("decode reads at wire precision and refuse raw values outside each definition", async () => {
    const reads = [
      ["channel.eq.band.q", "low", "50", 0.5],
      ["channel.eq.band.q", "low", "1600", 16],
      ["channel.eq.band.q", "low", "333", 3.33],
      ["channel.eq.band.frequency", "high", "200", 20],
      ["channel.eq.band.frequency", "high", "200000", 20000],
      ["channel.eq.band.frequency", "high", "10003", 1000.3],
      ["channel.eq.band.gain", "low-mid", "-1800", -18],
      ["channel.eq.band.gain", "low-mid", "1799", 17.99],
      ["channel.eq.band.type", "low", "0", "peaking"],
      ["channel.eq.band.type", "low", "2", "hpf"],
      ["channel.eq.band.type", "high", "2", "lpf"],
      ["channel.eq.band.on", "high", "0", false],
    ] as const;
    for (const [id, band, raw, value] of reads) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await readAny(new OperationContext(transport, "URX44"), id, { channel: 1, band })).value, `${id} ${raw}`).toBe(
        value,
      );
    }
    const invalid = [
      ["channel.eq.band.q", "49"],
      ["channel.eq.band.q", "1601"],
      ["channel.eq.band.frequency", "199"],
      ["channel.eq.band.frequency", "200001"],
      ["channel.eq.band.gain", "1801"],
      ["channel.eq.band.type", "3"],
      ["channel.eq.band.on", "2"],
    ] as const;
    for (const [id, raw] of invalid) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), id, { channel: 1, band: "low" })))?.code, `${id} ${raw}`).toBe(
        "invalid_response",
      );
    }
    for (const [id, raw, value] of [
      ["channel.eq.one-knob.type", "0", "intensity"],
      ["channel.eq.one-knob.type", "2", "loudness"],
      ["channel.eq.one-knob.level", "0", 0],
      ["channel.eq.one-knob.on", "1", true],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await readAny(new OperationContext(transport, "URX44"), id, { channel: 5 })).value, `${id} ${raw}`).toBe(value);
    }
    for (const [id, raw] of [
      ["channel.eq.one-knob.type", "3"],
      ["channel.eq.one-knob.level", "101"],
      ["channel.eq.one-knob.level", "-1"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), id, { channel: 5 })))?.code, `${id} ${raw}`).toBe(
        "invalid_response",
      );
    }
  });

  it("carry every Q, frequency and gain step unchanged through write and read (F18-P)", async () => {
    for (const [id, low, high, scale] of [
      ["channel.eq.band.q", 50, 1600, 100],
      ["channel.eq.band.frequency", 200, 200000, 10],
      ["channel.eq.band.gain", -1800, 1800, 100],
    ] as const) {
      const raws: string[] = [];
      const values: number[] = [];
      for (let raw = low; raw <= high; raw += 1) {
        raws.push(`${raw}`);
        values.push(raw / scale);
      }
      // Scripted one reply at a time: the tables are too long to spread.
      const writes = new FakeTransport();
      writes.timers = false;
      const w = new OperationContext(writes, "URX44");
      const planned: number[] = [];
      for (const value of values) {
        writes.script("setNumeric", accepted);
        planned.push((await writeAny(w, id, { channel: 1, band: "high" }, value)).planned as number);
      }
      expect(planned, id).toEqual(values);
      expect(writes.calls.map((call) => call.value), id).toEqual(raws);
      const reads = new FakeTransport();
      reads.timers = false;
      const r = new OperationContext(reads, "URX44");
      const observed: unknown[] = [];
      for (const raw of raws) {
        reads.script("getNumeric", read(raw));
        observed.push((await readAny(r, id, { channel: 1, band: "high" })).value);
      }
      expect(observed, id).toEqual(values);
    }
  });

  it("type a missing band as undefined and refuse a band where a setting takes none", () => {
    const context = new OperationContext(new FakeTransport(), "URX44");
    const rule = EQ_RULES["channel.eq.band.type"];
    const checks = () => {
      for (const band of rule.bands) {
        // @ts-expect-error a middle band has no type address
        void rule.address[band].mono;
        void rule.address[band]?.mono;
        const value = rule.value.kind === "by-band" ? rule.value.rules[band] : rule.value;
        // @ts-expect-error a middle band has no type value rule
        void value.kind;
      }
      // @ts-expect-error the 1-knob settings take no band
      void readSetting(context, "channel.eq.one-knob.on", { channel: 1, band: "low" });
      // @ts-expect-error a whole-channel setting takes no band
      void writeSetting(context, "channel.fader", { channel: 1, band: "low" }, -3);
      const ids = "channel.eq.band.on" as "channel.eq.band.on" | "channel.eq.one-knob.on";
      // @ts-expect-error a band for a group that has a setting without bands
      void readSetting(context, ids, { channel: 1, band: "low" });
      void readSetting(context, "channel.eq.band.on", { channel: 1, band: "low" });
    };
    expect(typeof checks).toBe("function");
    expect(rule.address["low-mid"]).toBeUndefined();
  });
});

