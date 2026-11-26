// The CURRENT application plan (K36, F18): from one parsed file and the
// connected model, the ordered write steps and the omission records, built
// before any setting write. Values are decoded strictly from the CURRENT chunk
// and planned with each setting's own validation and rounding (F18-V); a
// missing or invalid included value refuses the whole plan.

import { BUS_TOKENS } from "../catalog/buses.js";
import { SOURCE_TOKENS } from "../catalog/inputs.js";
import { OUTPUT_TOKENS } from "../catalog/output-routing.js";
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
  /** The model the plan was built for; applying it to another is refused before any request. */
  readonly model: Model;
  /** The file's sample rate, checked when the plan was built (L3); the device must report it before any write. */
  readonly fileRate: number;
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
  // The file's rate is part of the plan: a missing or invalid one refuses the file here (L3).
  const fileRate = value("device.sample-rate", {}) as number;

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
  orderByTarget(steps);
  // Scope exclusions present in the catalog for this model, in catalog order.
  for (const [setting, reason] of Object.entries(EXCLUDED) as [SettingId, OmissionReason][]) {
    const rule = (settingDefinitions as Record<string, SettingDefinitionBase>)[setting]?.rule;
    for (const target of rule === undefined ? [] : targetsOf(rule, model)) {
      omit(setting, target, reason);
    }
  }
  return { model, fileRate, steps, omissions };
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

/** The entity a step's target names (K36 target order): a jack, a channel, a send route, a bus, an output, a track. */
/** A step's target kind and its position in the kind's canonical order (K36). */
function entityOf(step: PlannedStep): { kind: string; position: number } {
  const target = step.target as { input?: number; channel?: number; source?: string; destination?: string; bus?: string; output?: string; track?: number };
  if (target.destination !== undefined) {
    // Sources by C12 number, then FX 1/2; destinations MIX 1/2, FX 1/2 within each (targetsOf).
    const source = target.source?.startsWith("channel-") === true ? Number(target.source.slice(8)) : 1000 + ["fx-1", "fx-2"].indexOf(target.source ?? "");
    return { kind: "send", position: source * 10 + ["mix-1", "mix-2", "fx-1", "fx-2"].indexOf(target.destination) };
  }
  if (target.input !== undefined) return { kind: "input", position: target.input };
  if (target.channel !== undefined) return { kind: "channel", position: target.channel };
  if (target.source !== undefined) return { kind: "source", position: (SOURCE_TOKENS as readonly string[]).indexOf(target.source) };
  if (target.bus !== undefined) return { kind: "bus", position: (BUS_TOKENS as readonly string[]).indexOf(target.bus) };
  if (target.output !== undefined) return { kind: "output", position: (OUTPUT_TOKENS as readonly string[]).indexOf(target.output) };
  if (target.track !== undefined) return { kind: "track", position: target.track };
  return { kind: "device", position: 0 };
}

/**
 * K36: a phase iterates its targets, each target's settings in the phase's
 * order, targets in their canonical order: target kinds as they first appear
 * in the phase, targets of a kind in the catalog's canonical order (channels
 * by C12 number, buses STEREO, MIX 1/2, FX 1/2, STREAMING, MONITOR 1/2,
 * outputs in their published order, jacks and tracks ascending). Phase 6 is the
 * exception: every Insert-FX type, then the engines' values, then every On.
 * Within a bus in phase 5, the sided GEQ settings go left, then right, after
 * the bus's other settings (F18-G). Within a jack in phase 3, the file's
 * phantom and HI-Z switches go Off requests before On, phantom before HI-Z
 * within each (F18-IN-B).
 */
function orderByTarget(steps: PlannedStep[]): void {
  let start = 0;
  while (start < steps.length) {
    const phase = (steps[start] as PlannedStep).phase;
    let end = start;
    while (end < steps.length && (steps[end] as PlannedStep).phase === phase) end += 1;
    if (phase !== 6) {
      const block = steps.slice(start, end);
      const kinds = new Map<string, number>();
      for (const step of block) if (!kinds.has(entityOf(step).kind)) kinds.set(entityOf(step).kind, kinds.size);
      const entity = (step: PlannedStep) => {
        const { kind, position } = entityOf(step);
        return (kinds.get(kind) as number) * 100_000 + position;
      };
      const rank = (step: PlannedStep) => {
        if (phase === 5) {
          const side = (step.target as { side?: string }).side;
          return side === "left" ? 1 : side === "right" ? 2 : 0;
        }
        if (phase === 3 && (step.setting === "input.phantom" || step.setting === "input.hi-z")) {
          return (step.requested === true ? 2 : 0) + (step.setting === "input.hi-z" ? 1 : 0);
        }
        return phase === 3 ? 4 : 0;
      };
      const keyed = block.map((step, index) => ({ step, index, entity: entity(step), rank: rank(step) }));
      keyed.sort((a, b) => a.entity - b.entity || a.rank - b.rank || a.index - b.index);
      steps.splice(start, block.length, ...keyed.map((each) => each.step));
    }
    start = end;
  }
}
