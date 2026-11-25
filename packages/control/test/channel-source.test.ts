import { describe, expect, it } from "vitest";
import { INPUT_PORTS } from "../src/catalog/ports.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { readSetting, writeSetting } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };

async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

describe("input-port selection (F03-I)", () => {
  it("has exactly the selected tokens and raw values", () => {
    expect(Object.keys(INPUT_PORTS)).toHaveLength(1 + 4 + 14 + 12);
    expect(INPUT_PORTS.none?.raw).toBe("4294967295");
    expect(INPUT_PORTS["input-3"]).toEqual({ raw: "2", models: ["URX44", "URX44V"] });
    expect(INPUT_PORTS["usb-main-a-right"]?.raw).toBe("513");
    expect(INPUT_PORTS["usb-daw-1"]?.raw).toBe("544");
    expect(INPUT_PORTS["usb-daw-12"]).toEqual({ raw: "555", models: ["URX44", "URX44V"] });
    expect(INPUT_PORTS["hdmi-left"]).toEqual({ raw: "624", models: ["URX44V"] });
    expect(INPUT_PORTS["sd-playback-right"]?.raw).toBe("609");
    for (const token of ["aux", "usb-daw-1-2", "all-input", "256"]) {
      expect(Object.hasOwn(INPUT_PORTS, token), token).toBe(false);
    }
  });

  it("writes the selected lane to the selected destination side once", async () => {
    const transport = new FakeTransport().script("setNumeric", accepted, accepted);
    const c = new OperationContext(transport, "URX44V");
    expect(await writeSetting(c, "channel.source", { channel: 5, side: "left" }, "usb-main-a-right")).toEqual({
      requested: "usb-main-a-right",
      planned: "usb-main-a-right",
      outcome: "accepted",
    });
    await writeSetting(c, "channel.source", { channel: 3 }, "none");
    expect(transport.calls.map((call) => [call.address, call.value])).toEqual([
      [{ paramId: 209, x: "0", y: "0" }, "513"],
      [{ paramId: 22, x: "0", y: "2" }, "4294967295"],
    ]);
  });

  it("refuses unknown and model-absent tokens, and side misuse, before traffic", async () => {
    const transport = new FakeTransport();
    const c = new OperationContext(transport, "URX22");
    for (const [target, value, code] of [
      [{ channel: 1 }, "aux", "invalid_input"],
      [{ channel: 1 }, "usb-daw-11", "unsupported_operation"],
      [{ channel: 1 }, "hdmi-left", "unsupported_operation"],
      [{ channel: 1 }, "input-3", "unsupported_operation"],
      [{ channel: 3 }, "aux-left", "invalid_input"],
      [{ channel: 1, side: "left" }, "aux-left", "invalid_input"],
    ] as const) {
      expect((await failureOf(writeSetting(c, "channel.source", target, value)))?.code, value).toBe(code);
    }
    expect(transport.calls).toEqual([]);
  });

  it("decodes the precise lane, and refuses a value without a mapping on the model", async () => {
    const transport = new FakeTransport().script("getNumeric", read("257"), read("555"), read("4294967295"), read("700"));
    const c = new OperationContext(transport, "URX22");
    expect((await readSetting(c, "channel.source", { channel: 9, side: "right" })).value).toBe("aux-right");
    expect((await failureOf(readSetting(c, "channel.source", { channel: 1 })))?.code).toBe("invalid_response");
    expect((await readSetting(c, "channel.source", { channel: 2 })).value).toBe("none");
    expect((await failureOf(readSetting(c, "channel.source", { channel: 1 })))?.code).toBe("invalid_response");
    expect(transport.calls[0]?.address).toEqual({ paramId: 210, x: "0", y: "3" });
  });
});
