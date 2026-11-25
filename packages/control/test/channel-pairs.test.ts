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

describe("mono pairs (F03-J)", () => {
  it("read the link and mode at the primary only", async () => {
    for (const [model, primary] of [
      ["URX22", 1],
      ["URX44", 1],
      ["URX44", 3],
      ["URX44V", 3],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read("1"), read("0"));
      const c = new OperationContext(transport, model);
      expect((await readSetting(c, "channel.stereo-link", { channel: primary })).value).toBe(true);
      expect((await readSetting(c, "channel.pan-mode", { channel: primary })).value).toBe("pan");
      expect(transport.calls.map((call) => call.address)).toEqual([
        { paramId: 23, x: "0", y: `${primary - 1}` },
        { paramId: 891, x: "0", y: `${primary - 1}` },
      ]);
    }
  });

  it("write the mode once at the primary, with no link-state read", async () => {
    const transport = new FakeTransport().script("setNumeric", accepted);
    const c = new OperationContext(transport, "URX44");
    expect((await writeSetting(c, "channel.pan-mode", { channel: 3 }, "balance")).planned).toBe("balance");
    expect(transport.calls).toEqual([
      { method: "setNumeric", address: { paramId: 891, x: "0", y: "2" }, value: "1", ticket: "t0" },
    ]);
  });

  it("refuse secondaries, fixed stereo, sides and the unresolved link write before traffic", async () => {
    const transport = new FakeTransport();
    const c = new OperationContext(transport, "URX44");
    for (const [id, target, code] of [
      ["channel.pan-mode", { channel: 2 }, "invalid_input"],
      ["channel.pan-mode", { channel: 4 }, "invalid_input"],
      ["channel.pan-mode", { channel: 5 }, "unsupported_operation"],
      ["channel.stereo-link", { channel: 7 }, "unsupported_operation"],
      ["channel.stereo-link", { channel: 1, side: "left" }, "invalid_input"],
    ] as const) {
      expect((await failureOf(readSetting(c, id, target as never)))?.code, JSON.stringify(target)).toBe(code);
    }
    // Read-only until its write sequence is evidenced: not writable at the type level either.
    expect((await failureOf(writeSetting(c, "channel.stereo-link" as never, { channel: 1 } as never, true as never)))?.code).toBe(
      "invalid_input",
    );
    expect(() => previewSetting("URX44", "channel.stereo-link" as never, { channel: 1 } as never, true as never)).toThrow();
    // @ts-expect-error the link is not a writable setting
    void (() => writeSetting(c, "channel.stereo-link", { channel: 1 }, true));
    expect((await failureOf(writeSetting(c, "channel.pan-mode", { channel: 1 }, "bal" as never)))?.code).toBe(
      "invalid_input",
    );
    const urx22 = new OperationContext(transport, "URX22");
    expect((await failureOf(readSetting(urx22, "channel.pan-mode", { channel: 3 })))?.code).toBe(
      "unsupported_operation",
    );
    expect(transport.calls).toEqual([]);
  });

  it("decode only 0/1", async () => {
    const transport = new FakeTransport().script("getNumeric", read("2"), read("-1"));
    const c = new OperationContext(transport, "URX44");
    expect((await failureOf(readSetting(c, "channel.pan-mode", { channel: 1 })))?.code).toBe("invalid_response");
    expect((await failureOf(readSetting(c, "channel.stereo-link", { channel: 1 })))?.code).toBe("invalid_response");
  });
});
