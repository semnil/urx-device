import { describe, expect, it } from "vitest";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { dryRunSetting, previewSetting, readSetting, writeSetting, type ReadArgs, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const readAny = (c: OperationContext, id: string, target: unknown) => readSetting(c, ...([id, target] as unknown as ReadArgs));
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as WriteArgs));
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}
const at = (paramId: number) => ({ paramId, x: "0", y: "0" });

const FIELDS = [
  ["device.brightness", 758, "10", 10, ["URX22", "URX44", "URX44V"]],
  ["device.auto-power-off", 760, "1", true, ["URX22", "URX44", "URX44V"]],
  ["device.auto-power-off-time", 761, "20", 20, ["URX22", "URX44", "URX44V"]],
  ["device.language", 795, "2", "zh-cn", ["URX22", "URX44", "URX44V"]],
  ["device.usb-suppression", 812, "1", "2-channels", ["URX22", "URX44", "URX44V"]],
  ["device.date-format", 787, "2", "yyyy/mm/dd", ["URX44", "URX44V"]],
  ["device.time-format", 788, "1", "12h", ["URX44", "URX44V"]],
  ["device.time-zone-index", 831, "153", 153, ["URX44", "URX44V"]],
  ["device.hdmi-hdcp", 767, "0", false, ["URX44V"]],
  ["device.hdmi-input-channels", 768, "1", "multi-channels", ["URX44V"]],
] as const;

describe("device utility and HDMI settings (F11-U, F11-H)", () => {
  it("read and write each field once on the models that have it", async () => {
    for (const [id, paramId, raw, value, models] of FIELDS) {
      for (const model of ["URX22", "URX44", "URX44V"] as const) {
        const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
        const c = new OperationContext(transport, model);
        if (!(models as readonly string[]).includes(model)) {
          expect((await failureOf(readAny(c, id, {})))?.code, `${model} ${id}`).toBe("unsupported_operation");
          expect((await failureOf(writeAny(c, id, {}, value)))?.code, `${model} ${id}`).toBe("unsupported_operation");
          expect(transport.calls).toEqual([]);
          continue;
        }
        expect((await readAny(c, id, {})).value, `${model} ${id}`).toBe(value);
        await writeAny(c, id, {}, value);
        expect(transport.calls.map(({ address, value: sent }) => ({ address, sent }))).toEqual([
          { address: at(paramId), sent: undefined },
          { address: at(paramId), sent: raw },
        ]);
      }
    }
    const plan = (id: string, value: unknown) => previewSetting("URX44", ...([id, {}, value] as unknown as WriteArgs)).planned;
    expect([plan("device.brightness", 0), plan("device.auto-power-off-time", 2), plan("device.auto-power-off-time", 2.5), plan("device.time-zone-index", 0)]).toEqual([0, 2, 2, 0]);
    for (const [id, bad] of [
      ["device.brightness", 11],
      ["device.auto-power-off-time", 1],
      ["device.auto-power-off-time", 21],
      ["device.time-zone-index", 154],
      ["device.language", "zh"],
      ["device.usb-suppression", "2"],
    ] as const) {
      expect(() => plan(id, bad), `${id} ${bad}`).toThrow(/invalid_input/);
    }
    expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "device.brightness", { bus: "stereo" })))?.code).toBe("invalid_input");
  });
});

describe("clock (F11-C) and Console Lock read (F20-L)", () => {
  /** A clock write through replies to its prerequisite reads; the outcome and request methods/addresses. */
  async function clock(model: string, id: string, value: unknown, ...prerequisites: string[]) {
    const transport = new FakeTransport().script("getNumeric", ...prerequisites.map(read)).script("setNumeric", accepted);
    const outcome = await writeAny(new OperationContext(transport, model), id, {}, value).then(
      (result) => ({ planned: result.planned }),
      (error: unknown) => ({ code: operationFailureOf(error)?.code }),
    );
    return { outcome, calls: transport.calls.map(({ method, address, value: sent }) => ({ method, paramId: address.paramId, sent })) };
  }

  it("write the sample rate after Follow USB off and, on URX44/V, a stopped recorder", async () => {
    expect(await clock("URX44", "device.sample-rate", 48000, "0", "0")).toEqual({
      outcome: { planned: 48000 },
      calls: [
        { method: "getNumeric", paramId: 848, sent: undefined },
        { method: "getNumeric", paramId: 836, sent: undefined },
        { method: "setNumeric", paramId: 766, sent: "48000" },
      ],
    });
    expect((await clock("URX22", "device.sample-rate", 192000, "0")).calls.map((call) => call.paramId)).toEqual([848, 766]);
    expect(await clock("URX44", "device.sample-rate", 96000, "1")).toEqual({
      outcome: { code: "precondition_failed" },
      calls: [{ method: "getNumeric", paramId: 848, sent: undefined }],
    });
    for (const state of ["1", "2", "3", "4", "5"]) {
      const result = await clock("URX44V", "device.sample-rate", 96000, "0", state);
      expect(result.outcome, state).toEqual({ code: "precondition_failed" });
      expect(result.calls.length).toBe(2);
    }
    expect((await clock("URX44", "device.sample-rate", 96000, "2")).outcome).toEqual({ code: "invalid_response" });
    expect((await clock("URX44", "device.sample-rate", 96000, "0", "6")).outcome).toEqual({ code: "invalid_response" });
    for (const bad of [46000, 46050, 48001, "48000", 48000.5]) {
      const result = await clock("URX44", "device.sample-rate", bad, "0", "0");
      expect(result, String(bad)).toEqual({ outcome: { code: "invalid_input" }, calls: [] });
    }
    expect(await clock("URX44", "device.follow-usb", true, "0")).toEqual({
      outcome: { planned: true },
      calls: [
        { method: "getNumeric", paramId: 836, sent: undefined },
        { method: "setNumeric", paramId: 848, sent: "1" },
      ],
    });
    expect((await clock("URX22", "device.follow-usb", false)).calls).toEqual([{ method: "setNumeric", paramId: 848, sent: "0" }]);
    expect((await clock("URX44", "device.follow-usb", false, "3")).outcome).toEqual({ code: "precondition_failed" });
  });

  it("dry-run the clock with its reads and no write; read the rate and lock strictly", async () => {
    const transport = new FakeTransport().script("getNumeric", read("0"), read("0"));
    expect(await dryRunSetting(new OperationContext(transport, "URX44"), "device.sample-rate", {}, 176400)).toEqual({ requested: 176400, planned: 176400 });
    expect(transport.calls.map((call) => call.address.paramId)).toEqual([848, 836]);
    expect(() => previewSetting("URX44", "device.sample-rate", {}, 48000)).toThrow(/invalid_input/);
    for (const [id, raw, value] of [
      ["device.sample-rate", "44100", 44100],
      ["device.sample-rate", "192000", 192000],
      ["device.console-lock", "1", true],
      ["device.console-lock", "0", false],
    ] as const) {
      const t = new FakeTransport().script("getNumeric", read(raw));
      expect((await readAny(new OperationContext(t, "URX22"), id, {})).value, `${id} ${raw}`).toBe(value);
      expect(t.calls.length).toBe(1);
    }
    for (const [id, raw] of [
      ["device.sample-rate", "46000"],
      ["device.sample-rate", "-48000"],
      ["device.console-lock", "2"],
      ["device.follow-usb", "2"],
    ] as const) {
      const t = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(t, "URX44"), id, {})))?.code, `${id} ${raw}`).toBe("invalid_response");
    }
    // Console Lock has no write: a known read-only setting.
    expect((await failureOf(writeAny(new OperationContext(new FakeTransport(), "URX44"), "device.console-lock", {}, false)))?.code).toBe("unsupported_operation");
  });
});
