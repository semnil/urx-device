// F03-G writes evidenced on URX22 only: the representative instance's one
// write moves its partner natively there, so a write is one request at the
// representative. On URX44 and URX44V the same writes stay unbound. Writes
// with no evidence on any model stay unbound everywhere.

import { describe, expect, it } from "vitest";
import { PARTNER_FOLLOWS } from "../src/catalog/models.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { writeSetting, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const models = ["URX22", "URX44", "URX44V"] as const;
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as WriteArgs));
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

type Case = [id: string, target: object, value: unknown, paramId: number, y: number, raw: string, method?: "setText"];

const mixes = [
  ["mix-1", 0],
  ["mix-2", 2],
] as const;
const BANDS = [
  ["low", 596],
  ["low-mid", 601],
  ["high-mid", 606],
  ["high", 611],
] as const;

/** Every write bound on URX22 only, with the representative address and raw value it sends. */
const URX22_ONLY: Case[] = [
  ...mixes.flatMap(([bus, y]): Case[] => [
    ["bus.on", { bus }, false, 675, y, "0"],
    ["bus.fader", { bus }, -10, 674, y, "-1000"],
    ["bus.balance", { bus }, 10, 676, y, "10"],
    ["bus.insert-fx.on", { bus }, true, 670, y, "1"],
    ["bus.eq.on", { bus }, false, 591, y, "0"],
    ...BANDS.flatMap(([band, base]): Case[] => [
      ["bus.peq.band.on", { bus, band }, false, base, y, "0"],
      ["bus.peq.band.q", { bus, band }, 2, base + 2, y, "200"],
      ["bus.peq.band.frequency", { bus, band }, 500, base + 3, y, "5000"],
      ["bus.peq.band.gain", { bus, band }, -3, base + 4, y, "-300"],
    ]),
    ["bus.peq.band.type", { bus, band: "low" }, "peaking", 597, y, "0"],
    ["bus.peq.band.type", { bus, band: "high" }, "peaking", 612, y, "0"],
    ["bus.peq.one-knob.on", { bus }, true, 593, y, "1"],
    ["bus.peq.one-knob.type", { bus }, "vocal", 594, y, "1"],
    ["bus.peq.one-knob.level", { bus }, 20, 595, y, "20"],
    ["send.level", { source: "channel-1", destination: bus }, -10, 146 + 12 * (y / 2), 0, "-1000"],
    ["send.pan", { source: "channel-2", destination: bus }, -17, 147 + 12 * (y / 2), 1, "-17"],
    ["send.on", { source: "channel-1", destination: bus }, false, 148 + 12 * (y / 2), 0, "0"],
    ["send.level", { source: "channel-3", destination: bus }, -10, 273 + 12 * (y / 2), 0, "-1000"],
    ["send.on", { source: "channel-3", destination: bus }, false, 275 + 12 * (y / 2), 0, "0"],
    ["send.level", { source: "fx-2", destination: bus }, -10, 343 + 10 * (y / 2), 1, "-1000"],
    ["send.pan", { source: "fx-1", destination: bus }, -17, 344 + 10 * (y / 2), 0, "-17"],
    ["send.on", { source: "fx-1", destination: bus }, false, 345 + 10 * (y / 2), 0, "0"],
  ]),
  ["bus.name", { bus: "stream" }, "AB", 702, 0, "AB", "setText"],
  ["bus.color", { bus: "stream" }, "red", 704, 0, "6"],
  ...(
    [
      ["aux", 9],
      ["usb-main-a", 13],
      ["usb-main-b", 14],
      ["usb-main-c", 15],
      ["usb-sub", 16],
    ] as const
  ).map(([source, paramId]): Case => ["source.gain", { source }, -3, paramId, 0, "-300"]),
];

/** Writes with no evidence on any model: refused everywhere before any request. */
const UNBOUND: [string, object, unknown][] = [
  ...mixes.flatMap(([bus]): [string, object, unknown][] => [
    ["bus.type", { bus }, "fixed"],
    ["bus.name", { bus }, "AB"],
    ["bus.color", { bus }, "red"],
    ["bus.insert-fx.type", { bus }, "none"],
    ["bus.eq.type", { bus }, "peq"],
    ["send.pan", { source: "channel-3", destination: bus }, -17],
  ]),
];

describe("F03-G writes evidenced on URX22 (partner follows natively)", () => {
  it("send one request at the representative on URX22 and refuse it with no request elsewhere", async () => {
    expect([...PARTNER_FOLLOWS]).toEqual(["URX22"]);
    for (const model of models) {
      for (const [id, target, value, paramId, y, raw, method] of URX22_ONLY) {
        const label = `${model} ${id} ${JSON.stringify(target)}`;
        const transport = new FakeTransport().script("setNumeric", accepted).script("setText", accepted);
        const result = writeAny(new OperationContext(transport, model), id, target, value);
        if (model === "URX22") {
          await result;
          expect(transport.calls.length, label).toBe(1);
          const [call] = transport.calls;
          expect(call?.address, label).toEqual({ paramId, x: "0", y: `${y}` });
          expect([call?.method, call?.value], label).toEqual([method ?? "setNumeric", raw]);
        } else {
          expect((await failureOf(result))?.code, label).toBe("unsupported_operation");
          expect(transport.calls, label).toEqual([]);
        }
      }
    }
  });

  it("keep the writes without evidence unbound on every model", async () => {
    for (const model of models) {
      for (const [id, target, value] of UNBOUND) {
        const transport = new FakeTransport();
        const label = `${model} ${id} ${JSON.stringify(target)}`;
        expect((await failureOf(writeAny(new OperationContext(transport, model), id, target, value)))?.code, label).toBe(
          "unsupported_operation",
        );
        expect(transport.calls, label).toEqual([]);
      }
    }
  });
});
