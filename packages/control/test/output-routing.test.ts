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
const plan = (id: string, target: object, value: unknown, model = "URX44") => previewSetting(model, ...([id, target, value] as unknown as WriteArgs)).planned;
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}
const at = (paramId: number, y: number) => ({ paramId, x: "0", y: `${y}` });

describe("STREAMING delay (F07-D)", () => {
  it("read and write on, time and frame rate once at their own addresses", async () => {
    for (const [id, paramId, raw, value] of [
      ["bus.delay.on", 707, "1", true],
      ["bus.delay.time", 708, "341", 3.41],
      ["bus.delay.time", 708, "100000", 1000],
      ["bus.delay.frame-rate", 830, "2", "29.97d"],
      ["bus.delay.frame-rate", 830, "7", "120"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
      const c = new OperationContext(transport, "URX44");
      expect((await readAny(c, id, { bus: "stream" })).value, `${id} ${raw}`).toBe(value);
      await writeAny(c, id, { bus: "stream" }, value);
      expect(transport.calls.map(({ address, value: sent }) => ({ address, sent }))).toEqual([
        { address: at(paramId, 0), sent: undefined },
        { address: at(paramId, 0), sent: raw },
      ]);
    }
    const stream = { bus: "stream" };
    expect([plan("bus.delay.time", stream, 1.005), plan("bus.delay.time", stream, 1.0051), plan("bus.delay.time", stream, 1)]).toEqual([1, 1.01, 1]);
    for (const bad of [0.99, 1000.01, Infinity]) {
      expect(() => plan("bus.delay.time", stream, bad), String(bad)).toThrow(/invalid_input/);
    }
    for (const bad of ["29.97D", "30fps", "29.970", "24.0"]) {
      expect(() => plan("bus.delay.frame-rate", stream, bad), bad).toThrow(/invalid_input/);
    }
    for (const [id, raw] of [
      ["bus.delay.time", "99"],
      ["bus.delay.time", "100001"],
      ["bus.delay.frame-rate", "8"],
      ["bus.delay.on", "2"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), id, stream)))?.code, `${id} ${raw}`).toBe("invalid_response");
    }
    for (const bus of ["stereo", "mix-1", "fx-1"]) {
      expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "bus.delay.time", { bus })))?.code, bus).toBe("unsupported_operation");
    }
  });
});

describe("output and STREAMING source lanes (F07-R)", () => {
  /** Every lane a model reads, with its untagged port. */
  function lanes(model: (typeof models)[number]): [string, number][] {
    const buses: [string, number][] = [
      ["stereo", 256],
      ["stream", 258],
      ["mix-1", 288],
      ["mix-2", 290],
      ["monitor-1", 336],
      ["monitor-2", 338],
    ];
    return [
      ...buses.flatMap(([bus, port]): [string, number][] => [
        [`${bus}-left`, port],
        [`${bus}-right`, port + 1],
      ]),
      ...MONO_CHANNELS[model].map((n): [string, number] => [`channel-${n}`, n - 1]),
      ...STEREO_CHANNELS[model].flatMap((n): [string, number][] => [
        [`channel-${n}-left`, n - 1],
        [`channel-${n}-right`, n],
      ]),
    ];
  }
  const OUTPUTS = { main: 730, line: 731, "usb-main-a": 732, "usb-main-b": 733, "usb-main-c": 734, "usb-sub": 735 } as const;

  it("read every model-present lane, plain or tagged, at each destination side", async () => {
    for (const model of models) {
      for (const [output, paramId] of Object.entries(OUTPUTS)) {
        for (const [y, side] of [
          [0, "left"],
          [1, "right"],
        ] as const) {
          const target = { output, side };
          if (output === "line" && model === "URX22") {
            expect((await failureOf(readAny(new OperationContext(new FakeTransport(), model), "output.source", target)))?.code).toBe("unsupported_operation");
            continue;
          }
          for (const [token, port] of [...lanes(model), ["none", 4294967295] as [string, number]]) {
            for (const raw of token === "none" ? [`${port}`] : [`${port}`, `${port + 0x80000000}`]) {
              const transport = new FakeTransport().script("getNumeric", read(raw));
              transport.timers = false;
              expect((await readAny(new OperationContext(transport, model), "output.source", target)).value, `${model} ${output} ${side} ${raw}`).toBe(token);
              expect(transport.calls[0]?.address).toEqual(at(paramId, y));
            }
          }
        }
      }
    }
    for (const [model, raw] of [
      ["URX22", "11"],
      ["URX22", "10"],
      ["URX44", "12"],
      ["URX44", "340"],
      ["URX44", "512"],
      ["URX44", "-1"],
      ["URX44", "4294967296"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, model), "output.source", { output: "main", side: "left" })))?.code, `${model} ${raw}`).toBe(
        "invalid_response",
      );
    }
  });

  it("write each destination's own list once, untagged to outputs and tagged to STREAMING", async () => {
    const write = async (id: string, target: object, value: string, model = "URX44") => {
      const transport = new FakeTransport().script("setNumeric", accepted);
      const outcome = await writeAny(new OperationContext(transport, model), id, target, value).then(
        () => "accepted",
        (error: unknown) => operationFailureOf(error)?.code,
      );
      return { outcome, calls: transport.calls.map(({ address, value: sent }) => ({ address, sent })) };
    };
    expect(await write("output.source", { output: "main", side: "right" }, "monitor-1-left")).toEqual({
      outcome: "accepted",
      calls: [{ address: at(730, 1), sent: "336" }],
    });
    expect(await write("output.source", { output: "usb-main-a", side: "right" }, "channel-2")).toEqual({
      outcome: "accepted",
      calls: [{ address: at(732, 1), sent: "1" }],
    });
    expect((await write("output.source", { output: "usb-sub", side: "left" }, "none")).calls).toEqual([{ address: at(735, 0), sent: "4294967295" }]);
    expect(await write("bus.source", { bus: "stream", side: "left" }, "stereo-left")).toEqual({
      outcome: "accepted",
      calls: [{ address: at(705, 0), sent: "2147483904" }],
    });
    expect((await write("bus.source", { bus: "stream", side: "right" }, "mix-2-right")).calls).toEqual([{ address: at(706, 0), sent: "2147483939" }]);
    for (const [id, target, value, model, code] of [
      ["output.source", { output: "main", side: "left" }, "channel-1", "URX44", "unsupported_operation"],
      ["output.source", { output: "usb-main-a", side: "left" }, "monitor-1-left", "URX44", "unsupported_operation"],
      ["output.source", { output: "usb-main-a", side: "left" }, "channel-11-left", "URX22", "unsupported_operation"],
      ["output.source", { output: "line", side: "left" }, "stereo-left", "URX22", "unsupported_operation"],
      ["bus.source", { bus: "stream", side: "left" }, "none", "URX44", "unsupported_operation"],
      ["bus.source", { bus: "stream", side: "left" }, "channel-1", "URX44", "unsupported_operation"],
      ["bus.source", { bus: "stream", side: "left" }, "stream-left", "URX44", "unsupported_operation"],
      ["bus.source", { bus: "mix-1", side: "left" }, "stereo-left", "URX44", "unsupported_operation"],
      ["output.source", { output: "main", side: "left" }, "stereo", "URX44", "invalid_input"],
      ["output.source", { output: "main", side: "left" }, "channel-6", "URX44", "invalid_input"],
      ["output.source", { output: "phones", side: "left" }, "stereo-left", "URX44", "invalid_input"],
      ["output.source", { output: "main" }, "stereo-left", "URX44", "invalid_input"],
      ["output.source", { output: "main", side: "left", channel: 1 }, "stereo-left", "URX44", "invalid_input"],
    ] as const) {
      const result = await write(id, target, value, model);
      expect(result, `${id} ${JSON.stringify(target)} ${value} ${model}`).toEqual({ outcome: code, calls: [] });
    }
    // A STREAMING NONE is readable though its write is unsupported.
    const transport = new FakeTransport().script("getNumeric", read("4294967295"));
    expect((await readAny(new OperationContext(transport, "URX44"), "bus.source", { bus: "stream", side: "right" })).value).toBe("none");
  });
});
