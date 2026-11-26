import { describe, expect, it } from "vitest";
import { MONO_CHANNELS, STEREO_CHANNELS } from "../src/catalog/channels.js";
import type { BusSideTarget, ChannelTarget } from "../src/catalog/settings.js";
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
const at = (paramId: number, y: number) => ({ paramId, x: "0", y: `${y}` });

/** One read then one write of `value`; the outcome and the requests. */
async function roundTrip(id: string, target: object, raw: string, value: unknown, model = "URX44") {
  const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
  const c = new OperationContext(transport, model);
  const observed = (await readAny(c, id, target)).value;
  await writeAny(c, id, target, value);
  return { observed, calls: transport.calls.map(({ address, value: sent }) => ({ address, sent })) };
}

describe("MONITOR and PHONES (F08-M)", () => {
  it("address each MONITOR field once at y m − 1, and the source at the named side", async () => {
    for (const [m, bus] of [
      [1, "monitor-1"],
      [2, "monitor-2"],
    ] as const) {
      for (const [id, paramId, raw, value, wire] of [
        ["bus.on", 723, "1", true, "1"],
        ["bus.fader", 724, "-32768", "-inf", "-32768"],
        ["bus.mono", 722, "0", false, "0"],
        ["bus.cue-interrupt", 721, "1", true, "1"],
      ] as const) {
        expect(await roundTrip(id, { bus }, raw, value), `${bus} ${id}`).toEqual({
          observed: value,
          calls: [
            { address: at(paramId, m - 1), sent: undefined },
            { address: at(paramId, m - 1), sent: wire },
          ],
        });
      }
      for (const [side, paramId] of [
        ["left", 719],
        ["right", 720],
      ] as const) {
        expect(await roundTrip("bus.source", { bus, side }, "289", "mix-1-left"), `${bus} ${side}`).toEqual({
          observed: "mix-1-right",
          calls: [
            { address: at(paramId, m - 1), sent: undefined },
            { address: at(paramId, m - 1), sent: "288" },
          ],
        });
      }
    }
    expect(plan("bus.fader", { bus: "monitor-1" }, -12.345)).toBe(-12.35);
    expect(() => plan("bus.fader", { bus: "monitor-1" }, -96.5)).toThrow(/invalid_input/);
    expect(plan("bus.source", { bus: "monitor-2", side: "left" }, "none")).toBe("none");
    for (const value of ["stream-left", "channel-1", "monitor-1-left"]) {
      expect(() => plan("bus.source", { bus: "monitor-1", side: "left" }, value), value).toThrow(/unsupported_operation/);
    }
    // A readable lane outside the write list.
    const transport = new FakeTransport().script("getNumeric", read("258"));
    expect((await readAny(new OperationContext(transport, "URX44"), "bus.source", { bus: "monitor-1", side: "left" })).value).toBe("stream-left");
    // MONITOR has no balance, name or other bus capabilities; MONITOR fields take no side.
    for (const [id, target, code] of [
      ["bus.balance", { bus: "monitor-1" }, "unsupported_operation"],
      ["bus.name", { bus: "monitor-1" }, "unsupported_operation"],
      ["bus.mono", { bus: "stereo" }, "unsupported_operation"],
      ["bus.on", { bus: "monitor-1", side: "left" }, "invalid_input"],
      ["bus.on", { bus: "monitor-3" }, "invalid_input"],
    ] as const) {
      expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), id, target)))?.code, `${id} ${JSON.stringify(target)}`).toBe(code);
    }
  });

  it("set the PHONES levels on 0.1 steps; no other output has a level", async () => {
    for (const [y, output] of [
      [0, "phones-1"],
      [1, "phones-2"],
    ] as const) {
      expect(await roundTrip("output.level", { output }, "100", 2.5)).toEqual({
        observed: 10,
        calls: [
          { address: at(725, y), sent: undefined },
          { address: at(725, y), sent: "25" },
        ],
      });
    }
    expect([plan("output.level", { output: "phones-1" }, 2.55), plan("output.level", { output: "phones-1" }, 2.551), plan("output.level", { output: "phones-1" }, 0)]).toEqual([
      2.5, 2.6, 0,
    ]);
    for (const bad of [-0.1, 10.1, "-inf"]) {
      expect(() => plan("output.level", { output: "phones-1" }, bad), String(bad)).toThrow(/invalid_input/);
    }
    for (const [target, code] of [
      [{ output: "main" }, "unsupported_operation"],
      [{ output: "usb-sub" }, "unsupported_operation"],
      [{ output: "phones-3" }, "invalid_input"],
      [{ output: "phones-1", side: "left" }, "invalid_input"],
    ] as const) {
      expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "output.level", target)))?.code, JSON.stringify(target)).toBe(code);
    }
    expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "output.source", { output: "phones-1", side: "left" })))?.code).toBe(
      "unsupported_operation",
    );
    const transport = new FakeTransport().script("getNumeric", read("101"));
    expect((await failureOf(readAny(new OperationContext(transport, "URX44"), "output.level", { output: "phones-1" })))?.code).toBe("invalid_response");
  });
});

describe("CUE flags and mode (F08-C)", () => {
  it("address each channel's and bus's flag representative once, never the mirror", async () => {
    for (const model of models) {
      for (const channel of MONO_CHANNELS[model]) {
        expect((await roundTrip("channel.cue", { channel }, "1", false, model)).calls).toEqual([
          { address: at(138, channel - 1), sent: undefined },
          { address: at(138, channel - 1), sent: "0" },
        ]);
      }
      for (const [position, channel] of STEREO_CHANNELS[model].entries()) {
        expect((await roundTrip("channel.cue", { channel }, "0", true, model)).calls).toEqual([
          { address: at(265, position), sent: undefined },
          { address: at(265, position), sent: "1" },
        ]);
      }
    }
    for (const [bus, paramId, y] of [
      ["fx-1", 336, 0],
      ["fx-2", 336, 1],
      ["stereo", 580, 0],
      ["mix-1", 673, 0],
      ["mix-2", 673, 2],
      ["stream", 709, 0],
    ] as const) {
      expect((await roundTrip("bus.cue", { bus }, "1", true)).calls, bus).toEqual([
        { address: at(paramId, y), sent: undefined },
        { address: at(paramId, y), sent: "1" },
      ]);
    }
    for (const bus of ["monitor-1", "monitor-2"]) {
      expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "bus.cue", { bus })))?.code, bus).toBe("unsupported_operation");
    }
    expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "channel.cue", { channel: 5, side: "left" })))?.code).toBe("invalid_input");
  });

  it("read and write the device-wide mode with an empty target", async () => {
    expect(await roundTrip("cue.mode", {}, "1", "mix")).toEqual({
      observed: "last",
      calls: [
        { address: at(897, 0), sent: undefined },
        { address: at(897, 0), sent: "0" },
      ],
    });
    for (const bad of ["mix-cue", "last-cue", 0, true]) {
      expect(() => plan("cue.mode", {}, bad), String(bad)).toThrow(/invalid_input/);
    }
    for (const target of [{ bus: "stereo" }, { channel: 1 }]) {
      expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "cue.mode", target)))?.code).toBe("invalid_input");
    }
    for (const raw of ["2", "-1"]) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), "cue.mode", {})))?.code, raw).toBe("invalid_response");
    }
  });
  it("type each setting's target as the runtime takes it: a whole bus or output with side undefined, a device-wide setting with no keys", async () => {
    // side: undefined is the omitted side, on a whole bus and on PHONES alike: same single request.
    for (const [id, plain, withSide, paramId] of [
      ["bus.on", { bus: "monitor-1" }, { bus: "monitor-1", side: undefined }, 723],
      ["output.level", { output: "phones-2" }, { output: "phones-2", side: undefined }, 725],
    ] as const) {
      for (const target of [plain, withSide]) {
        const transport = new FakeTransport().script("getNumeric", read("1"));
        await readAny(new OperationContext(transport, "URX44"), id, target);
        expect(transport.calls.map(({ address }) => address.paramId), `${id} ${JSON.stringify(target)}`).toEqual([paramId]);
      }
    }
    const side: BusSideTarget = { bus: "stereo", side: "left" };
    const channel: ChannelTarget = { channel: 1 };
    const checks = () => {
      const c = new OperationContext(new FakeTransport(), "URX44");
      // @ts-expect-error a sided bus target is not a whole-bus target
      void readSetting(c, "bus.on", side);
      // @ts-expect-error a device-wide setting takes no keys
      void readSetting(c, "cue.mode", channel);
      void readSetting(c, "cue.mode", {});
      void readSetting(c, "bus.on", { bus: "stereo" });
    };
    expect(typeof checks).toBe("function");
    // The same refusals at run time, before any request.
    const none = new FakeTransport();
    expect((await failureOf(readAny(new OperationContext(none, "URX44"), "bus.on", side)))?.code).toBe("invalid_input");
    expect((await failureOf(readAny(new OperationContext(none, "URX44"), "cue.mode", channel)))?.code).toBe("invalid_input");
    expect(none.calls).toEqual([]);
  });
});
