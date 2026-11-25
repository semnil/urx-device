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
const plan = (id: string, target: object, value: unknown) => previewSetting("URX44", ...([id, target, value] as unknown as WriteArgs)).planned;
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

const INPUT = { none: "4294967295", clean: "256", crunch: "257", lead: "258", drive: "259", "pitch-fix": "512", "compander-h": "1793", "compander-s": "1794" };
const OUTPUT = { none: "4294967295", "compander-h": "1793", "compander-s": "1794", "multi-band-comp": "1792" };

describe("Insert-FX selector and on (F06-I)", () => {
  it("read and write every input token on every mono channel at 135 / 134", async () => {
    for (const model of models) {
      for (const channel of MONO_CHANNELS[model]) {
        for (const [token, raw] of Object.entries(INPUT)) {
          const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
          const c = new OperationContext(transport, model);
          expect((await readAny(c, "channel.insert-fx.type", { channel })).value, `${model} ${channel} ${token}`).toBe(token);
          await writeAny(c, "channel.insert-fx.type", { channel }, token);
          const at = { paramId: 135, x: "0", y: `${channel - 1}` };
          expect(transport.calls.map(({ address, value }) => ({ address, value }))).toEqual([
            { address: at, value: undefined },
            { address: at, value: raw },
          ]);
        }
        const on = new FakeTransport().script("getNumeric", read("0")).script("setNumeric", accepted);
        const c = new OperationContext(on, model);
        expect((await readAny(c, "channel.insert-fx.on", { channel })).value).toBe(false);
        await writeAny(c, "channel.insert-fx.on", { channel }, true);
        expect(on.calls.map(({ address, value }) => ({ address, value }))).toEqual([
          { address: { paramId: 134, x: "0", y: `${channel - 1}` }, value: undefined },
          { address: { paramId: 134, x: "0", y: `${channel - 1}` }, value: "1" },
        ]);
      }
      const none = new FakeTransport();
      for (const channel of STEREO_CHANNELS[model]) {
        expect((await failureOf(readAny(new OperationContext(none, model), "channel.insert-fx.type", { channel })))?.code).toBe("unsupported_operation");
      }
      expect(none.calls).toEqual([]);
    }
  });

  it("read the output selectors at STEREO and the MIX representative; write STEREO only", async () => {
    const at = { stereo: [578, 577, "0", true], "mix-1": [671, 670, "0", false], "mix-2": [671, 670, "2", false] } as const;
    for (const [bus, [type, on, y, writable]] of Object.entries(at)) {
      for (const [token, raw] of Object.entries(OUTPUT)) {
        const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
        const c = new OperationContext(transport, "URX44");
        expect((await readAny(c, "bus.insert-fx.type", { bus })).value, `${bus} ${token}`).toBe(token);
        const write = writeAny(c, "bus.insert-fx.type", { bus }, token);
        if (writable) {
          await write;
          expect(transport.calls[1]?.value).toBe(raw);
        } else {
          expect((await failureOf(write))?.code, `${bus} ${token}`).toBe("unsupported_operation");
          expect(transport.calls.length).toBe(1);
        }
        expect(transport.calls[0]?.address).toEqual({ paramId: type, x: "0", y });
      }
      const transport = new FakeTransport().script("getNumeric", read("1"));
      expect((await readAny(new OperationContext(transport, "URX44"), "bus.insert-fx.on", { bus })).value).toBe(true);
      expect(transport.calls[0]?.address).toEqual({ paramId: on, x: "0", y });
    }
    for (const bus of ["fx-1", "fx-2", "stream"]) {
      expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "bus.insert-fx.type", { bus })))?.code, bus).toBe(
        "unsupported_operation",
      );
    }
  });

  it("refuse an effect on the wrong target and unknown tokens; read only listed selector values", async () => {
    for (const token of ["multi-band-comp"]) {
      expect(() => plan("channel.insert-fx.type", { channel: 1 }, token)).toThrow(/unsupported_operation/);
    }
    for (const token of ["clean", "crunch", "lead", "drive", "pitch-fix"]) {
      expect(() => plan("bus.insert-fx.type", { bus: "stereo" }, token), token).toThrow(/unsupported_operation/);
    }
    for (const bad of ["Clean", "compander", "bypass", "256", 256, null]) {
      expect(() => plan("channel.insert-fx.type", { channel: 1 }, bad), String(bad)).toThrow(/invalid_input/);
    }
    for (const [id, target, raw] of [
      ["channel.insert-fx.type", { channel: 1 }, "1792"],
      ["channel.insert-fx.type", { channel: 1 }, "-1"],
      ["channel.insert-fx.type", { channel: 1 }, "260"],
      ["bus.insert-fx.type", { bus: "stereo" }, "256"],
      ["bus.insert-fx.type", { bus: "stereo" }, "2147483904"],
      ["channel.insert-fx.on", { channel: 1 }, "2"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), id, target)))?.code, `${id} ${raw}`).toBe("invalid_response");
    }
    expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "channel.insert-fx.type", { channel: 1, side: "left" })))?.code).toBe(
      "invalid_input",
    );
  });
});
