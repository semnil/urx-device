import { describe, expect, it } from "vitest";
import { MONO_CHANNELS, STEREO_CHANNELS } from "../src/catalog/channels.js";
import { INSERT_FX_RULES } from "../src/catalog/insert-fx.js";
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

  it("read the output selectors at STEREO and the MIX representative; write STEREO only, each at its own address", async () => {
    const at = { stereo: [578, 577, "0", true], "mix-1": [671, 670, "0", false], "mix-2": [671, 670, "2", false] } as const;
    const sent = (transport: FakeTransport) => transport.calls.map(({ address, value }) => ({ address, value }));
    for (const model of models) {
      for (const [bus, [type, on, y, writable]] of Object.entries(at)) {
        const typeAt = { paramId: type, x: "0", y };
        const onAt = { paramId: on, x: "0", y };
        for (const [token, raw] of Object.entries(OUTPUT)) {
          const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
          const c = new OperationContext(transport, model);
          expect((await readAny(c, "bus.insert-fx.type", { bus })).value, `${model} ${bus} ${token}`).toBe(token);
          const write = writeAny(c, "bus.insert-fx.type", { bus }, token);
          if (writable) {
            await write;
            expect(sent(transport), `${model} ${bus} ${token}`).toEqual([
              { address: typeAt, value: undefined },
              { address: typeAt, value: raw },
            ]);
          } else {
            expect((await failureOf(write))?.code, `${model} ${bus} ${token}`).toBe("unsupported_operation");
            expect(sent(transport)).toEqual([{ address: typeAt, value: undefined }]);
          }
        }
        for (const [value, raw] of [[true, "1"], [false, "0"]] as const) {
          const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
          const c = new OperationContext(transport, model);
          expect((await readAny(c, "bus.insert-fx.on", { bus })).value, `${model} ${bus} on ${raw}`).toBe(value);
          const write = writeAny(c, "bus.insert-fx.on", { bus }, value);
          if (writable) {
            await write;
            expect(sent(transport), `${model} ${bus} on ${raw}`).toEqual([
              { address: onAt, value: undefined },
              { address: onAt, value: raw },
            ]);
          } else {
            expect((await failureOf(write))?.code, `${model} ${bus} on ${raw}`).toBe("unsupported_operation");
            expect(sent(transport)).toEqual([{ address: onAt, value: undefined }]);
          }
        }
      }
      for (const bus of ["fx-1", "fx-2", "stream"]) {
        const none = new FakeTransport();
        const c = new OperationContext(none, model);
        for (const id of ["bus.insert-fx.type", "bus.insert-fx.on"]) {
          expect((await failureOf(readAny(c, id, { bus })))?.code, `${model} ${id} ${bus}`).toBe("unsupported_operation");
          expect((await failureOf(writeAny(c, id, { bus }, id.endsWith(".on") ? true : "none")))?.code, `${model} ${id} ${bus}`).toBe(
            "unsupported_operation",
          );
        }
        expect(none.calls).toEqual([]);
      }
      // MONITOR buses are known (F08-M: monitor-1 / monitor-2) and take no Insert-FX; a bare `monitor` is an unknown name.
      const none = new FakeTransport();
      for (const id of ["bus.insert-fx.type", "bus.insert-fx.on"]) {
        for (const bus of ["monitor-1", "monitor-2"]) {
          const c = new OperationContext(none, model);
          expect((await failureOf(readAny(c, id, { bus })))?.code, `${id} ${bus}`).toBe("unsupported_operation");
          expect((await failureOf(writeAny(c, id, { bus }, id.endsWith(".on") ? true : "none")))?.code, `${id} ${bus}`).toBe("unsupported_operation");
        }
        expect((await failureOf(readAny(new OperationContext(none, model), id, { bus: "monitor" })))?.code, id).toBe("invalid_input");
      }
      expect(none.calls).toEqual([]);
    }
  });

  it("carry the F06-I definition limits of every token each target takes, none included", () => {
    const amp = { maxRateHz: 96000, monoOnly: true, slot: "input-amp" };
    const input = INSERT_FX_RULES["channel.insert-fx.type"].value;
    const output = INSERT_FX_RULES["bus.insert-fx.type"].value;
    const none = { maxRateHz: null, monoOnly: false, slot: null };
    expect(input.limits).toEqual({
      none,
      clean: amp,
      crunch: amp,
      lead: amp,
      drive: amp,
      "pitch-fix": { maxRateHz: 48000, monoOnly: true, slot: "input-pitch" },
      "compander-h": { maxRateHz: 96000, monoOnly: false, slot: "input-compander" },
      "compander-s": { maxRateHz: 96000, monoOnly: false, slot: "input-compander" },
    });
    const dynamics = { maxRateHz: 96000, monoOnly: false, slot: "output-dynamics" };
    expect(output.limits).toEqual({ none, "compander-h": dynamics, "compander-s": dynamics, "multi-band-comp": dynamics });
    // The same rules through the public catalog, and a limit for exactly the tokens each target takes:
    // an unknown name, an inherited object key or the other target's effect gives undefined.
    const inherited = Object.getOwnPropertyNames(Object.prototype);
    expect(inherited).toContain("toString");
    for (const id of ["channel.insert-fx.type", "bus.insert-fx.type"] as const) {
      const rule = settingDefinitions[id].rule;
      expect(rule).toBe(INSERT_FX_RULES[id]);
      expect(Object.keys(rule.value.limits ?? {}).sort()).toEqual(["none", ...rule.value.choices.map((choice) => choice.token)].sort());
      const absent = [...inherited, "bypass", id.startsWith("channel") ? "multi-band-comp" : "clean"];
      for (const token of absent) {
        expect(rule.value.limits?.[token], `${id} ${token}`).toBeUndefined();
      }
    }
  });

  it("type a known bus without an Insert-FX address as undefined, through both public paths", () => {
    const checks = () => {
      for (const rule of [INSERT_FX_RULES["bus.insert-fx.type"], settingDefinitions["bus.insert-fx.on"].rule]) {
        for (const bus of rule.known) {
          // @ts-expect-error a known bus may have no address for this setting
          void rule.address[bus].write;
          void rule.address[bus]?.write;
        }
      }
    };
    expect(typeof checks).toBe("function");
    expect(INSERT_FX_RULES["bus.insert-fx.on"].address["fx-1"]).toBeUndefined();
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
