// The CURRENT application plan (K36, F18): from one parsed file and the
// connected model, the ordered write steps and the omission records, built
// before any setting write. Values are decoded strictly from the CURRENT chunk
// and planned with each setting's own validation and rounding (F18-V); a
// missing or invalid included value refuses the whole plan.

import { settingDefinitions, type SettingDefinitionBase, type SettingId } from "../catalog/settings.js";
import type { Model } from "../catalog/models.js";
import { urxfValue, type UrxfChunk, type UrxfFile } from "../catalog/urxf.js";
import { FX_RETURN_RULES } from "../catalog/fx-return.js";
import type { FxParameterRule, GeqGainRule } from "../catalog/rules.js";
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

/** Settings whose plan needs a live prerequisite read: planned at execution. */
/** Settings whose plan needs a live prerequisite read (F07-G, F06-F): planned at execution, checked statically here. */
const LIVE: ReadonlySet<SettingId> = new Set<SettingId>(["bus.geq.on", "bus.geq.link", "bus.geq.limit", "bus.geq.gain", "bus.fx.parameter"]);

function invalid(): never {
  throw new OperationFailureError({ code: "invalid_input", phase: "preparation", progress: null });
}

/** Builds the plan, refusing the whole file before any write on a missing or invalid value or an over-limit plan. */
export function planCurrent(file: UrxfFile, model: Model): CurrentPlan {
  const chunk = file.current;
  const steps: PlannedStep[] = [];
  const omissions: Omission[] = [];
  const room = () => {
    if (steps.length + omissions.length >= PLAN_ITEM_LIMIT) {
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
        const requested = setting === "bus.geq.gain" ? geqGainOf(chunk, target) : value(setting, target);
        const native = control(setting, target);
        if (native !== undefined) {
          omit(setting, target, native);
          continue;
        }
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
        room();
        steps.push({ phase, setting, target, component: null, requested, planned });
      }
    }
  }
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

/** A Flex12GEQ band gain from the file: raw centi-dB −2400…1500 at its address. */
function geqGainOf(chunk: UrxfChunk, target: object): number {
  const { bus, side, band } = target as { bus: string; side: "left" | "right"; band: string };
  const rule: GeqGainRule = settingDefinitions["bus.geq.gain"].rule;
  const at = rule.address[bus];
  if (at === undefined) {
    return invalid();
  }
  const index = rule.bands.indexOf(band);
  const raw = at.perBand === "x" ? urxfValue(chunk, at.paramId, index, at.y[side]) : urxfValue(chunk, at.paramId + index, 0, at.y[side]);
  return typeof raw === "number" && Number.isInteger(raw) && raw >= rule.read.min && raw <= rule.read.max ? raw / rule.scale : invalid();
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
  void omit;
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
    const ordered = names.includes("room-size") ? ["room-size", ...names.filter((name) => name !== "room-size")] : names;
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
      room();
      steps.push({ phase, setting: "bus.fx.parameter", target: { bus, effect, parameter }, component: null, requested, planned: null });
    }
  }
}
