import { describe, expect, it } from "vitest";
import { FX_RETURN_RULES } from "../src/catalog/fx-return.js";
import type { Model } from "../src/catalog/models.js";
import { settingDefinitions, type SettingDefinitionBase, type SettingId } from "../src/catalog/settings.js";
import type { UrxfChunk, UrxfFile } from "../src/catalog/urxf.js";
import { applyCurrent } from "../src/composition/apply.js";
import { EXCLUDED, PHASES } from "../src/composition/coverage.js";
import { PLAN_ITEM_LIMIT, planCurrent } from "../src/composition/plan.js";
import { targetsOf } from "../src/composition/targets.js";
import { ConsoleLockGuard } from "../src/operations/console-lock.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { settingHandlers, validateSetting, type WriteArgs } from "../src/operations/registry.js";
import { codecOf } from "../src/operations/rules.js";
import { FakeTransport } from "./fake-transport.js";

const models: Model[] = ["URX22", "URX44", "URX44V"];
const CANDIDATES = [0, 1, 2, 3, 4, 6, 24, 50, 57, 60, 92, 93, 100, 200, 256, 288, 512, 768, 1024, 1792, 32768, 4294967295, -600, -1000, -5400, 48000];
type Locate = (model: string, target: object) => { at: { paramId: number; x: string; y: string }; text: boolean; decode: (raw: string) => unknown };

/** A complete CURRENT chunk for `model`: a decodable stored value at every included setting's address. */
function synthesize(model: Model, overrides: Record<string, number | string> = {}): UrxfFile {
  const params = new Map<number, (number | string)[]>();
  const put = (paramId: number, x: number, y: number, value: number | string) => {
    const values = params.get(paramId + x) ?? [];
    values[y] = value;
    params.set(paramId + x, values);
  };
  for (const { settings } of PHASES) {
    for (const setting of settings) {
      if (setting === "bus.fx.parameter" || setting === "bus.geq.gain") continue;
      const rule = (settingDefinitions as Record<string, SettingDefinitionBase>)[setting]?.rule;
      const locate = (settingHandlers as unknown as Record<string, { locate?: Locate }>)[setting]?.locate;
      if (rule === undefined || locate === undefined) continue;
      for (const target of targetsOf(rule, model)) {
        const { at, text, decode } = locate(model, target);
        // A stored value that decodes and that the setting would also write (or whose write is unbound).
        const writable = (raw: number | string) => {
          const read = decode(`${raw}`) as { kind?: string; text?: string } | undefined;
          if (read === undefined) return false;
          const decoded = typeof read === "object" && read !== null && read.kind === "text" ? read.text : read;
          try {
            validateSetting(model, ...([setting, target, decoded] as unknown as WriteArgs));
            return true;
          } catch (error) {
            return operationFailureOf(error)?.code === "unsupported_operation";
          }
        };
        const value = text ? ["Name", "0001"].find(writable) : [...CANDIDATES, 400, 1000].find(writable);
        if (value === undefined) throw new Error(`no stored value decodes for ${setting} ${JSON.stringify(target)}`);
        put(at.paramId, Number(at.x), Number(at.y), value);
      }
    }
  }
  // GEQ gains, the FX returns (REV-X Hall on FX 1, Rev.R3 Hall on FX 2) and the sample rate.
  for (let index = 0; index < 31; index += 1) {
    for (const y of [0, 1]) put(545, index, y, 0);
    for (const y of [0, 1, 2, 3]) put(638 + index, 0, y, 0);
  }
  put(679, 0, 0, 0);
  put(683, 0, 0, 768);
  const fx = FX_RETURN_RULES["bus.fx.parameter"];
  for (const [effect, array] of [["rev-x-hall", 681], ["rev-r3-hall", 685]] as const) {
    for (const field of Object.values(fx.effects[effect]?.parameters ?? {})) {
      if (field === undefined) continue;
      const codec = field.value.kind === "context-stops" ? undefined : codecOf(field.value);
      put(array, 0, field.slot, codec === undefined ? 0 : (CANDIDATES.find((raw) => codec.decode(`${raw}`) !== undefined) as number));
    }
  }
  put(766, 0, 0, 48000);
  for (const [key, value] of Object.entries(overrides)) {
    const [paramId, y] = key.split(":").map(Number) as [number, number];
    put(paramId, 0, y, value);
  }
  const current: UrxfChunk = { name: "CURRENT", label: "", params: params as unknown as UrxfChunk["params"] };
  return { family: "URX", chunks: [current], current };
}

const key = (setting: string, target: object) => `${setting} ${JSON.stringify(target)}`;

describe("CURRENT composition (K36, F18)", () => {
  it("plan every included setting and target once, in phase order, with known omissions", () => {
    for (const model of models) {
      const plan = planCurrent(synthesize(model), model);
      const phases = plan.steps.map((step) => step.phase);
      expect(phases, model).toEqual([...phases].sort((a, b) => a - b));
      const all = [...plan.steps.map((s) => key(s.setting, s.target)), ...plan.omissions.map((o) => key(o.setting, o.target))];
      expect(new Set(all).size, model).toBe(all.length);
      expect(plan.steps.length + plan.omissions.length).toBeLessThanOrEqual(PLAN_ITEM_LIMIT);
      const omitted = (setting: SettingId) => plan.omissions.filter((o) => o.setting === setting).map((o) => o.reason);
      // Writes awaiting evidence and read-only settings are known omissions, not steps.
      expect(new Set(omitted("channel.stereo-link")), model).toEqual(new Set(["not_writable"]));
      expect(new Set(omitted("bus.type")), model).toEqual(new Set(["not_writable"]));
      expect(plan.omissions.some((o) => o.setting === "bus.fader" && (o.target as { bus: string }).bus === "mix-1")).toBe(true);
      expect(plan.steps.some((s) => s.setting === "bus.fader" && (s.target as { bus: string }).bus === "stereo")).toBe(true);
      expect(new Set(omitted("device.brightness"))).toEqual(new Set(["excluded_by_scope"]));
      // GEQ writes need the live EQ Type (and Limit for gain): phase-5 steps planned at execution.
      for (const setting of ["bus.geq.on", "bus.geq.link", "bus.geq.limit", "bus.geq.gain"] as const) {
        const live = plan.steps.filter((s) => s.setting === setting);
        expect(live.length, `${model} ${setting}`).toBeGreaterThan(0);
        expect(new Set(live.map((s) => `${s.phase} ${String(s.planned)}`)), `${model} ${setting}`).toEqual(new Set(["5 null"]));
      }
      // STEREO GEQ gain writes the 20 Hz band only: its other bands are not_writable omissions, not steps.
      const stereoGain = (entries: readonly { setting: string; target: unknown }[]) =>
        entries.filter((e) => e.setting === "bus.geq.gain" && (e.target as { bus: string }).bus === "stereo").map((e) => (e.target as { band: string }).band);
      expect(new Set(stereoGain(plan.steps)), model).toEqual(new Set(["20"]));
      expect(stereoGain(plan.omissions).length, model).toBe(2 * 30);
      // Bus names and colors in phase 10 (OV-BUS): STEREO and FX 1/2 are steps; MIX 1/2 are not_writable omissions.
      for (const setting of ["bus.name", "bus.color"] as const) {
        const stepped = plan.steps.filter((s) => s.setting === setting).map((s) => [s.phase, (s.target as { bus: string }).bus]);
        expect(stepped.slice(0, 3), `${model} ${setting}`).toEqual([
          [10, "stereo"],
          [10, "fx-1"],
          [10, "fx-2"],
        ]);
        expect(new Set(omitted(setting)), `${model} ${setting}`).toEqual(new Set(["not_writable"]));
        const skipped = plan.omissions.filter((o) => o.setting === setting).map((o) => (o.target as { bus: string }).bus);
        expect(skipped.slice(0, 2), `${model} ${setting}`).toEqual(["mix-1", "mix-2"]);
      }
      // Every catalog setting is in a phase or excluded.
      const covered = new Set<string>([...PHASES.flatMap((p) => p.settings), ...Object.keys(EXCLUDED)]);
      expect(Object.keys(settingDefinitions).filter((id) => !covered.has(id))).toEqual([]);
      // Structural before routing before audio; source pan before send pan; names last.
      const first = (setting: SettingId) => plan.steps.findIndex((s) => s.setting === setting);
      expect(first("channel.pan-mode")).toBeLessThan(first("channel.source"));
      expect(first("channel.pan")).toBeLessThan(first("send.on"));
      // Phase 10 closes the plan: the channel names and colors, then the bus names and colors.
      const identity = ["channel.name", "channel.color", "bus.name", "bus.color"];
      const tail = plan.steps.slice(first("channel.name"));
      expect(new Set(tail.map((s) => s.setting)), model).toEqual(new Set(identity));
      expect(tail.findIndex((s) => s.setting.startsWith("bus."))).toBe(tail.filter((s) => s.setting.startsWith("channel.")).length);
    }
  });

  it("refuse the whole file for a stored value the setting cannot write, and for a plan over its bound", () => {
    for (const model of models) {
      // A stored name of nine code points reads, but no write takes it: the file is refused, not the row omitted.
      const tooLong = synthesize(model, { "18:0": "NineChars" });
      const failure = (() => {
        try {
          planCurrent(tooLong, model);
          return undefined;
        } catch (error) {
          return operationFailureOf(error)?.code;
        }
      })();
      expect(failure, model).toBe("invalid_input");
      // F18-Q: steps and omissions together within the bound; one item over it refuses the file.
      const file = synthesize(model);
      const size = (() => {
        const plan = planCurrent(file, model);
        return plan.steps.length + plan.omissions.length;
      })();
      expect(size, model).toBeLessThanOrEqual(PLAN_ITEM_LIMIT);
      expect(() => planCurrent(file, model, size), model).not.toThrow();
      expect(() => planCurrent(file, model, size - 1), model).toThrow(/invalid_input/);
    }
  });

  it("omit the automatically controlled values the file enables (F18-C), and fail whole on a missing value", () => {
    const base = planCurrent(synthesize("URX22"), "URX22");
    const oneKnob = planCurrent(synthesize("URX22", { "42:0": 1 }), "URX22");
    const manual = ["channel.comp.threshold", "channel.comp.ratio", "channel.comp.gain", "channel.comp.knee", "channel.comp.attack", "channel.comp.release"];
    const forChannel1 = (plan: typeof base, reason: string) =>
      plan.omissions.filter((o) => (o.target as { channel?: number }).channel === 1 && o.reason === reason).map((o) => o.setting);
    expect(forChannel1(base, "device_controlled")).toEqual([]);
    expect(forChannel1(oneKnob, "device_controlled").sort()).toEqual([...manual].sort());
    const autoMakeup = planCurrent(synthesize("URX22", { "41:0": 1 }), "URX22");
    expect(forChannel1(autoMakeup, "device_controlled")).toEqual(["channel.comp.gain"]);
    const peq = planCurrent(synthesize("URX22", { "46:0": 1 }), "URX22");
    expect(forChannel1(peq, "device_controlled").length).toBe(4 * 4 + 2);
    const file = synthesize("URX22");
    (file.current.params as Map<number, unknown>).delete(139);
    expect(operationFailureOf((() => { try { planCurrent(file, "URX22"); } catch (error) { return error; } return undefined; })())?.code).toBe("invalid_input");
  });

  it("check the sample rate first, write the steps in order, and stop at the first failure", async () => {
    const file = synthesize("URX22");
    const plan = planCurrent(file, "URX22");
    const head = { steps: plan.steps.filter((s) => s.planned !== null).slice(0, 5), omissions: [] };
    const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
    const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
    const rejected = { kind: "failure", failure: { kind: "cause", code: "device_rejected", phase: "response" }, evidence: { state: "rejected", responseCode: "9" } };
    // Each import is one guarded write operation: the lock read (895) first, then the rate (766).
    const apply = async (transport: FakeTransport, dryRun = false) => {
      const context = new OperationContext(transport, "URX22");
      const guard = await ConsoleLockGuard.open(context);
      try {
        return await applyCurrent(context, file, head, { guard, dryRun });
      } finally {
        await guard.release();
      }
    };
    const mismatch = new FakeTransport().script("getNumeric", read("0"), read("96000"));
    const refused = await apply(mismatch);
    expect(refused.error).toBe("precondition_failed");
    expect(mismatch.calls.map((c) => c.address.paramId)).toEqual([895, 766]);
    const transport = new FakeTransport().script("getNumeric", read("0"), read("48000")).script("setNumeric", accepted, accepted, rejected).script("setText", accepted);
    const result = await apply(transport);
    expect(result.error).toBe("device_rejected");
    expect(result.steps.map((s) => s.outcome)).toEqual(["accepted", "accepted", "rejected", "not_sent", "not_sent"]);
    expect(transport.calls.filter((c) => c.method.startsWith("set")).length).toBe(3);
    const dry = new FakeTransport().script("getNumeric", read("0"), read("48000"));
    const preview = await apply(dry, true);
    expect(preview.error).toBeNull();
    expect(dry.calls.map((c) => c.address.paramId).slice(0, 2)).toEqual([895, 766]);
    expect(dry.calls.filter((c) => c.method.startsWith("set"))).toEqual([]);
    // A locked unit stops the import before the rate read and any write.
    const locked = new FakeTransport().script("getNumeric", read("1"));
    const stopped = await apply(locked);
    expect(stopped.error).toBe("precondition_failed");
    expect(stopped.steps.every((s) => s.outcome === "not_sent")).toBe(true);
    expect(locked.calls.map((c) => c.address.paramId)).toEqual([895]);
    // A lock during the import stops the unsent steps; the accepted ones stay.
    const mid = new FakeTransport().script("getNumeric", read("0"), read("48000"));
    let sent = 0;
    mid.script(
      "setNumeric",
      ...[0, 1, 2, 3, 4].map(() => ({
        then(resolve: (record: unknown) => void) {
          sent += 1;
          if (sent === 2) mid.notify({ kind: "numeric", address: { paramId: 895, x: "0", y: "0" }, value: "1" });
          resolve(accepted);
        },
      })),
    ).script("setText", accepted);
    const interrupted = await apply(mid);
    expect(interrupted.error).toBe("precondition_failed");
    expect(interrupted.steps.map((s) => s.outcome).slice(0, 3)).toEqual(["accepted", "accepted", "not_sent"]);
  });
});
