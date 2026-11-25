// Every model × channel × processing setting against the F04-S table,
// written out here: the exact read request, or a refusal without traffic.
import { describe, expect, it } from "vitest";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { readSetting } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const table: [string, number | undefined, number | undefined, string][] = [
  ["channel.processing-mode", 21, undefined, "0"],
  ["channel.hpf.on", 25, undefined, "1"],
  ["channel.hpf.frequency", 26, undefined, "800"],
  ["channel.gate.on", 28, undefined, "1"],
  ["channel.comp.on", 34, undefined, "1"],
  ["channel.eq.on", 44, 213, "1"],
  ["channel.ssmcs.on", 89, undefined, "1"],
  ["channel.ssmcs.comp.on", 94, undefined, "0"],
  ["channel.ssmcs.eq.on", 106, undefined, "0"],
];
const channels = {
  URX22: { mono: [1, 2], stereo: [3, 5, 7, 9] },
  URX44: { mono: [1, 2, 3, 4], stereo: [5, 7, 9, 11] },
  URX44V: { mono: [1, 2, 3, 4], stereo: [5, 7, 9, 11] },
};

describe("processing read routing (F04-S)", () => {
  it("reads each setting once at its own address, or refuses without traffic", async () => {
    for (const [model, { mono, stereo }] of Object.entries(channels)) {
      for (const [id, monoId, stereoId, raw] of table) {
        for (const [kind, list, paramId] of [
          ["mono", mono, monoId],
          ["stereo", stereo, stereoId],
        ] as const) {
          for (const [position, channel] of list.entries()) {
            const transport = new FakeTransport().script("getNumeric", { kind: "success", value: raw, evidence: { state: "read" } });
            transport.timers = false;
            const c = new OperationContext(transport, model);
            const read = readSetting(c, id as never, { channel } as never);
            if (paramId === undefined) {
              const failure = operationFailureOf(await read.then(() => undefined, (error: unknown) => error));
              expect(failure?.code, `${model} ${id} ${channel}`).toBe("unsupported_operation");
              expect(transport.calls).toEqual([]);
              continue;
            }
            await read;
            const y = kind === "mono" ? channel - 1 : position;
            expect(
              transport.calls.map((call) => [call.method, call.address]),
              `${model} ${id} ${channel}`,
            ).toEqual([["getNumeric", { paramId, x: "0", y: `${y}` }]]);
          }
        }
      }
    }
  });
});
