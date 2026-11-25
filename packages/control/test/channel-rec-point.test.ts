import { describe, expect, it } from "vitest";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };

async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

describe("Rec Point (F03-R)", () => {
  it("writes each mono stage as its raw value once, pre-eq included", async () => {
    const stages = ["pre-gate", "pre-comp", "pre-eq", "pre-insert-fx", "pre-fader"] as const;
    const transport = new FakeTransport().script("setNumeric", ...stages.map(() => accepted));
    const c = new OperationContext(transport, "URX44");
    for (const stage of stages) {
      expect((await writeSetting(c, "channel.rec-point", { channel: 2 }, stage)).planned).toBe(stage);
    }
    expect(transport.calls.map((call) => [call.address, call.value])).toEqual(
      stages.map((_, raw) => [{ paramId: 137, x: "0", y: "1" }, `${raw}`]),
    );
  });

  it("allows only pre-eq and pre-fader on fixed stereo", async () => {
    const transport = new FakeTransport().script("setNumeric", accepted, accepted);
    const c = new OperationContext(transport, "URX22");
    await writeSetting(c, "channel.rec-point", { channel: 9 }, "pre-eq");
    await writeSetting(c, "channel.rec-point", { channel: 3 }, "pre-fader");
    expect(transport.calls.map((call) => [call.address, call.value])).toEqual([
      [{ paramId: 264, x: "0", y: "3" }, "2"],
      [{ paramId: 264, x: "0", y: "0" }, "4"],
    ]);
    for (const stage of ["pre-gate", "pre-comp", "pre-insert-fx"] as const) {
      expect(() => previewSetting("URX22", "channel.rec-point", { channel: 3 }, stage), stage).toThrow();
    }
    for (const bad of ["PRE-EQ", "2", "pre_eq", "post-fader"]) {
      expect(() => previewSetting("URX22", "channel.rec-point", { channel: 1 }, bad as never), bad).toThrow();
    }
  });

  it("decodes only the target's stages", async () => {
    const transport = new FakeTransport().script("getNumeric", read("3"), read("4"), read("0"), read("5"));
    const c = new OperationContext(transport, "URX44V");
    expect((await readSetting(c, "channel.rec-point", { channel: 1 })).value).toBe("pre-insert-fx");
    expect((await readSetting(c, "channel.rec-point", { channel: 11 })).value).toBe("pre-fader");
    expect((await failureOf(readSetting(c, "channel.rec-point", { channel: 5 })))?.code).toBe("invalid_response");
    expect((await failureOf(readSetting(c, "channel.rec-point", { channel: 1 })))?.code).toBe("invalid_response");
    expect(transport.calls.map((call) => call.method)).toEqual(["getNumeric", "getNumeric", "getNumeric", "getNumeric"]);
  });
});

describe("target shapes", () => {
  it("refuse extra, inherited and array-borne selectors before traffic", async () => {
    const transport = new FakeTransport();
    const c = new OperationContext(transport, "URX44");
    const inherited = Object.create({ channel: 1 });
    const hidden = Object.defineProperty({ channel: 1 }, "track", { value: 1 });
    const symbol = { channel: 1, [Symbol("bus")]: 1 };
    const array = Object.assign([], { channel: 1 });
    for (const target of [{ channel: 1, track: 1 }, { channel: 1, bus: 1 }, { channel: 1, input: 1 }, inherited, array, hidden, symbol]) {
      for (const id of ["channel.rec-point", "channel.fader", "channel.on"] as const) {
        expect((await failureOf(readSetting(c, id, target)))?.code, `${id} ${JSON.stringify(target)}`).toBe("invalid_input");
      }
      expect(() => previewSetting("URX44", "channel.rec-point", target, "pre-eq")).toThrow();
    }
    for (const target of [{ input: 1, channel: 1 }, Object.create({ input: 1 })]) {
      expect((await failureOf(readSetting(c, "input.gain", target)))?.code).toBe("invalid_input");
    }
    expect((await failureOf(readSetting(c, "source.gain", { source: "aux", channel: 1 } as never)))?.code).toBe(
      "invalid_input",
    );
    expect(transport.calls).toEqual([]);
    const ok = new FakeTransport().script("getNumeric", read("2"));
    expect((await readSetting(new OperationContext(ok, "URX44"), "channel.rec-point", { channel: 1, side: undefined })).value).toBe(
      "pre-eq",
    );
  });
});
