import { describe, expect, it } from "vitest";
import { EQ_BANDS } from "../src/catalog/eq.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, validateSetting, writeSetting, type ReadArgs, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const readAny = (c: OperationContext, id: string, target: unknown) => readSetting(c, ...([id, target] as unknown as ReadArgs));
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as WriteArgs));
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}
const BUS = { stereo: [498, 0, true], "mix-1": [591, 0, false], "mix-2": [591, 2, false] } as const;
const FIELDS = [
  ["on", 0, "1", true],
  ["type", 1, "2", "hpf"],
  ["q", 2, "71", 0.71],
  ["frequency", 3, "10004", 1000.4],
  ["gain", 4, "-237", -2.37],
] as const;

describe("output PEQ (F07-P)", () => {
  it("read and write every band field at anchor + 5 + 5i + field; MIX writes are unbound", async () => {
    for (const [bus, [anchor, y, writable]] of Object.entries(BUS)) {
      for (const [ordinal, band] of EQ_BANDS.entries()) {
        for (const [field, offset, raw, value] of FIELDS) {
          const id = `bus.peq.band.${field}`;
          const target = { bus, band };
          if (field === "type" && (band === "low-mid" || band === "high-mid")) {
            expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), id, target)))?.code).toBe("unsupported_operation");
            continue;
          }
          const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
          const c = new OperationContext(transport, "URX44");
          const shown = field === "type" && band === "high" ? "lpf" : value;
          expect((await readAny(c, id, target)).value, `${bus} ${band} ${field}`).toBe(shown);
          const write = writeAny(c, id, target, shown);
          const addressed = { paramId: anchor + 5 + 5 * ordinal + offset, x: "0", y: `${y}` };
          if (writable) {
            await write;
            expect(transport.calls.map(({ address, value: sent }) => ({ address, sent }))).toEqual([
              { address: addressed, sent: undefined },
              { address: addressed, sent: raw },
            ]);
          } else {
            expect((await failureOf(write))?.code, `${bus} ${band} ${field} write`).toBe("unsupported_operation");
            expect(transport.calls.map((call) => call.address)).toEqual([addressed]);
          }
        }
      }
      for (const [field, offset, raw, value] of [
        ["on", 2, "1", true],
        ["type", 3, "2", "loudness"],
        ["level", 4, "50", 50],
      ] as const) {
        const transport = new FakeTransport().script("getNumeric", read(raw));
        expect((await readAny(new OperationContext(transport, "URX44"), `bus.peq.one-knob.${field}`, { bus })).value).toBe(value);
        expect(transport.calls[0]?.address).toEqual({ paramId: anchor + offset, x: "0", y: `${y}` });
      }
    }
  });

  it("refuse a filter type the other band takes as unsupported, and an unknown name as invalid, on bus and channel EQ alike", async () => {
    const cases = [
      ["bus.peq.band.type", { bus: "stereo", band: "low" }, "lpf", "unsupported_operation"],
      ["bus.peq.band.type", { bus: "stereo", band: "high" }, "hpf", "unsupported_operation"],
      ["channel.eq.band.type", { channel: 1, band: "low" }, "lpf", "unsupported_operation"],
      ["channel.eq.band.type", { channel: 1, band: "high" }, "hpf", "unsupported_operation"],
      ["bus.peq.band.type", { bus: "stereo", band: "low" }, "LPF", "invalid_input"],
      ["channel.eq.band.type", { channel: 1, band: "high" }, "notch", "invalid_input"],
    ] as const;
    for (const model of ["URX22", "URX44", "URX44V"] as const) {
      for (const [id, target, value, code] of cases) {
        const label = `${model} ${id} ${JSON.stringify(target)} ${value}`;
        const args = [id, target, value] as unknown as WriteArgs;
        expect(() => previewSetting(model, ...args), label).toThrow(new RegExp(code));
        expect(() => validateSetting(model, ...args), label).toThrow(new RegExp(code));
        const none = new FakeTransport();
        expect((await failureOf(writeSetting(new OperationContext(none, model), ...args)))?.code, label).toBe(code);
        expect(none.calls, label).toEqual([]);
      }
      // The band's own types still plan.
      expect(previewSetting(model, "bus.peq.band.type", { bus: "stereo", band: "low" }, "hpf").planned).toBe("hpf");
      expect(previewSetting(model, "channel.eq.band.type", { channel: 1, band: "high" }, "lpf").planned).toBe("lpf");
    }
  });

  it("check values, wire precision and targets like the channel EQ", async () => {
    const plan = (id: string, value: unknown, band = "low") => previewSetting("URX44", ...([id, { bus: "stereo", band }, value] as unknown as WriteArgs)).planned;
    expect([plan("bus.peq.band.q", 0.715), plan("bus.peq.band.frequency", 1000.45), plan("bus.peq.band.gain", -2.375)]).toEqual([0.71, 1000.4, -2.38]);
    expect(() => plan("bus.peq.band.type", "lpf", "low")).toThrow();
    expect(() => plan("bus.peq.band.gain", 18.01)).toThrow(/invalid_input/);
    for (const [raw, id] of [
      ["1601", "bus.peq.band.q"],
      ["199", "bus.peq.band.frequency"],
      ["3", "bus.peq.band.type"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), id, { bus: "stereo", band: "low" })))?.code, raw).toBe("invalid_response");
    }
    const none = new FakeTransport();
    const c = new OperationContext(none, "URX44");
    for (const [id, target, code] of [
      ["bus.peq.band.gain", { bus: "fx-1", band: "low" }, "unsupported_operation"],
      ["bus.peq.band.gain", { bus: "stereo" }, "invalid_input"],
      ["bus.peq.band.gain", { bus: "stereo", band: "mid" }, "invalid_input"],
      ["bus.peq.band.gain", { bus: "stereo", band: "low", side: "left" }, "invalid_input"],
      ["bus.peq.one-knob.on", { bus: "stereo", band: "low" }, "invalid_input"],
    ] as const) {
      expect((await failureOf(readAny(c, id, target)))?.code, JSON.stringify(target)).toBe(code);
    }
    expect(none.calls).toEqual([]);
    const plain = new FakeTransport().script("getNumeric", read("0"));
    await readAny(new OperationContext(plain, "URX44"), "bus.peq.band.on", { bus: "stereo", band: "high", side: undefined });
    expect(plain.calls.length).toBe(1);
  });
});
