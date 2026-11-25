import { describe, expect, it } from "vitest";
import { MONO_CHANNELS, STEREO_CHANNELS } from "../src/catalog/channels.js";
import { DYNAMICS_RULES } from "../src/catalog/dynamics.js";
import { EQ_RULES } from "../src/catalog/eq.js";
import type { SettingRule, ValueRule } from "../src/catalog/rules.js";
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

const allRules: Record<string, SettingRule> = { ...DYNAMICS_RULES, ...EQ_RULES };

/** Each (id, target, value rule) a rule defines: one per band for a band rule. */
const valueCases = ruled.flatMap(([id, rule]): [string, object, ValueRule][] => {
  if (rule.target === "channel") {
    return [[id, { channel: 1 }, rule.value]];
  }
  const value = rule.value;
  return rule.bands.flatMap((band): [string, object, ValueRule][] => {
    const each = value.kind === "by-band" ? value.rules[band] : value;
    return each === undefined ? [] : [[`${id} ${band}`, { channel: 1, band }, each]];
  });
});

const idOf = (label: string) => label.split(" ")[0] as string;

const plan = (label: string, target: object, value: unknown) =>
  previewSetting("URX44", ...([idOf(label), target, value] as unknown as WriteArgs)).planned;

async function wire(label: string, target: object, value: unknown): Promise<string | undefined> {
  const transport = new FakeTransport().script("setNumeric", accepted);
  await writeSetting(new OperationContext(transport, "URX44"), ...([idOf(label), target, value] as unknown as WriteArgs));
  return transport.calls[0]?.value;
}

async function observed(label: string, target: object, raw: string): Promise<unknown> {
  const transport = new FakeTransport().script("getNumeric", read(raw));
  const result = await readSetting(new OperationContext(transport, "URX44"), ...([idOf(label), target] as unknown as ReadArgs)).then(
    (reading) => ({ value: reading.value }),
    (error: unknown) => ({ code: operationFailureOf(error)?.code }),
  );
  return result;
}

describe("setting rules (K35 definition metadata)", () => {
  it("carry the rule objects the operations are built from", () => {
    expect(ruled.map(([id]) => id).sort()).toEqual(Object.keys(allRules).sort());
    for (const [id, rule] of ruled) {
      expect(rule, id).toBe(allRules[id]);
    }
  });

  it("predict each operation's addresses from the rule alone", async () => {
    for (const [id, rule] of ruled) {
      const bands = rule.target === "channel" ? [undefined] : rule.bands;
      for (const band of bands) {
        // A band rule's band without an address has no ID on any kind.
        const ids = rule.target === "channel" ? rule.address : (rule.address[band as string] ?? {});
        for (const model of models) {
          for (const [kind, channels] of [
            ["mono", MONO_CHANNELS[model]],
            ["stereo", STEREO_CHANNELS[model]],
          ] as const) {
            for (const [position, channel] of channels.entries()) {
              const paramId = ids[kind];
              const target = band === undefined ? { channel } : { channel, band };
              const transport = new FakeTransport().script("getNumeric", read("0"));
              const done = readSetting(new OperationContext(transport, model), ...([id, target] as unknown as ReadArgs)).then(
                () => undefined,
                (error: unknown) => operationFailureOf(error)?.code,
              );
              const label = `${id} ${band ?? ""} ${model} ${channel}`;
              if (paramId === undefined) {
                expect(await done, label).toBe("unsupported_operation");
                expect(transport.calls, label).toEqual([]);
              } else {
                await done;
                const y = kind === "mono" ? channel - 1 : position;
                expect(transport.calls[0]?.address, label).toEqual({ paramId, x: "0", y: `${y}` });
              }
            }
          }
        }
      }
    }
  });

  it("predict each operation's write domain, wire values and read domain from the rule alone", async () => {
    for (const [id, target, rule] of valueCases) {
      switch (rule.kind) {
        case "switch":
          expect([await wire(id, target, true), await wire(id, target, false)], id).toEqual(["1", "0"]);
          expect([await observed(id, target, "1"), await observed(id, target, "2")], id).toEqual([{ value: true }, { code: "invalid_response" }]);
          break;
        case "choice":
          for (const [index, choice] of rule.choices.entries()) {
            expect(await wire(id, target, choice), `${id} ${choice}`).toBe(`${index}`);
            expect(await observed(id, target, `${index}`), `${id} ${choice}`).toEqual({ value: choice });
          }
          expect(() => plan(id, target, "other"), id).toThrow();
          expect(await observed(id, target, `${rule.choices.length}`), id).toEqual({ code: "invalid_response" });
          break;
        case "grid": {
          const step = 1 / rule.scale;
          expect([plan(id, target, rule.min), plan(id, target, rule.max), plan(id, target, rule.min + step / 2)], id).toEqual([rule.min, rule.max, rule.min]);
          expect(() => plan(id, target, rule.min - step), id).toThrow();
          expect(() => plan(id, target, rule.max + step), id).toThrow();
          expect(await wire(id, target, rule.max), id).toBe(`${Math.round(rule.max * rule.scale)}`);
          expect(await observed(id, target, `${Math.round(rule.min * rule.scale)}`), id).toEqual({ value: rule.min });
          expect(await observed(id, target, `${Math.round(rule.max * rule.scale) + 1}`), id).toEqual({ code: "invalid_response" });
          break;
        }
        case "stops": {
          const first = (rule.stops[0] as number) / rule.scale;
          const last = (rule.stops[rule.stops.length - 1] as number) / rule.scale;
          expect([plan(id, target, first), plan(id, target, last)], id).toEqual([first, last]);
          expect(() => plan(id, target, first - 1 / rule.scale), id).toThrow();
          expect(() => plan(id, target, last + 1 / rule.scale), id).toThrow();
          expect(await wire(id, target, last), id).toBe(`${rule.stops[rule.stops.length - 1]}`);
          const readMax = rule.read?.max ?? (rule.stops[rule.stops.length - 1] as number);
          expect(await observed(id, target, `${readMax}`), id).toEqual({ value: readMax / rule.scale });
          expect(await observed(id, target, `${readMax + (rule.sentinel?.raw === `${readMax + 1}` ? 2 : 1)}`), id).toEqual({
            code: "invalid_response",
          });
          break;
        }
      }
      if ((rule.kind === "grid" || rule.kind === "stops") && rule.sentinel !== undefined) {
        expect(plan(id, target, rule.sentinel.value), id).toBe(rule.sentinel.value);
        expect(await wire(id, target, rule.sentinel.value), id).toBe(rule.sentinel.raw);
        expect(await observed(id, target, rule.sentinel.raw), id).toEqual({ value: rule.sentinel.value });
      }
    }
  });
});
