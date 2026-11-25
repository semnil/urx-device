import { describe, expect, it } from "vitest";
import { MONO_CHANNELS, STEREO_CHANNELS } from "../src/catalog/channels.js";
import { ATTACK_STOPS_RAW, DUCKER_DECAY_STOPS_RAW } from "../src/catalog/dynamics-stops.js";
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
const plan = (id: string, value: unknown, model = "URX44") =>
  previewSetting(model, ...([id, { channel: STEREO_CHANNELS[model as "URX44"][0] }, value] as unknown as WriteArgs)).planned;
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

/** The F04-U table: [id, paramId, a value, its wire value]. */
const fields = [
  ["channel.ducker.on", 258, true, "1"],
  ["channel.ducker.key-source", 259, "mix-1", "288"],
  ["channel.ducker.threshold", 260, -12, "-1200"],
  ["channel.ducker.range", 261, -70, "-7000"],
  ["channel.ducker.attack", 262, 80, "80000"],
  ["channel.ducker.decay", 263, 5000, "50000"],
] as const;

describe("DUCKER (F04-U)", () => {
  it("read and write each field once at its fixed stereo address; mono and a side are refused", async () => {
    for (const model of models) {
      for (const [position, channel] of STEREO_CHANNELS[model].entries()) {
        for (const [id, paramId, value, raw] of fields) {
          const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
          transport.timers = false;
          const c = new OperationContext(transport, model);
          expect((await readAny(c, id, { channel })).value, `${model} ${channel} ${id}`).toBe(value);
          expect((await writeAny(c, id, { channel }, value)).planned).toBe(value);
          const at = { paramId, x: "0", y: `${position}` };
          expect(transport.calls.map(({ method, address, value: sent }) => ({ method, address, value: sent }))).toEqual([
            { method: "getNumeric", address: at, value: undefined },
            { method: "setNumeric", address: at, value: raw },
          ]);
        }
      }
      const none = new FakeTransport();
      const c = new OperationContext(none, model);
      for (const [id] of fields) {
        for (const channel of MONO_CHANNELS[model]) {
          expect((await failureOf(readAny(c, id, { channel })))?.code, `${id} ${channel}`).toBe("unsupported_operation");
        }
        const first = STEREO_CHANNELS[model][0] as number;
        for (const target of [{ channel: first, side: "left" }, { channel: first + 1 }, { channel: 0 }]) {
          expect((await failureOf(readAny(c, id, target)))?.code, `${id} ${JSON.stringify(target)}`).toBe("invalid_input");
        }
      }
      expect(none.calls).toEqual([]);
    }
  });

  it("map every key-source token to its untagged identifier per model", async () => {
    const expected = {
      URX22: { "channel-1": 0, "channel-2": 1, "channel-3": 2, "channel-5": 4, "channel-7": 6, "channel-9": 8 },
      URX44: { "channel-1": 0, "channel-2": 1, "channel-3": 2, "channel-4": 3, "channel-5": 4, "channel-7": 6, "channel-9": 8, "channel-11": 10 },
    } as const;
    for (const model of models) {
      const table = { ...(model === "URX22" ? expected.URX22 : expected.URX44), stereo: 256, "mix-1": 288, "mix-2": 290, none: 4294967295 };
      const channel = STEREO_CHANNELS[model][1] as number;
      for (const [token, id] of Object.entries(table)) {
        const transport = new FakeTransport()
          .script("setNumeric", accepted)
          .script("getNumeric", read(`${id}`), read(`${token === "none" ? id : id + 0x80000000}`));
        const c = new OperationContext(transport, model);
        await writeAny(c, "channel.ducker.key-source", { channel }, token);
        expect(transport.calls[0]?.value, `${model} ${token}`).toBe(`${id}`);
        expect((await readAny(c, "channel.ducker.key-source", { channel })).value, `${model} ${token}`).toBe(token);
        expect((await readAny(c, "channel.ducker.key-source", { channel })).value, `${model} tagged ${token}`).toBe(token);
      }
      // Right-hand identifiers, unknown and out-of-range values are malformed.
      const rights = model === "URX22" ? [3, 5, 7, 9, 257, 289, 291, 10] : [5, 7, 9, 11, 257, 289, 291, 12];
      for (const raw of [...rights.map(String), "4294967296", "-1", "2147483903"]) {
        const transport = new FakeTransport().script("getNumeric", read(raw));
        expect((await failureOf(readAny(new OperationContext(transport, model), "channel.ducker.key-source", { channel })))?.code, `${model} ${raw}`).toBe(
          "invalid_response",
        );
      }
    }
    expect(() => plan("channel.ducker.key-source", "channel-11", "URX22")).toThrow(/unsupported_operation/);
    expect(() => plan("channel.ducker.key-source", "channel-4", "URX22")).toThrow(/unsupported_operation/);
    for (const bad of ["channel-6", "channel-12", "channel-01", "stream", "monitor", "Mix-1", 4, "4294967295"]) {
      expect(() => plan("channel.ducker.key-source", bad), String(bad)).toThrow(/invalid_input/);
    }
  });

  it("plan levels on 1 dB and times on their stops, range first with lower ties; reads keep wire precision", async () => {
    expect([plan("channel.ducker.threshold", -60), plan("channel.ducker.threshold", -12.5), plan("channel.ducker.threshold", -12.49)]).toEqual([-60, -13, -12]);
    expect([plan("channel.ducker.range", -70), plan("channel.ducker.range", 0)]).toEqual([-70, 0]);
    for (const [id, bad] of [
      ["channel.ducker.threshold", -60.01],
      ["channel.ducker.threshold", 0.01],
      ["channel.ducker.range", -70.01],
      ["channel.ducker.range", "-inf"],
      ["channel.ducker.attack", 0.091],
      ["channel.ducker.decay", 1.29],
      ["channel.ducker.decay", 5000.1],
    ] as const) {
      expect(() => plan(id, bad), `${id} ${bad}`).toThrow();
    }
    expect([plan("channel.ducker.decay", 1.35), plan("channel.ducker.decay", 1.3501)]).toEqual([1.3, 1.4]);
    expect(plan("channel.ducker.attack", (ATTACK_STOPS_RAW[0] as number) / 1000)).toBe(0.092);
    expect(DUCKER_DECAY_STOPS_RAW.length).toBe(122);
    for (const [id, raw, value] of [
      ["channel.ducker.threshold", "-1234", -12.34],
      ["channel.ducker.threshold", "-6000", -60],
      ["channel.ducker.range", "-6999", -69.99],
      ["channel.ducker.attack", "93", 0.093],
      ["channel.ducker.decay", "21", 2.1],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await readAny(new OperationContext(transport, "URX44"), id, { channel: 5 })).value, `${id} ${raw}`).toBe(value);
    }
    for (const [id, raw] of [
      ["channel.ducker.threshold", "-6001"],
      ["channel.ducker.range", "-7001"],
      ["channel.ducker.range", "-32768"],
      ["channel.ducker.attack", "91"],
      ["channel.ducker.decay", "12"],
      ["channel.ducker.decay", "50001"],
      ["channel.ducker.on", "2"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), id, { channel: 5 })))?.code, `${id} ${raw}`).toBe("invalid_response");
    }
  });
});
