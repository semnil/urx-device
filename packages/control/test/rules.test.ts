import { describe, expect, it } from "vitest";
import { MONO_CHANNELS, STEREO_CHANNELS } from "../src/catalog/channels.js";
import { DUCKER_RULES } from "../src/catalog/ducker.js";
import { BUS_RULES, CHANNEL_STEREO_ASSIGN_RULE } from "../src/catalog/buses.js";
import { INSERT_FX_RULES } from "../src/catalog/insert-fx.js";
import { FX_RETURN_RULES } from "../src/catalog/fx-return.js";
import { OUTPUT_EQ_RULES } from "../src/catalog/output-eq.js";
import { OUTPUT_PEQ_RULES } from "../src/catalog/output-peq.js";
import { CUE_RULES, MONITOR_RULES, OUTPUT_SOURCE_RULES, STREAM_DELAY_RULES } from "../src/catalog/output-routing.js";
import { OSCILLATOR_RULES } from "../src/catalog/oscillator.js";
import { DEVICE_RULES } from "../src/catalog/device.js";
import { INTEGRATION_RULES, KNOB_RULES } from "../src/catalog/integration-panel.js";
import { SEND_RULES } from "../src/catalog/sends.js";
import { DYNAMICS_RULES } from "../src/catalog/dynamics.js";
import { EQ_RULES } from "../src/catalog/eq.js";
import { SSMCS_RULES } from "../src/catalog/ssmcs.js";
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

const allRules: Record<string, SettingRule> = { ...DYNAMICS_RULES, ...EQ_RULES, ...SSMCS_RULES, ...DUCKER_RULES, ...SEND_RULES, ...BUS_RULES, "channel.stereo-assign": CHANNEL_STEREO_ASSIGN_RULE, ...INSERT_FX_RULES, ...FX_RETURN_RULES, ...OUTPUT_EQ_RULES, ...OUTPUT_PEQ_RULES, ...STREAM_DELAY_RULES, ...OUTPUT_SOURCE_RULES, ...MONITOR_RULES, ...CUE_RULES, ...OSCILLATOR_RULES, ...DEVICE_RULES, ...KNOB_RULES, ...INTEGRATION_RULES };

/** The channel and band rules; send and bus rules, addressed per route or bus, have their own tests. */
const addressed = ruled.flatMap(([id, rule]) => (rule.target === "send" || rule.target === "bus" || rule.target === "fx-parameter" || rule.target === "bus-side" || rule.target === "bus-side-band" || rule.target === "bus-band" || rule.target === "output-side" || rule.target === "output" || rule.target === "device" || rule.target === "knob" ? [] : [[id, rule] as const]));

/** Each (id, target, value rule) a rule defines: one per band for a band rule. */
const valueCases = addressed.flatMap(([id, rule]): [string, object, ValueRule][] => {
  if (rule.target === "channel") {
    // URX44 channel 1 is mono, channel 5 the first fixed stereo pair.
    return [[id, { channel: rule.address.mono === undefined ? 5 : 1 }, rule.value]];
  }
  const value = rule.value;
  return rule.bands.flatMap((band): [string, object, ValueRule][] => {
    const each = value.kind === "by-band" ? value.rules[band] : value;
    // A band without an address lacks the setting (checked with the addresses).
    return each === undefined || rule.address[band] === undefined ? [] : [[`${id} ${band}`, { channel: 1, band }, each]];
  });
});

const idOf = (label: string) => label.split(" ")[0] as string;

const plan = (label: string, target: object, value: unknown) =>
  previewSetting("URX44", ...([idOf(label), target, value] as unknown as WriteArgs)).planned;

async function wire(label: string, target: object, value: unknown, text = false): Promise<string | undefined> {
  const transport = new FakeTransport().script(text ? "setText" : "setNumeric", accepted);
  await writeSetting(new OperationContext(transport, "URX44"), ...([idOf(label), target, value] as unknown as WriteArgs));
  return transport.calls[0]?.value;
}

async function observed(label: string, target: object, raw: string, text = false): Promise<unknown> {
  const transport = new FakeTransport().script(text ? "getText" : "getNumeric", read(raw));
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
    for (const [id, rule] of addressed) {
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
          const step = rule.step ?? 1 / rule.scale;
          const raw = (value: number) => `${Math.round(value * rule.scale) + (rule.offset ?? 0)}`;
          expect([plan(id, target, rule.min), plan(id, target, rule.max), plan(id, target, rule.min + step / 2)], id).toEqual([
            rule.min,
            rule.max,
            rule.min,
          ]);
          expect(() => plan(id, target, rule.min - step), id).toThrow();
          expect(() => plan(id, target, rule.max + step), id).toThrow();
          expect([await wire(id, target, rule.min), await wire(id, target, rule.max)], id).toEqual([raw(rule.min), raw(rule.max)]);
          expect(await observed(id, target, raw(rule.min)), id).toEqual({ value: rule.min });
          expect(await observed(id, target, raw(rule.max)), id).toEqual({ value: rule.max });
          expect(await observed(id, target, `${Number(raw(rule.min)) - 1}`), id).toEqual({ code: "invalid_response" });
          expect(await observed(id, target, `${Number(raw(rule.max)) + 1}`), id).toEqual({ code: "invalid_response" });
          // A read between write steps is kept, not snapped.
          expect(await observed(id, target, `${Number(raw(rule.min)) + 1}`), id).toEqual({
            value: rule.min + 1 / rule.scale,
          });
          break;
        }
        case "port-choice": {
          const choices = rule.byModel["URX44"] ?? [];
          for (const { token, id: port } of choices) {
            expect(await wire(id, target, token), `${id} ${token}`).toBe(`${port}`);
            expect(await observed(id, target, `${port}`), `${id} ${token}`).toEqual({ value: token });
            expect(await observed(id, target, `${port + 0x80000000}`), `${id} tagged ${token}`).toEqual({ value: token });
          }
          expect(await wire(id, target, rule.none.value), id).toBe(rule.none.raw);
          expect(await observed(id, target, rule.none.raw), id).toEqual({ value: rule.none.value });
          const absent = rule.known.filter((token) => !choices.some((choice) => choice.token === token));
          for (const token of absent) {
            expect(() => plan(id, target, token), `${id} ${token}`).toThrow(/unsupported_operation/);
          }
          expect(() => plan(id, target, "channel-0"), id).toThrow(/invalid_input/);
          const ids = new Set(choices.map((choice) => choice.id));
          const foreign = [...Array(300).keys()].find((n) => !ids.has(n)) as number;
          for (const raw of [`${foreign}`, "4294967296", "-1"]) {
            expect(await observed(id, target, raw), `${id} ${raw}`).toEqual({ code: "invalid_response" });
          }
          break;
        }
        case "stops": {
          const lastIndex = rule.stops.length - 1;
          const first = (rule.stops[0] as number) / rule.scale;
          const last = (rule.stops[lastIndex] as number) / rule.scale;
          expect([plan(id, target, first), plan(id, target, last)], id).toEqual([first, last]);
          expect(() => plan(id, target, first - 1 / rule.scale), id).toThrow();
          expect(() => plan(id, target, last + 1 / rule.scale), id).toThrow();
          // The raw read range: the indices with an ordinal, else the stop values or `read`.
          const low = rule.ordinal ?? rule.read?.min ?? (rule.stops[0] as number);
          const high = rule.ordinal === undefined ? (rule.read?.max ?? (rule.stops[lastIndex] as number)) : rule.ordinal + lastIndex;
          const valueOf = (raw: number) => (rule.ordinal === undefined ? raw / rule.scale : (rule.stops[raw - rule.ordinal] as number) / rule.scale);
          expect(await wire(id, target, last), id).toBe(`${rule.ordinal === undefined ? rule.stops[lastIndex] : high}`);
          expect([await observed(id, target, `${low}`), await observed(id, target, `${high}`)], id).toEqual([
            { value: valueOf(low) },
            { value: valueOf(high) },
          ]);
          const beyond = rule.sentinel?.raw === `${high + 1}` ? high + 2 : high + 1;
          expect(await observed(id, target, `${beyond}`), id).toEqual({ code: "invalid_response" });
          expect(await observed(id, target, `${low - 1}`), id).toEqual({ code: "invalid_response" });
          break;
        }
        case "text-index": {
          const text = (value: number) => `${value}`.padStart(rule.digits, "0");
          expect([plan(id, target, rule.min), plan(id, target, rule.max)], id).toEqual([rule.min, rule.max]);
          for (const bad of [rule.min - 1, rule.max + 1, rule.min + 0.5, text(rule.min)]) {
            expect(() => plan(id, target, bad), `${id} ${bad}`).toThrow();
          }
          expect(await wire(id, target, rule.max, true), id).toBe(text(rule.max));
          expect(await observed(id, target, text(rule.min), true), id).toEqual({ value: rule.min });
          for (const bad of [text(rule.max + 1), text(rule.min - 1), `${rule.min}`, ` ${text(rule.min)}`]) {
            expect(await observed(id, target, bad, true), `${id} ${JSON.stringify(bad)}`).toEqual({ code: "invalid_response" });
          }
          expect(rule.labels.length, id).toBe(rule.max - rule.min + 1);
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
