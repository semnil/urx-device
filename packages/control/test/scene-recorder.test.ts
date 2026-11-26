import { describe, expect, it } from "vitest";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting, type ReadArgs, type WriteArgs } from "../src/operations/registry.js";
import { settingHandlers } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const readAny = (c: OperationContext, id: string, target: unknown) => readSetting(c, ...([id, target] as unknown as ReadArgs));
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as WriteArgs));
async function failed(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}
async function observe(id: string, raw: string, model = "URX44", target: object = {}) {
  const transport = new FakeTransport().script("getNumeric", read(raw));
  // A read is exactly one GET: any further request shows as `calls` and fails an exact comparison.
  return readAny(new OperationContext(transport, model), id, target).then(
    (reading) =>
      transport.calls.length === 1
        ? { value: reading.value, address: transport.calls[0]?.address }
        : { value: reading.value, address: transport.calls[0]?.address, calls: transport.calls.length },
    (error: unknown) => ({ code: operationFailureOf(error)?.code, calls: transport.calls.length }),
  );
}

describe("scene references (F14-R)", () => {
  it("map all 67 references for both fields on every model, and nothing else", async () => {
    const references: [string, string][] = [
      ["32768", "initial"],
      ...Array.from({ length: 63 }, (_, i): [string, string] => [`${i}`, `user-${i + 1}`]),
      ["32769", "preset-1"],
      ["32770", "preset-2"],
      ["32771", "preset-3"],
    ];
    for (const [id, paramId] of [
      ["scene.current", 781],
      ["scene.cursor", 863],
    ] as const) {
      for (const model of ["URX22", "URX44", "URX44V"]) {
        for (const [raw, value] of references) {
          expect(await observe(id, raw, model), `${id} ${model} ${raw}`).toEqual({ value, address: { paramId, x: "0", y: "0" } });
        }
      }
      for (const raw of ["63", "32767", "32772", "-1", "101"]) {
        expect(await observe(id, raw), `${id} ${raw}`).toEqual({ code: "invalid_response", calls: 1 });
      }
      expect((await failed(writeAny(new OperationContext(new FakeTransport(), "URX44"), id, {}, "user-1")))?.code).toBe("unsupported_operation");
    }
  });
});

describe("recorder (F16-R)", () => {
  it("read state, card presence and track count strictly on URX44/V only", async () => {
    const states = ["stopped", "playing", "playback-paused", "recording", "record-standby", "recording-paused"];
    for (const [raw, value] of states.entries()) {
      expect(await observe("recorder.state", `${raw}`)).toEqual({ value, address: { paramId: 836, x: "0", y: "0" } });
    }
    expect(await observe("recorder.card-present", "1", "URX44V")).toEqual({ value: true, address: { paramId: 837, x: "0", y: "0" } });
    for (const [raw, value] of [
      ["1", 2],
      ["8", 16],
      ["4", 8],
    ] as const) {
      expect(await observe("recorder.track-count", raw)).toEqual({ value, address: { paramId: 839, x: "0", y: "0" } });
    }
    for (const [id, raw] of [
      ["recorder.state", "6"],
      ["recorder.card-present", "2"],
      ["recorder.track-count", "0"],
      ["recorder.track-count", "9"],
    ] as const) {
      expect(await observe(id, raw), `${id} ${raw}`).toEqual({ code: "invalid_response", calls: 1 });
    }
    for (const id of ["recorder.state", "recorder.card-present", "recorder.track-count"]) {
      expect(await observe(id, "0", "URX22"), id).toEqual({ code: "unsupported_operation", calls: 0 });
      expect((await failed(writeAny(new OperationContext(new FakeTransport(), "URX44"), id, {}, 1)))?.code).toBe("unsupported_operation");
    }
  });

  it("read every track's source lane and write the 19 writable ones once at (736, 0, N − 1)", async () => {
    for (let track = 1; track <= 16; track += 1) {
      expect(await observe("recorder.source", "289", "URX44", { track })).toEqual({ value: "mix-1-right", address: { paramId: 736, x: "0", y: `${track - 1}` } });
    }
    expect(await observe("recorder.source", "336", "URX44", { track: 1 })).toEqual({ value: "monitor-1-left", address: { paramId: 736, x: "0", y: "0" } });
    expect(await observe("recorder.source", `${258 + 0x80000000}`, "URX44", { track: 1 })).toEqual({ value: "stream-left", address: { paramId: 736, x: "0", y: "0" } });
    const writable = [
      ["none", "4294967295"],
      ["channel-1", "0"],
      ["channel-4", "3"],
      ["channel-5-left", "4"],
      ["channel-5-right", "5"],
      ["channel-11-right", "11"],
      ["stereo-left", "256"],
      ["mix-2-right", "291"],
    ] as const;
    for (const [token, raw] of writable) {
      const transport = new FakeTransport().script("setNumeric", accepted);
      await writeAny(new OperationContext(transport, "URX44V"), "recorder.source", { track: 9 }, token);
      expect(transport.calls.map(({ address, value }) => ({ address, value })), token).toEqual([{ address: { paramId: 736, x: "0", y: "8" }, value: raw }]);
    }
    const plan = (value: unknown, target: object = { track: 1 }, model = "URX44") => previewSetting(model, ...(["recorder.source", target, value] as unknown as WriteArgs));
    for (const [value, code] of [
      ["stream-left", "unsupported_operation"],
      ["monitor-2-right", "unsupported_operation"],
      ["channel-6", "invalid_input"],
      ["stereo", "invalid_input"],
    ] as const) {
      expect(() => plan(value), value).toThrow(new RegExp(code));
    }
    for (const target of [{ track: 0 }, { track: 17 }, { track: 1.5 }, { track: "1-2" }, { track: 1, side: "left" }, {}]) {
      expect(() => plan("none", target), JSON.stringify(target)).toThrow(/invalid_input/);
    }
    expect(() => plan("none", { track: 1 }, "URX22")).toThrow(/unsupported_operation/);
    for (const raw of ["12", "340", "-1"]) {
      expect(await observe("recorder.source", raw, "URX44", { track: 1 }), raw).toEqual({ code: "invalid_response", calls: 1 });
    }
  });
});

describe("scene and recorder reads expose no write path", () => {
  it("have no plan, write, validation or dry run in the public handler table", () => {
    for (const id of ["scene.current", "scene.cursor", "recorder.state", "recorder.card-present", "recorder.track-count"] as const) {
      const handler = settingHandlers[id] as unknown as Record<string, unknown>;
      expect(["plan", "write", "validate", "dryRun"].filter((key) => key in handler), id).toEqual([]);
      expect(typeof handler["read"], id).toBe("function");
    }
  });
});

describe("recorder sources on every track (F16-R)", () => {
  const WRITABLE: [string, string][] = [
    ["none", "4294967295"],
    ["channel-1", "0"],
    ["channel-2", "1"],
    ["channel-3", "2"],
    ["channel-4", "3"],
    ...[5, 7, 9, 11].flatMap((n, i): [string, string][] => [
      [`channel-${n}-left`, `${4 + 2 * i}`],
      [`channel-${n}-right`, `${5 + 2 * i}`],
    ]),
    ["stereo-left", "256"],
    ["stereo-right", "257"],
    ["mix-1-left", "288"],
    ["mix-1-right", "289"],
    ["mix-2-left", "290"],
    ["mix-2-right", "291"],
  ];
  const READ_ONLY = ["monitor-1-left", "monitor-1-right", "monitor-2-left", "monitor-2-right", "stream-left", "stream-right"];

  it("read every lane, plain or tagged, at every track on both models with one GET", async () => {
    const READ_ONLY_RAW: [string, string][] = [
      ["monitor-1-left", "336"],
      ["monitor-1-right", "337"],
      ["monitor-2-left", "338"],
      ["monitor-2-right", "339"],
      ["stream-left", "258"],
      ["stream-right", "259"],
    ];
    const lanes = [...WRITABLE, ...READ_ONLY_RAW];
    expect(lanes.length).toBe(25);
    for (const model of ["URX44", "URX44V"] as const) {
      for (let track = 1; track <= 16; track += 1) {
        const at = { paramId: 736, x: "0", y: `${track - 1}` };
        for (const [token, raw] of lanes) {
          const raws = token === "none" ? [raw] : [raw, `${BigInt(raw) + 0x80000000n}`];
          for (const each of raws) {
            expect(await observe("recorder.source", each, model, { track }), `${model} ${track} ${token} ${each}`).toEqual({ value: token, address: at });
          }
        }
        expect(await observe("recorder.source", "340", model, { track }), `${model} ${track}`).toEqual({ code: "invalid_response", calls: 1 });
      }
    }
    // Every scene and recorder read with an invalid answer is one request, reported as invalid.
    for (const [id, raw] of [
      ["scene.current", "64"],
      ["scene.cursor", "32772"],
      ["recorder.state", "6"],
      ["recorder.card-present", "2"],
      ["recorder.track-count", "9"],
    ] as const) {
      for (const model of id.startsWith("scene") ? (["URX22", "URX44", "URX44V"] as const) : (["URX44", "URX44V"] as const)) {
        expect(await observe(id, raw, model), `${model} ${id}`).toEqual({ code: "invalid_response", calls: 1 });
      }
    }
  });

  it("write each of the 19 writable lanes once at the named track, on both models", async () => {
    expect(WRITABLE.length).toBe(19);
    for (const model of ["URX44", "URX44V"] as const) {
      for (let track = 1; track <= 16; track += 1) {
        for (const [token, raw] of WRITABLE) {
          const transport = new FakeTransport().script("setNumeric", accepted);
          const result = await writeAny(new OperationContext(transport, model), "recorder.source", { track }, token);
          const label = `${model} ${track} ${token}`;
          expect(result.planned, label).toBe(token);
          expect(transport.calls.map(({ method, address, value }) => [method, address, value]), label).toEqual([
            ["setNumeric", { paramId: 736, x: "0", y: `${track - 1}` }, raw],
          ]);
        }
      }
    }
  });

  it("refuse the read-only lanes on every track before any request, and report a failed write once", async () => {
    for (const model of ["URX44", "URX44V"] as const) {
      for (let track = 1; track <= 16; track += 1) {
        for (const token of READ_ONLY) {
          const label = `${model} ${track} ${token}`;
          const args = ["recorder.source", { track }, token] as unknown as WriteArgs;
          expect(() => previewSetting(model, ...args), label).toThrow(/unsupported_operation/);
          const none = new FakeTransport();
          expect((await failed(writeSetting(new OperationContext(none, model), ...args)))?.code, label).toBe("unsupported_operation");
          expect(none.calls, label).toEqual([]);
        }
      }
      // A rejection or a timeout is the operation's result: one request, no resend.
      for (const [record, code] of [
        [{ kind: "failure", failure: { kind: "cause", code: "device_rejected", phase: "response" }, evidence: { state: "rejected", responseCode: "9" } }, "device_rejected"],
        [{ kind: "failure", failure: { kind: "cause", code: "response_timeout", phase: "response" }, evidence: { state: "unconfirmed" } }, "response_timeout"],
      ] as const) {
        for (const track of [1, 2, 15, 16]) {
          const transport = new FakeTransport().script("setNumeric", record, accepted);
          expect((await failed(writeAny(new OperationContext(transport, model), "recorder.source", { track }, "mix-1-left")))?.code, `${model} ${track}`).toBe(code);
          expect(transport.calls.length, `${model} ${track}`).toBe(1);
        }
      }
    }
  });
});
