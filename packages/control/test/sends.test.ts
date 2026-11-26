import { describe, expect, it } from "vitest";
import { MONO_CHANNELS, STEREO_CHANNELS } from "../src/catalog/channels.js";
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
const plan = (id: string, target: object, value: unknown, model = "URX44") =>
  previewSetting(model, ...([id, target, value] as unknown as WriteArgs)).planned;
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

type Field = "on" | "level" | "pan" | "tap";
/** The F05-S address table: [base a for b = 0, stride, offsets level/pan/on/tap, writable fields]. */
const FAMILY = {
  "mono-mix": {
    a: 146,
    stride: 12,
    offsets: { level: 0, pan: 1, on: 2, tap: 5 },
    writes: ["tap"],
    urx22: { level: ["0 1", "0 2", "1 1"], pan: ["0 1", "0 2"], on: ["0 1", "0 2"] },
  },
  "stereo-mix": { a: 273, stride: 12, offsets: { level: 0, pan: 1, on: 2, tap: 5 }, writes: ["tap"], urx22: { level: ["0 1", "0 2"], on: ["0 1"] } },
  "mono-fx": { a: 193, stride: 4, offsets: { level: 1, on: 3, tap: 0 }, writes: ["level", "on"], urx22: {} },
  "stereo-fx": { a: 320, stride: 4, offsets: { level: 1, on: 3, tap: 0 }, writes: ["level", "on"], urx22: {} },
  "fx-mix": { a: 342, stride: 10, offsets: { level: 1, pan: 2, on: 3, tap: 0 }, writes: ["tap"], urx22: { level: ["0 1", "0 2", "1 1"], pan: ["0 1"], on: ["0 1"] } },
} as const satisfies Record<
  string,
  // `urx22`: per field, the sends ("y MIX-number") whose one representative write was measured on URX22 only (F03-G).
  { a: number; stride: number; offsets: { [F in Field]?: number }; writes: readonly Field[]; urx22: { readonly [F in Field]?: readonly string[] } }
>;
const sample: Record<Field, [string, unknown]> = { on: ["1", true], level: ["-1234", -12.34], pan: ["-63", -63], tap: ["1", "pre"] };

/** Every send of a model: [source, destination, family, y, b]. */
function sends(model: (typeof models)[number]) {
  const out: [string, string, keyof typeof FAMILY, number, number][] = [];
  for (const [kind, list] of [
    ["mono", MONO_CHANNELS[model]],
    ["stereo", STEREO_CHANNELS[model]],
  ] as const) {
    for (const [position, channel] of list.entries()) {
      const y = kind === "mono" ? channel - 1 : position;
      for (const b of [0, 1]) {
        out.push([`channel-${channel}`, `mix-${b + 1}`, `${kind}-mix`, y, b]);
        out.push([`channel-${channel}`, `fx-${b + 1}`, `${kind}-fx`, y, b]);
      }
    }
  }
  for (const fx of [0, 1]) {
    for (const b of [0, 1]) {
      out.push([`fx-${fx + 1}`, `mix-${b + 1}`, "fx-mix", fx, b]);
    }
  }
  return out;
}

describe("sends (F05-S)", () => {
  it("read every model's every send field once at its representative address", async () => {
    for (const model of models) {
      for (const [source, destination, family, y, b] of sends(model)) {
        const { a, stride, offsets } = FAMILY[family];
        for (const field of ["on", "level", "pan", "tap"] as const) {
          const offset = (offsets as { [F in Field]?: number })[field];
          const transport = new FakeTransport().script("getNumeric", read(sample[field][0]));
          transport.timers = false;
          const result = readAny(new OperationContext(transport, model), `send.${field}`, { source, destination });
          const label = `${model} ${source} → ${destination} ${field}`;
          if (offset === undefined) {
            expect((await failureOf(result))?.code, label).toBe("unsupported_operation");
            expect(transport.calls, label).toEqual([]);
          } else {
            expect((await result).value, label).toEqual(sample[field][1]);
            expect(transport.calls.map((call) => call.address), label).toEqual([{ paramId: a + offset + stride * b, x: "0", y: `${y}` }]);
          }
        }
      }
    }
  });

  it("write only the single-address fields, once each; every other write is unsupported without traffic", async () => {
    // Fifteen sends are measured on URX22; every other partner-linked send stays unbound.
    expect(Object.values(FAMILY).flatMap(({ urx22 }) => Object.values(urx22 as Record<string, readonly string[]>).flat()).length).toBe(15);
    const values: Record<Field, [unknown, string]> = { on: [false, "0"], level: [-12.34, "-1234"], pan: [10, "10"], tap: ["post", "0"] };
    for (const model of models) {
      for (const [source, destination, family, y, b] of sends(model)) {
        const { a, stride, offsets, writes, urx22 } = FAMILY[family];
        for (const field of ["on", "level", "pan", "tap"] as const) {
          const measured = (urx22 as { readonly [F in Field]?: readonly string[] })[field] ?? [];
          const bound = (writes as readonly Field[]).includes(field) || (model === "URX22" && measured.includes(`${y} ${b + 1}`));
          const offset = (offsets as { [F in Field]?: number })[field];
          const transport = new FakeTransport().script("setNumeric", accepted);
          transport.timers = false;
          const [value, raw] = values[field];
          const label = `${model} ${source} → ${destination} ${field}`;
          const result = writeAny(new OperationContext(transport, model), `send.${field}`, { source, destination }, value);
          if (offset !== undefined && bound) {
            expect((await result).planned, label).toBe(value);
            expect(transport.calls.map(({ address, value: sent }) => ({ address, value: sent })), label).toEqual([
              { address: { paramId: a + offset + stride * b, x: "0", y: `${y}` }, value: raw },
            ]);
          } else {
            // A field with no bound route on this model: unsupported, before any request.
            expect((await failureOf(result))?.code, label).toBe("unsupported_operation");
            expect(transport.calls, label).toEqual([]);
          }
        }
      }
    }
    // send.pan checks its target first: unknown tokens are invalid, unmatched pairs unsupported.
    for (const [target, code] of [
      [{ source: "channel-6", destination: "mix-1" }, "invalid_input"],
      [{ source: "channel-1", destination: "mix-1", side: "left" }, "invalid_input"],
      [{ source: "fx-1", destination: "fx-2" }, "unsupported_operation"],
      [{ source: "channel-11", destination: "mix-1" }, "unsupported_operation"],
    ] as const) {
      expect(() => plan("send.pan", target, -3, "URX22"), JSON.stringify(target)).toThrow(new RegExp(code));
    }
    // CH → FX tap is read-only for both values.
    for (const value of ["pre", "post"]) {
      expect(() => plan("send.tap", { source: "channel-1", destination: "fx-1" }, value)).toThrow(/unsupported_operation/);
    }
  });

  it("refuse pairs outside the matrix and malformed selectors before any request", async () => {
    const none = new FakeTransport();
    const c = new OperationContext(none, "URX22");
    for (const target of [
      { source: "fx-1", destination: "fx-2" },
      { source: "mix-1", destination: "mix-2" },
      { source: "mix-1", destination: "fx-1" },
      { source: "stereo", destination: "mix-1" },
      { source: "channel-1", destination: "stereo" },
      { source: "channel-11", destination: "mix-1" },
      { source: "channel-4", destination: "fx-1" },
    ]) {
      expect((await failureOf(readAny(c, "send.level", target)))?.code, JSON.stringify(target)).toBe("unsupported_operation");
    }
    for (const target of [
      { source: "channel-6", destination: "mix-1" },
      { source: "channel-01", destination: "mix-1" },
      { source: "Channel-1", destination: "mix-1" },
      { source: "fx-3", destination: "mix-1" },
      { source: "channel-1", destination: "mix-3" },
      { source: "channel-1" },
      { source: "channel-1", destination: "mix-1", side: "left" },
      { source: 1, destination: "mix-1" },
    ]) {
      expect((await failureOf(readAny(c, "send.level", target)))?.code, JSON.stringify(target)).toBe("invalid_input");
    }
    expect(none.calls).toEqual([]);
  });

  it("check level, pan, on and tap values and their raw read ranges", async () => {
    const fx = { source: "channel-2", destination: "fx-2" };
    expect([plan("send.level", fx, -96), plan("send.level", fx, 10), plan("send.level", fx, "-inf"), plan("send.level", fx, -12.345)]).toEqual([
      -96, 10, "-inf", -12.35,
    ]);
    for (const bad of [-96.5, -96.01, 10.01, Infinity, "-Infinity", "-96"]) {
      expect(() => plan("send.level", fx, bad), String(bad)).toThrow(/invalid_input/);
    }
    const mix = { source: "channel-1", destination: "mix-1" };
    expect([plan("send.tap", mix, "pre"), plan("send.tap", mix, "post")]).toEqual(["pre", "post"]);
    expect(() => plan("send.tap", mix, "Pre")).toThrow(/invalid_input/);
    const cases = [
      ["send.level", "-9600", -96],
      ["send.level", "1000", 10],
      ["send.level", "-32768", "-inf"],
      ["send.pan", "63", 63],
      ["send.on", "0", false],
      ["send.tap", "0", "post"],
    ] as const;
    for (const [id, raw, value] of cases) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await readAny(new OperationContext(transport, "URX44"), id, mix)).value, `${id} ${raw}`).toBe(value);
    }
    for (const [id, raw] of [
      ["send.level", "-9601"],
      ["send.level", "1001"],
      ["send.level", "-32767"],
      ["send.pan", "64"],
      ["send.pan", "-64"],
      ["send.on", "2"],
      ["send.tap", "2"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), id, mix)))?.code, `${id} ${raw}`).toBe("invalid_response");
    }
  });
});
