import { settingHandlers } from "../src/operations/registry.js";
import { type SelectorRule } from "../src/catalog/rules.js";
import { describe, expect, it } from "vitest";
import { MONO_CHANNELS, STEREO_CHANNELS } from "../src/catalog/channels.js";
import { BASIC_RULES } from "../src/catalog/basic-rules.js";
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
import { SCENE_RECORDER_RULES } from "../src/catalog/scene-recorder.js";
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

const allRules: Record<string, SettingRule> = {
  ...BASIC_RULES,
  ...DYNAMICS_RULES, ...EQ_RULES, ...SSMCS_RULES, ...DUCKER_RULES, ...SEND_RULES, ...BUS_RULES, "channel.stereo-assign": CHANNEL_STEREO_ASSIGN_RULE, ...INSERT_FX_RULES, ...FX_RETURN_RULES, ...OUTPUT_EQ_RULES, ...OUTPUT_PEQ_RULES, ...STREAM_DELAY_RULES, ...OUTPUT_SOURCE_RULES, ...MONITOR_RULES, ...CUE_RULES, ...OSCILLATOR_RULES, ...DEVICE_RULES, ...KNOB_RULES, ...INTEGRATION_RULES, ...SCENE_RECORDER_RULES };

/** The channel and band rules; send and bus rules, addressed per route or bus, have their own tests. */
const addressed = ruled.flatMap(([id, rule]) =>
  (rule.target === "channel" && rule.value.kind !== "by-kind") || rule.target === "channel-band" ? [[id, rule] as const] : [],
);

/** Each (id, target, value rule) a rule defines: one per band for a band rule. */
const valueCases = addressed.flatMap(([id, rule]): [string, object, ValueRule][] => {
  if (rule.target === "channel") {
    // URX44 channel 1 is mono, channel 5 the first fixed stereo pair (per-kind values are excluded above).
    return rule.value.kind === "by-kind" ? [] : [[id, { channel: rule.address.mono === undefined ? 5 : 1 }, rule.value]];
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
  it("carry a rule on every definition, the object the operations are built from", () => {
    expect(ruled.length).toBe(Object.keys(settingDefinitions).length);
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
        case "switch": {
          // On is raw 1, or raw 0 for an inverted switch.
          const [on, off] = rule.on === "0" ? ["0", "1"] : ["1", "0"];
          expect([await wire(id, target, true), await wire(id, target, false)], id).toEqual([on, off]);
          expect([await observed(id, target, on), await observed(id, target, "2")], id).toEqual([{ value: true }, { code: "invalid_response" }]);
          break;
        }
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
          // The write range: the stops, or a wider `write` window whose ends round to the end stops.
          const writeMin = rule.write?.min ?? first;
          const writeMax = rule.write?.max ?? last;
          expect([plan(id, target, first), plan(id, target, last), plan(id, target, writeMin), plan(id, target, writeMax)], id).toEqual([
            first,
            last,
            first,
            last,
          ]);
          expect(() => plan(id, target, writeMin - 1 / rule.scale), id).toThrow();
          expect(() => plan(id, target, writeMax + 1 / rule.scale), id).toThrow();
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

describe("every read-only setting exposes no write path", () => {
  it("has no plan, write, validation or dry run where the setting has no write on any target", () => {
    for (const id of [
      "input.clip-safe-active",
      "channel.stereo-link",
      "device.console-lock",
      "knob.bank",
      "integration.active",
      "scene.current",
      "scene.cursor",
      "recorder.state",
      "recorder.card-present",
      "recorder.track-count",
    ]) {
      expect((settingDefinitions as Record<string, { writable: boolean }>)[id]?.writable, id).toBe(false);
      const handler = (settingHandlers as unknown as Record<string, Record<string, unknown>>)[id] ?? {};
      expect(["plan", "write", "validate", "dryRun"].filter((key) => key in handler), id).toEqual([]);
    }
  });

  it("sends nothing from a direct write where every target's write is unbound", async () => {
    for (const [id, target, value] of [
      ["send.pan", { source: "channel-1", destination: "mix-1" }, 0],
      ["bus.type", { bus: "mix-1" }, "fixed"],
      ["bus.eq.type", { bus: "stereo" }, "peq"],
      ["bus.eq.on", { bus: "mix-1" }, true],
    ] as const) {
      for (const model of ["URX22", "URX44", "URX44V"] as const) {
        const none = new FakeTransport();
        const handler = (settingHandlers as unknown as Record<string, { write: (c: OperationContext, t: unknown, v: unknown) => Promise<unknown> }>)[id];
        const code = await Promise.resolve()
          .then(() => handler?.write(new OperationContext(none, model), target, value))
          .then(
          () => "accepted",
          (error: unknown) => operationFailureOf(error)?.code,
        );
        expect(code, `${model} ${id}`).toBe("unsupported_operation");
        expect(none.calls, `${model} ${id}`).toEqual([]);
      }
    }
  });
});

describe("selector judgments from the published catalog match the operations", () => {
  /** A catalog reader's verdict: the model's choices plan, another known token is unsupported, anything else invalid. */
  const judge = (rule: SelectorRule, model: string, token: string) => {
    const choice = rule.choices.find((each) => each.token === token && (each.models === undefined || each.models.includes(model)));
    if (choice !== undefined) return `planned ${choice.raw}`;
    return rule.known.includes(token) ? "unsupported_operation" : "invalid_input";
  };
  const operation = (model: string, id: string, target: object, token: string) => {
    try {
      previewSetting(model, ...([id, target, token] as unknown as WriteArgs));
    } catch (error) {
      return operationFailureOf(error)?.code;
    }
    return "planned";
  };

  it("for the channel input source and Rec Point on every model and channel kind", () => {
    const source = settingDefinitions["channel.source"].rule.value as SelectorRule;
    const recPoint = settingDefinitions["channel.rec-point"].rule.value as { rules: { mono: SelectorRule; stereo: SelectorRule } };
    for (const model of ["URX22", "URX44", "URX44V"] as const) {
      const mono = MONO_CHANNELS[model][0] as number;
      const stereo = STEREO_CHANNELS[model][0] as number;
      for (const token of [...source.known, "usb-daw-13", "Input-1"]) {
        for (const target of [{ channel: mono }, { channel: stereo, side: "left" }, { channel: stereo, side: "right" }]) {
          const verdict = judge(source, model, token);
          expect(operation(model, "channel.source", target, token), `${model} ${JSON.stringify(target)} ${token}`).toBe(verdict.startsWith("planned") ? "planned" : verdict);
        }
      }
      for (const [kind, channel] of [["mono", mono], ["stereo", stereo]] as const) {
        const rule = recPoint.rules[kind];
        for (const token of [...recPoint.rules.mono.known, "pre-anything"]) {
          const verdict = judge(rule, model, token);
          expect(operation(model, "channel.rec-point", { channel }, token), `${model} ${kind} ${token}`).toBe(verdict.startsWith("planned") ? "planned" : verdict);
        }
      }
    }
    // A port another model takes is unsupported here, from the catalog alone.
    expect(judge(source, "URX44", "hdmi-left")).toBe("unsupported_operation");
    // A mono-only Rec Point stage is an invalid value for a fixed stereo channel, not a known one it lacks.
    const monoOnly = recPoint.rules.mono.known.filter((stage) => !recPoint.rules.stereo.known.includes(stage));
    expect(monoOnly.length).toBeGreaterThan(0);
    for (const stage of monoOnly) {
      expect(operation("URX44", "channel.rec-point", { channel: STEREO_CHANNELS.URX44[0] as number }, stage), stage).toBe("invalid_input");
    }
  });
});
