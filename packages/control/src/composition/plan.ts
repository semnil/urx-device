// The CURRENT application plan (K36, F18): from one parsed file and the
// connected model, the ordered write steps and the omission records, built
// before any setting write. Values are decoded strictly from the CURRENT chunk
// and planned with each setting's own validation and rounding (F18-V); a
// missing or invalid included value refuses the whole plan.

import { settingDefinitions, type SettingDefinitionBase, type SettingId } from "../catalog/settings.js";
import type { Model } from "../catalog/models.js";
import { urxfValue, type UrxfChunk, type UrxfFile } from "../catalog/urxf.js";
import { FX_RETURN_RULES } from "../catalog/fx-return.js";
import type { FxParameterRule } from "../catalog/rules.js";
import { OperationFailureError, operationFailureOf } from "../operations/failure.js";
import { decodeFileSetting, previewSetting, validateSetting, type ReadArgs, type WriteArgs } from "../operations/registry.js";
import { codecOf } from "../operations/rules.js";
import { EXCLUDED, PHASES, type OmissionReason } from "./coverage.js";
import { targetsOf } from "./targets.js";

/** The combined bound on steps and omissions of one apply (F18-Q). */
export const PLAN_ITEM_LIMIT = 16_384;

export interface PlannedStep {
  readonly phase: number;
  readonly setting: SettingId;
  readonly target: object;
  readonly component: string | null;
  readonly requested: unknown;
  /** The planned value, or null when it depends on a live prerequisite read (O13). */
  readonly planned: unknown;
}

export interface Omission {
  readonly setting: SettingId;
  readonly target: object;
  readonly component: string | null;
  readonly reason: OmissionReason;
}

export interface CurrentPlan {
  readonly steps: readonly PlannedStep[];
  readonly omissions: readonly Omission[];
}

/**
 * The write value a decoded file value stands for: a name's text; a numeric
 * preset name is not converted into a label (K36) and refuses the file.
 */
function writeValueOf(decoded: unknown): unknown {
  if (typeof decoded === "object" && decoded !== null && "kind" in decoded) {
    const name = decoded as { kind: string; text?: string };
    return name.kind === "text" ? name.text : invalid();
  }
  return decoded;
}

/** The Flex12GEQ bank settings, applied only where the file's EQ Type is Flex12GEQ (F18-G-A). */
const GEQ_BANK: ReadonlySet<SettingId> = new Set<SettingId>(["bus.geq.on", "bus.geq.link", "bus.geq.limit", "bus.geq.gain"]);

/** Settings whose plan needs a live prerequisite read (F07-G, F06-F): planned at execution, checked statically here. */
const LIVE: ReadonlySet<SettingId> = new Set<SettingId>(["bus.geq.on", "bus.geq.link", "bus.geq.limit", "bus.geq.gain", "bus.fx.parameter"]);

function invalid(): never {
  throw new OperationFailureError({ code: "invalid_input", phase: "preparation", progress: null });
}

/** Builds the plan, refusing the whole file before any write on a missing or invalid value or an over-limit plan. */
export function planCurrent(file: UrxfFile, model: Model, limit: number = PLAN_ITEM_LIMIT): CurrentPlan {
  const chunk = file.current;
  const steps: PlannedStep[] = [];
  const omissions: Omission[] = [];
  const room = () => {
    if (steps.length + omissions.length >= limit) {
      invalid();
    }
  };
  const omit = (setting: SettingId, target: object, reason: OmissionReason, component: string | null = null) => {
    room();
    omissions.push({ setting, target, component, reason });
  };
  const value = (setting: SettingId, target: object) => writeValueOf(decodeFileSetting(chunk, model, ...([setting, target] as unknown as ReadArgs)));
  const control = deviceControlled(chunk, model);

  for (const { phase, settings } of PHASES) {
    for (const setting of settings) {
      if (setting === "bus.fx.parameter") {
        planFxParameters(chunk, model, phase, steps, omit, room);
        continue;
      }
      const rule = (settingDefinitions as Record<string, SettingDefinitionBase>)[setting]?.rule;
      if (rule === undefined) {
        continue;
      }
      for (const target of targetsOf(rule, model)) {
        const requested = value(setting, target);
        const args = [setting, target, requested] as unknown as WriteArgs;
        let planned: unknown = null;
        try {
          if (LIVE.has(setting)) {
            // The static checks now; the plan itself needs the live prerequisite reads at execution.
            validateSetting(model, ...args);
          } else {
            planned = previewSetting(model, ...args).planned;
          }
        } catch (error) {
          // A known write this target lacks (an unbound or read-only one) is an omission; a refused value refuses the file.
          if (operationFailureOf(error)?.code === "unsupported_operation") {
            omit(setting, target, "not_writable");
            continue;
          }
          throw error;
        }
        // One reason per omission, in F18-R-A's precedence: not writable, then the bank rule, then device control.
        // F18-G-A: with the file's EQ Type PEQ, the bus's GEQ bank is not applied.
        if (GEQ_BANK.has(setting) && value("bus.eq.type", { bus: (target as { bus: string }).bus }) === "peq") {
          omit(setting, target, "inactive_bank");
          continue;
        }
        const native = control(setting, target);
        if (native !== undefined) {
          omit(setting, target, native);
          continue;
        }
        room();
        steps.push({ phase, setting, target, component: null, requested, planned });
      }
    }
  }
  orderInputSwitches(steps);
  // Scope exclusions present in the catalog for this model, in catalog order.
  for (const [setting, reason] of Object.entries(EXCLUDED) as [SettingId, OmissionReason][]) {
    const rule = (settingDefinitions as Record<string, SettingDefinitionBase>)[setting]?.rule;
    for (const target of rule === undefined ? [] : targetsOf(rule, model)) {
      omit(setting, target, reason);
    }
  }
  return { steps, omissions };
}

/**
 * The F18-C automatic-control omissions, decided from the strictly decoded
 * file values only: COMP 1-knob On omits the manual dynamics; 1-knob Off with
 * Auto Makeup On omits Gain; a PEQ 1-knob On omits its four bands.
 */
function deviceControlled(chunk: UrxfChunk, model: Model) {
  const read = (setting: SettingId, target: object) => decodeFileSetting(chunk, model, ...([setting, target] as unknown as ReadArgs));
  const COMP_MANUAL = new Set(["channel.comp.threshold", "channel.comp.ratio", "channel.comp.gain", "channel.comp.knee", "channel.comp.attack", "channel.comp.release"]);
  const PEQ_BANDS = new Set(["channel.eq.band.on", "channel.eq.band.type", "channel.eq.band.q", "channel.eq.band.frequency", "channel.eq.band.gain"]);
  const BUS_PEQ_BANDS = new Set(["bus.peq.band.on", "bus.peq.band.type", "bus.peq.band.q", "bus.peq.band.frequency", "bus.peq.band.gain"]);
  return (setting: SettingId, target: object): OmissionReason | undefined => {
    const own = target as { channel?: number; bus?: string };
    if (COMP_MANUAL.has(setting)) {
      const channel = { channel: own.channel };
      if (read("channel.comp.one-knob.on", channel) === true) {
        return "device_controlled";
      }
      if (setting === "channel.comp.gain" && read("channel.comp.auto-makeup", channel) === true) {
        return "device_controlled";
      }
    }
    if (PEQ_BANDS.has(setting) && read("channel.eq.one-knob.on", { channel: own.channel }) === true) {
      return "device_controlled";
    }
    if (BUS_PEQ_BANDS.has(setting) && read("bus.peq.one-knob.on", { bus: own.bus }) === true) {
      return "device_controlled";
    }
    return undefined;
  };
}

/**
 * FX-return parameters (K36 phase 7, F18-R): each FX bus's parameters of its
 * file-selected type, REV-X Room Size before Reverb Time, the time decoded
 * with the file's type and Room Size. No rows for the types not selected.
 */
function planFxParameters(
  chunk: UrxfChunk,
  model: Model,
  phase: number,
  steps: PlannedStep[],
  omit: (setting: SettingId, target: object, reason: OmissionReason) => void,
  room: () => void,
): void {
  const rule: FxParameterRule = FX_RETURN_RULES["bus.fx.parameter"];
  for (const bus of ["fx-1", "fx-2"] as const) {
    const effect = decodeFileSetting(chunk, model, ...(["bus.fx.type", { bus }] as unknown as ReadArgs)) as string;
    const at = rule.buses[bus];
    const effectRule = rule.effects[effect];
    if (at === undefined || effectRule === undefined) {
      return invalid();
    }
    const raw = (slot: number) => {
      const stored = urxfValue(chunk, at.array, 0, slot);
      return typeof stored === "number" ? `${stored}` : invalid();
    };
    const names = Object.keys(effectRule.parameters);
    // REV-X: Room Size before Reverb Time. Delay (F18-D-A): Sync, BPM, Note, the rest, then Delay Time.
    const ordered = names.includes("room-size")
      ? ["room-size", ...names.filter((name) => name !== "room-size")]
      : names.includes("sync")
        ? [...DELAY_FIRST, ...names.filter((name) => !DELAY_FIRST.includes(name) && name !== "delay-time"), "delay-time"]
        : names;
    for (const parameter of ordered) {
      const field = effectRule.parameters[parameter];
      if (field === undefined) {
        continue;
      }
      let requested: unknown;
      if (field.value.kind === "context-stops") {
        const roomSize = Number(raw(12));
        const table = field.value.contexts[effect]?.[roomSize];
        requested = table === undefined ? invalid() : codecOf({ kind: "stops", unit: field.value.unit, stops: table, scale: field.value.scale, ordinal: 0 }).decode(raw(field.slot));
      } else {
        requested = codecOf(field.value).decode(raw(field.slot));
      }
      if (requested === undefined) {
        invalid();
      }
      const target = { bus, effect, parameter };
      // Every stored value is checked before any write, an omitted Delay Time included (F18-D-A, F18-V).
      validateSetting(model, ...(["bus.fx.parameter", target, requested] as unknown as WriteArgs));
      if (parameter === "delay-time" && codecOf({ kind: "switch" }).decode(raw(effectRule.parameters["sync"]?.slot ?? -1)) === true) {
        omit("bus.fx.parameter", target, "device_controlled");
        continue;
      }
      room();
      steps.push({ phase, setting: "bus.fx.parameter", target, component: null, requested, planned: null });
    }
  }
}

/** The Delay parameters sent first, in this order (F18-D-A). */
const DELAY_FIRST = ["sync", "bpm", "note"];

/**
 * F18-IN-B: the file's phantom and HI-Z switches, Off requests before On
 * requests, phantom before HI-Z within each, jacks ascending. The block is
 * contiguous in phase 3, ahead of analog gain and Clip Safe.
 */
function orderInputSwitches(steps: PlannedStep[]): void {
  const first = steps.findIndex((step) => step.setting === "input.phantom" || step.setting === "input.hi-z");
  if (first === -1) {
    return;
  }
  let end = first;
  while (end < steps.length && (steps[end]?.setting === "input.phantom" || steps[end]?.setting === "input.hi-z")) {
    end += 1;
  }
  const block = steps.slice(first, end);
  const group = (on: boolean, setting: SettingId) => block.filter((step) => step.setting === setting && step.requested === on);
  const ordered = [...group(false, "input.phantom"), ...group(false, "input.hi-z"), ...group(true, "input.phantom"), ...group(true, "input.hi-z")];
  if (ordered.length !== block.length) {
    return invalid();
  }
  steps.splice(first, block.length, ...ordered);
}
