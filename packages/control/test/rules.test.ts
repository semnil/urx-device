import { describe, expect, it } from "vitest";
import { MONO_CHANNELS, STEREO_CHANNELS } from "../src/catalog/channels.js";
import { DYNAMICS_RULES } from "../src/catalog/dynamics.js";
import type { SettingRule } from "../src/catalog/rules.js";
import { settingDefinitions, type SettingDefinitionBase } from "../src/catalog/settings.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting, type ReadArgs, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const models = ["URX22", "URX44", "URX44V"] as const;

const ruled = Object.entries(settingDefinitions as Record<string, SettingDefinitionBase>).flatMap(([id, definition]) =>
  definition.rule === undefined ? [] : [[id, definition.rule] as [string, SettingRule]],
);

const plan = (id: string, value: unknown) =>
  previewSetting("URX44", ...([id, { channel: 1 }, value] as unknown as WriteArgs)).planned;

async function wire(id: string, value: unknown): Promise<string | undefined> {
  const transport = new FakeTransport().script("setNumeric", accepted);
  await writeSetting(new OperationContext(transport, "URX44"), ...([id, { channel: 1 }, value] as unknown as WriteArgs));
  return transport.calls[0]?.value;
}

async function observed(id: string, raw: string): Promise<unknown> {
  const transport = new FakeTransport().script("getNumeric", read(raw));
  const result = await readSetting(new OperationContext(transport, "URX44"), ...([id, { channel: 1 }] as unknown as ReadArgs)).then(
    (reading) => ({ value: reading.value }),
    (error: unknown) => ({ code: operationFailureOf(error)?.code }),
  );
  return result;
}

describe("setting rules (K35 definition metadata)", () => {
  it("carry the F04-D rule objects the operations are built from", () => {
    expect(ruled.map(([id]) => id).sort()).toEqual(Object.keys(DYNAMICS_RULES).sort());
    for (const [id, rule] of ruled) {
      expect(rule, id).toBe(DYNAMICS_RULES[id as keyof typeof DYNAMICS_RULES]);
    }
  });

  it("predict each operation's addresses from the rule alone", async () => {
    for (const [id, rule] of ruled) {
      for (const model of models) {
        for (const [kind, channels] of [
          ["mono", MONO_CHANNELS[model]],
          ["stereo", STEREO_CHANNELS[model]],
        ] as const) {
          for (const [position, channel] of channels.entries()) {
            const paramId = rule.address[kind];
            const transport = new FakeTransport().script("getNumeric", read("0"));
            const done = readSetting(new OperationContext(transport, model), ...([id, { channel }] as unknown as ReadArgs)).then(
              () => undefined,
              (error: unknown) => operationFailureOf(error)?.code,
            );
            if (paramId === undefined) {
              expect(await done, `${id} ${model} ${channel}`).toBe("unsupported_operation");
              expect(transport.calls).toEqual([]);
            } else {
              await done;
              const y = kind === "mono" ? channel - 1 : position;
              expect(transport.calls[0]?.address, `${id} ${model} ${channel}`).toEqual({ paramId, x: "0", y: `${y}` });
            }
          }
        }
      }
    }
  });

  it("predict each operation's write domain, wire values and read domain from the rule alone", async () => {
    for (const [id, { value: rule }] of ruled) {
      switch (rule.kind) {
        case "switch":
          expect([await wire(id, true), await wire(id, false)], id).toEqual(["1", "0"]);
          expect([await observed(id, "1"), await observed(id, "2")], id).toEqual([{ value: true }, { code: "invalid_response" }]);
          break;
        case "choice":
          for (const [index, choice] of rule.choices.entries()) {
            expect(await wire(id, choice), `${id} ${choice}`).toBe(`${index}`);
            expect(await observed(id, `${index}`), `${id} ${choice}`).toEqual({ value: choice });
          }
          expect(() => plan(id, "other"), id).toThrow();
          expect(await observed(id, `${rule.choices.length}`), id).toEqual({ code: "invalid_response" });
          break;
        case "grid": {
          const step = 1 / rule.scale;
          expect([plan(id, rule.min), plan(id, rule.max), plan(id, rule.min + step / 2)], id).toEqual([rule.min, rule.max, rule.min]);
          expect(() => plan(id, rule.min - step), id).toThrow();
          expect(() => plan(id, rule.max + step), id).toThrow();
          expect(await wire(id, rule.max), id).toBe(`${Math.round(rule.max * rule.scale)}`);
          expect(await observed(id, `${Math.round(rule.min * rule.scale)}`), id).toEqual({ value: rule.min });
          expect(await observed(id, `${Math.round(rule.max * rule.scale) + 1}`), id).toEqual({ code: "invalid_response" });
          break;
        }
        case "stops": {
          const first = (rule.stops[0] as number) / rule.scale;
          const last = (rule.stops[rule.stops.length - 1] as number) / rule.scale;
          expect([plan(id, first), plan(id, last)], id).toEqual([first, last]);
          expect(() => plan(id, first - 1 / rule.scale), id).toThrow();
          expect(() => plan(id, last + 1 / rule.scale), id).toThrow();
          expect(await wire(id, last), id).toBe(`${rule.stops[rule.stops.length - 1]}`);
          const readMax = rule.read?.max ?? (rule.stops[rule.stops.length - 1] as number);
          expect(await observed(id, `${readMax}`), id).toEqual({ value: readMax / rule.scale });
          expect(await observed(id, `${readMax + (rule.sentinel?.raw === `${readMax + 1}` ? 2 : 1)}`), id).toEqual({
            code: "invalid_response",
          });
          break;
        }
      }
      if ((rule.kind === "grid" || rule.kind === "stops") && rule.sentinel !== undefined) {
        expect(plan(id, rule.sentinel.value), id).toBe(rule.sentinel.value);
        expect(await wire(id, rule.sentinel.value), id).toBe(rule.sentinel.raw);
        expect(await observed(id, rule.sentinel.raw), id).toEqual({ value: rule.sentinel.value });
      }
    }
  });
});
