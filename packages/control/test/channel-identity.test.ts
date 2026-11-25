import { describe, expect, it } from "vitest";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: unknown) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };

async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

describe("channel names (F03-K)", () => {
  it("write the exact text once with the text transport", async () => {
    const transport = new FakeTransport().script("setText", accepted, accepted);
    const c = new OperationContext(transport, "URX44V");
    expect(await writeSetting(c, "channel.name", { channel: 5 }, "Lead ")).toEqual({
      requested: "Lead ",
      planned: "Lead ",
      outcome: "accepted",
    });
    await writeSetting(c, "channel.name", { channel: 2 }, "");
    expect(transport.calls.map((call) => [call.method, call.address, call.value])).toEqual([
      ["setText", { paramId: 206, x: "0", y: "0" }, "Lead "],
      ["setText", { paramId: 18, x: "0", y: "1" }, ""],
    ]);
  });

  it("count Unicode scalar values and refuse controls without changing the text", () => {
    const plan = (value: string) => previewSetting("URX44", "channel.name", { channel: 1 }, value);
    for (const ok of ["12345678", "ボーカル主音声１２", "éééé", "𝄞𝄞𝄞𝄞𝄞𝄞𝄞𝄞", "        ", "Ab"].filter(
      (value) => Array.from(value).length <= 8,
    )) {
      expect(plan(ok).planned, ok).toBe(ok);
    }
    expect(plan("éééé").planned).toHaveLength(8);
    for (const bad of ["123456789", "a\u0000", "a\u001f", "a\u007f", "a\u009f", "a\ud800", "éééée"]) {
      expect(() => plan(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("read text and preset names as received, and refuse other values", async () => {
    const transport = new FakeTransport().script(
      "getName",
      read({ kind: "text", value: "a very long received name" }),
      read({ kind: "integer", value: "9223372036854775807" }),
      read({ kind: "text", value: "" }),
      read(12),
    );
    const c = new OperationContext(transport, "URX44");
    expect((await readSetting(c, "channel.name", { channel: 1 })).value).toEqual({
      kind: "text",
      text: "a very long received name",
    });
    expect((await readSetting(c, "channel.name", { channel: 1 })).value).toEqual({
      kind: "preset",
      presetIndex: "9223372036854775807",
    });
    expect((await readSetting(c, "channel.name", { channel: 1 })).value).toEqual({ kind: "text", text: "" });
    expect((await failureOf(readSetting(c, "channel.name", { channel: 1 })))?.code).toBe("internal_error");
    expect(transport.calls.every((call) => call.method === "getName")).toBe(true);
  });
});

describe("channel colors (F03-K)", () => {
  it("map every token to its palette index", async () => {
    const tokens = ["blue", "orange", "yellow", "purple", "cyan", "magenta", "red", "green", "light-green", "white", "off"] as const;
    const transport = new FakeTransport().script("setNumeric", ...tokens.map(() => accepted));
    const c = new OperationContext(transport, "URX22");
    for (const token of tokens) {
      await writeSetting(c, "channel.color", { channel: 9 }, token);
    }
    expect(transport.calls.map((call) => call.value)).toEqual(tokens.map((_, index) => `${index}`));
    expect(transport.calls[0]?.address).toEqual({ paramId: 208, x: "0", y: "3" });
  });

  it("refuse other spellings and decode only 0–10", async () => {
    const plan = (value: string) => previewSetting("URX44", "channel.color", { channel: 1 }, value as never);
    for (const bad of ["Blue", "light_green", "0", "#ff0000", "none"]) {
      expect(() => plan(bad), bad).toThrow();
    }
    const transport = new FakeTransport().script("getNumeric", read("10"), read("11"));
    const c = new OperationContext(transport, "URX44");
    expect((await readSetting(c, "channel.color", { channel: 3 })).value).toBe("off");
    expect((await failureOf(readSetting(c, "channel.color", { channel: 3 })))?.code).toBe("invalid_response");
    expect(transport.calls[0]?.address).toEqual({ paramId: 20, x: "0", y: "2" });
  });
});
