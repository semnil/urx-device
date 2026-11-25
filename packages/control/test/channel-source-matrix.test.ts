// Every model × port × destination against the F03-I table, written out
// here independently of the catalog.
import { describe, expect, it } from "vitest";
import { INPUT_PORTS } from "../src/catalog/ports.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

type Model = "URX22" | "URX44" | "URX44V";
const ALL: Model[] = ["URX22", "URX44", "URX44V"];
const LARGER: Model[] = ["URX44", "URX44V"];

const expected: [string, string, Model[]][] = [["none", "4294967295", ALL]];
for (let jack = 1; jack <= 4; jack += 1) {
  expected.push([`input-${jack}`, `${jack - 1}`, jack <= 2 ? ALL : LARGER]);
}
for (const [name, left, right, models] of [
  ["aux", "256", "257", ALL],
  ["usb-main-a", "512", "513", ALL],
  ["usb-main-b", "514", "515", ALL],
  ["usb-main-c", "516", "517", ALL],
  ["usb-sub", "576", "577", ALL],
  ["sd-playback", "608", "609", LARGER],
  ["hdmi", "624", "625", ["URX44V"]],
] as const) {
  expected.push([`${name}-left`, left, [...models]], [`${name}-right`, right, [...models]]);
}
for (let lane = 1; lane <= 12; lane += 1) {
  expected.push([`usb-daw-${lane}`, `${543 + lane}`, lane <= 10 ? ALL : LARGER]);
}

const destinations: Record<Model, [{ channel: number; side?: "left" | "right" }, number, string][]> = {
  URX22: [
    [{ channel: 1 }, 22, "0"],
    [{ channel: 2 }, 22, "1"],
  ],
  URX44: [1, 2, 3, 4].map((channel) => [{ channel }, 22, `${channel - 1}`]),
  URX44V: [1, 2, 3, 4].map((channel) => [{ channel }, 22, `${channel - 1}`]),
};
for (const [model, stereo] of [
  ["URX22", [3, 5, 7, 9]],
  ["URX44", [5, 7, 9, 11]],
  ["URX44V", [5, 7, 9, 11]],
] as const) {
  stereo.forEach((channel, position) => {
    destinations[model].push([{ channel, side: "left" }, 209, `${position}`], [{ channel, side: "right" }, 210, `${position}`]);
  });
}

async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

describe("input-port selection matrix (F03-I)", () => {
  it("catalogs exactly the table's tokens, values and models", () => {
    expect(Object.fromEntries(Object.entries(INPUT_PORTS).map(([token, port]) => [token, [port.raw, port.models]]))).toEqual(
      Object.fromEntries(expected.map(([token, raw, models]) => [token, [raw, models]])),
    );
  });

  it("reads, previews and writes every available port at every destination", async () => {
    for (const model of ALL) {
      for (const [target, paramId, y] of destinations[model]) {
        for (const [token, raw, models] of expected) {
          const at = { paramId, x: "0", y };
          if (!models.includes(model)) {
            const transport = new FakeTransport().script("getNumeric", { kind: "success", value: raw, evidence: { state: "read" } });
            transport.timers = false;
            const c = new OperationContext(transport, model);
            expect(() => previewSetting(model, "channel.source", target, token)).toThrow();
            expect((await failureOf(writeSetting(c, "channel.source", target, token)))?.code).toBe("unsupported_operation");
            expect((await failureOf(readSetting(c, "channel.source", target)))?.code).toBe("invalid_response");
            expect(transport.calls.map((call) => call.method)).toEqual(["getNumeric"]);
            continue;
          }
          const transport = new FakeTransport()
            .script("getNumeric", { kind: "success", value: raw, evidence: { state: "read" } })
            .script("setNumeric", { kind: "success", value: null, evidence: { state: "accepted" } });
          transport.timers = false;
          const c = new OperationContext(transport, model);
          expect(previewSetting(model, "channel.source", target, token)).toEqual({ requested: token, planned: token });
          expect((await readSetting(c, "channel.source", target)).value).toBe(token);
          await writeSetting(c, "channel.source", target, token);
          expect(transport.calls.map((call) => [call.method, call.address, call.value])).toEqual([
            ["getNumeric", at, undefined],
            ["setNumeric", at, raw],
          ]);
        }
      }
    }
  });
});
