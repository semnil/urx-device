import { describe, expect, it } from "vitest";
import { BUS_RULES } from "../src/catalog/buses.js";
import {
  FADER_DB,
  FADER_LEVEL_RULE,
  FADER_NEGATIVE_INFINITY_RAW,
  MONO_CHANNELS,
  PAN_RANGE,
  PAN_RULE,
  STEREO_CHANNELS,
} from "../src/catalog/channels.js";
import { SEND_RULES } from "../src/catalog/sends.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting, type ReadArgs, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: unknown) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const models = ["URX22", "URX44", "URX44V"] as const;
const readAny = (c: OperationContext, id: string, target: unknown) => readSetting(c, ...([id, target] as unknown as ReadArgs));
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as WriteArgs));
const plan = (id: string, target: object, value: unknown) => previewSetting("URX44", ...([id, target, value] as unknown as WriteArgs)).planned;
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

type Bus = "stereo" | "mix-1" | "mix-2" | "fx-1" | "fx-2" | "stream";
/** The F05-B tables: field → bus → [paramId, y, write bound]. */
const TABLE: Record<string, Partial<Record<Bus, [number, number, boolean]>>> = {
  "bus.on": { stereo: [582, 0, true], "mix-1": [675, 0, false], "mix-2": [675, 2, false], "fx-1": [338, 0, true], "fx-2": [338, 1, true] },
  "bus.fader": { stereo: [581, 0, true], "mix-1": [674, 0, false], "mix-2": [674, 2, false], "fx-1": [337, 0, true], "fx-2": [337, 1, true] },
  "bus.balance": { stereo: [583, 0, true], "mix-1": [676, 0, false], "mix-2": [676, 2, false], "fx-1": [339, 0, true], "fx-2": [339, 1, true] },
  "bus.type": { "mix-1": [587, 0, false], "mix-2": [587, 2, false] },
  "bus.pan-link": { "mix-1": [589, 0, true], "mix-2": [589, 2, true] },
  "bus.stereo-assign": { "mix-1": [677, 0, true], "mix-2": [677, 2, true], "fx-1": [340, 0, true], "fx-2": [340, 1, true] },
  "bus.name": { stereo: [494, 0, true], "mix-1": [584, 0, false], "mix-2": [584, 2, false], "fx-1": [333, 0, true], "fx-2": [333, 1, true], stream: [702, 0, false] },
  "bus.color": { stereo: [496, 0, true], "mix-1": [586, 0, false], "mix-2": [586, 2, false], "fx-1": [335, 0, true], "fx-2": [335, 1, true], stream: [704, 0, false] },
};
const BUSES: Bus[] = ["stereo", "mix-1", "mix-2", "fx-1", "fx-2", "stream"];
/** [read method, a raw reply, its value, a write value, its wire value, write method]. */
const SAMPLE: Record<string, [string, unknown, unknown, unknown, string, string]> = {
  "bus.on": ["getNumeric", "1", true, false, "0", "setNumeric"],
  "bus.fader": ["getNumeric", "-32768", "-inf", -12.34, "-1234", "setNumeric"],
  "bus.balance": ["getNumeric", "-63", -63, 63, "63", "setNumeric"],
  "bus.type": ["getNumeric", "1", "fixed", "vari", "0", "setNumeric"],
  "bus.pan-link": ["getNumeric", "0", false, true, "1", "setNumeric"],
  "bus.stereo-assign": ["getNumeric", "1", true, false, "0", "setNumeric"],
  "bus.name": ["getName", { kind: "text", value: "Main  " }, { kind: "text", text: "Main  " }, "", "", "setText"],
  "bus.color": ["getNumeric", "10", "off", "red", "6", "setNumeric"],
};

describe("bus controls (F05-B)", () => {
  it("read each bus field once at its representative instance; a bus without the field is unsupported", async () => {
    for (const model of models) {
      for (const [id, buses] of Object.entries(TABLE)) {
        const [method, raw, value] = SAMPLE[id] as [string, unknown, unknown, unknown, string, string];
        for (const bus of BUSES) {
          const entry = buses[bus];
          const transport = new FakeTransport().script(method as "getNumeric", read(raw));
          const result = readAny(new OperationContext(transport, model), id, { bus });
          if (entry === undefined) {
            expect((await failureOf(result))?.code, `${model} ${id} ${bus}`).toBe("unsupported_operation");
            expect(transport.calls).toEqual([]);
          } else {
            expect((await result).value, `${model} ${id} ${bus}`).toEqual(value);
            expect(transport.calls.map(({ method: m, address }) => ({ m, address })), `${model} ${id} ${bus}`).toEqual([
              { m: method, address: { paramId: entry[0], x: "0", y: `${entry[1]}` } },
            ]);
          }
        }
      }
    }
  });

  it("write only the single-instance fields, once each; every other write is refused without traffic", async () => {
    for (const [id, buses] of Object.entries(TABLE)) {
      const [, , , value, wire, method] = SAMPLE[id] as [string, unknown, unknown, unknown, string, string];
      for (const bus of BUSES) {
        const entry = buses[bus];
        const transport = new FakeTransport().script(method as "setNumeric", accepted);
        const result = writeAny(new OperationContext(transport, "URX44"), id, { bus }, value);
        const label = `${id} ${bus}`;
        if (entry?.[2] === true) {
          expect((await result).planned, label).toEqual(value);
          expect(transport.calls.map(({ method: m, address, value: sent }) => ({ m, address, sent })), label).toEqual([
            { m: method, address: { paramId: entry[0], x: "0", y: `${entry[1]}` }, sent: wire },
          ]);
        } else {
          // bus.type has no bound write at all: a known read-only setting, unsupported like the others.
          expect((await failureOf(result))?.code, label).toBe("unsupported_operation");
          expect(transport.calls, label).toEqual([]);
        }
      }
    }
  });

  it("assign each input channel to STEREO at its own switch", async () => {
    for (const model of models) {
      for (const [kind, list, paramId] of [
        ["mono", MONO_CHANNELS[model], 142],
        ["stereo", STEREO_CHANNELS[model], 269],
      ] as const) {
        for (const [position, channel] of list.entries()) {
          const transport = new FakeTransport().script("getNumeric", read("1")).script("setNumeric", accepted);
          const c = new OperationContext(transport, model);
          expect((await readAny(c, "channel.stereo-assign", { channel })).value).toBe(true);
          await writeAny(c, "channel.stereo-assign", { channel }, false);
          const at = { paramId, x: "0", y: `${kind === "mono" ? channel - 1 : position}` };
          expect(transport.calls.map(({ address, value }) => ({ address, value }))).toEqual([
            { address: at, value: undefined },
            { address: at, value: "0" },
          ]);
        }
      }
    }
    expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "channel.stereo-assign", { channel: 5, side: "left" })))?.code).toBe(
      "invalid_input",
    );
  });

  it("refuse unknown buses and extra selectors, and check values the F03-K and level rules define", async () => {
    const none = new FakeTransport();
    const c = new OperationContext(none, "URX44");
    for (const target of [{ bus: "monitor" }, { bus: "mix-3" }, { bus: "MIX-1" }, { bus: 1 }, {}, { bus: "stereo", side: "left" }, { bus: "mix-1", channel: 1 }]) {
      expect((await failureOf(readAny(c, "bus.on", target)))?.code, JSON.stringify(target)).toBe("invalid_input");
    }
    expect(none.calls).toEqual([]);
    const stereo = { bus: "stereo" };
    expect([plan("bus.fader", stereo, -96), plan("bus.fader", stereo, 10), plan("bus.fader", stereo, -12.345), plan("bus.fader", stereo, "-inf")]).toEqual([
      -96, 10, -12.35, "-inf",
    ]);
    for (const bad of [-96.5, 10.01, "-Infinity"]) {
      expect(() => plan("bus.fader", stereo, bad), String(bad)).toThrow(/invalid_input/);
    }
    expect([plan("bus.balance", stereo, 0.5), plan("bus.balance", stereo, -63)]).toEqual([0, -63]);
    expect(() => plan("bus.balance", stereo, 64)).toThrow(/invalid_input/);
    // F03-K: exactly 0 … 8 scalar values, sent as given; empty text is sent explicitly.
    expect([plan("bus.name", stereo, ""), plan("bus.name", stereo, " a b "), plan("bus.name", stereo, "12345678")]).toEqual(["", " a b ", "12345678"]);
    for (const bad of ["123456789", "a\nb", "\u0007", "\ud800", 1]) {
      expect(() => plan("bus.name", stereo, bad), JSON.stringify(bad)).toThrow(/invalid_input/);
    }
    const preset = new FakeTransport().script("getName", read({ kind: "integer", value: "3" }));
    expect((await readAny(new OperationContext(preset, "URX44"), "bus.name", { bus: "fx-1" })).value).toEqual({ kind: "preset", presetIndex: "3" });
    for (const [id, raw] of [
      ["bus.fader", "-9601"],
      ["bus.fader", "1001"],
      ["bus.balance", "64"],
      ["bus.on", "2"],
      ["bus.type", "2"],
      ["bus.color", "11"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), id, { bus: "mix-1" })))?.code, `${id} ${raw}`).toBe("invalid_response");
    }
  });

  it("type a bus without the setting as undefined, and share one level and PAN/BAL rule", () => {
    const rule = BUS_RULES["bus.type"];
    const checks = () => {
      for (const bus of rule.known) {
        // @ts-expect-error a known bus may have no address for this setting
        void rule.address[bus].write;
        void rule.address[bus]?.write;
      }
    };
    expect(typeof checks).toBe("function");
    expect(rule.address["stereo"]).toBeUndefined();
    // One definition of the level and PAN/BAL rules, built from the channel constants.
    expect(BUS_RULES["bus.fader"].value).toBe(FADER_LEVEL_RULE);
    expect(SEND_RULES["send.level"].value).toBe(FADER_LEVEL_RULE);
    expect(BUS_RULES["bus.balance"].value).toBe(PAN_RULE);
    expect(SEND_RULES["send.pan"].value).toBe(PAN_RULE);
    expect([FADER_LEVEL_RULE.min, FADER_LEVEL_RULE.max, FADER_LEVEL_RULE.sentinel.raw]).toEqual([FADER_DB.min, FADER_DB.max, FADER_NEGATIVE_INFINITY_RAW]);
    expect([PAN_RULE.min, PAN_RULE.max]).toEqual([PAN_RANGE.min, PAN_RANGE.max]);
  });
});

