import { describe, expect, it } from "vitest";
import { FX_RETURN_RULES } from "../src/catalog/fx-return.js";
import { HI_Z_JACKS, INPUT_JACKS, SOURCE_TOKENS } from "../src/catalog/inputs.js";
import type { Model } from "../src/catalog/models.js";
import { settingDefinitions, type SettingDefinitionBase, type SettingId } from "../src/catalog/settings.js";
import type { UrxfChunk, UrxfFile } from "../src/catalog/urxf.js";
import { applyCurrent } from "../src/composition/apply.js";
import { EXCLUDED, PHASES } from "../src/composition/coverage.js";
import { PLAN_ITEM_LIMIT, planCurrent } from "../src/composition/plan.js";
import { targetsOf } from "../src/composition/targets.js";
import { ConsoleLockGuard } from "../src/operations/console-lock.js";
import { OperationContext } from "../src/operations/context.js";
import { OperationFailureError, operationFailureOf } from "../src/operations/failure.js";
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
      // The MIX fader's one write is evidenced on URX22 only (F03-G): a step there, an omission elsewhere.
      const mixFader = (entries: readonly { setting: string; target: unknown }[]) =>
        entries.some((e) => e.setting === "bus.fader" && (e.target as { bus: string }).bus === "mix-1");
      expect(mixFader(plan.steps), model).toBe(model === "URX22");
      expect(mixFader(plan.omissions), model).toBe(model !== "URX22");
      expect(plan.steps.some((s) => s.setting === "bus.fader" && (s.target as { bus: string }).bus === "stereo")).toBe(true);
      expect(new Set(omitted("device.brightness"))).toEqual(new Set(["excluded_by_scope"]));
      // F18-G-A: every bus's file EQ Type here is PEQ, so no GEQ setting is a step. STEREO's non-20 Hz gains are
      // not_writable (that reason comes first, F18-R-A); every other GEQ row is inactive_bank.
      for (const setting of ["bus.geq.on", "bus.geq.link", "bus.geq.limit", "bus.geq.gain"] as const) {
        expect(plan.steps.filter((s) => s.setting === setting), `${model} ${setting}`).toEqual([]);
      }
      const geqReasons = (setting: SettingId) =>
        new Set(plan.omissions.filter((o) => o.setting === setting).map((o) => `${(o.target as { bus: string }).bus} ${o.reason}`));
      expect(geqReasons("bus.geq.on"), model).toEqual(new Set(["stereo inactive_bank", "mix-1 inactive_bank", "mix-2 inactive_bank"]));
      expect(geqReasons("bus.geq.gain"), model).toEqual(new Set(["stereo not_writable", "stereo inactive_bank", "mix-1 inactive_bank", "mix-2 inactive_bank"]));
      const stereoGain = plan.omissions.filter((o) => o.setting === "bus.geq.gain" && (o.target as { bus: string }).bus === "stereo");
      expect(stereoGain.filter((o) => o.reason === "inactive_bank").map((o) => (o.target as { band: string }).band), model).toEqual(["20", "20"]);
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
        // STREAMING's one write is evidenced on URX22 only (F03-G): a step there, an omission elsewhere.
        expect(stepped.some(([, bus]) => bus === "stream"), `${model} ${setting}`).toBe(model === "URX22");
        expect(skipped.includes("stream"), `${model} ${setting}`).toBe(model !== "URX22");
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

  it("apply the GEQ bank only where the file's EQ Type is Flex12GEQ, as live phase-5 steps (F18-G-A)", () => {
    for (const model of models) {
      // STEREO and MIX 1 store Flex12GEQ (raw 2); MIX 2 stays PEQ.
      const plan = planCurrent(synthesize(model, { "497:0": 2, "590:0": 2 }), model);
      for (const setting of ["bus.geq.on", "bus.geq.link", "bus.geq.limit", "bus.geq.gain"] as const) {
        const live = plan.steps.filter((s) => s.setting === setting);
        expect(new Set(live.map((s) => (s.target as { bus: string }).bus)), `${model} ${setting}`).toEqual(new Set(["stereo", "mix-1"]));
        expect(new Set(live.map((s) => `${s.phase} ${String(s.planned)}`)), `${model} ${setting}`).toEqual(new Set(["5 null"]));
        const mix2 = plan.omissions.filter((o) => o.setting === setting && (o.target as { bus: string }).bus === "mix-2").map((o) => o.reason);
        expect(new Set(mix2), `${model} ${setting}`).toEqual(new Set(["inactive_bank"]));
      }
      const stereoGain = plan.steps.filter((s) => s.setting === "bus.geq.gain" && (s.target as { bus: string }).bus === "stereo");
      expect(new Set(stereoGain.map((s) => (s.target as { band: string }).band)), model).toEqual(new Set(["20"]));
    }
  });

  it("select each bus's GEQ bank from the file's EQ Type: an unselected bank requires no values; a selected one above 48 kHz refuses the file (F18-G-A)", () => {
    // Every GEQ value the file can hold: Link, On, Limit and the gains, STEREO's 20 Hz included.
    const GEQ_KEYS = [543, 544, 893, 545, 636, 637, 894, ...Array.from({ length: 31 }, (_, index) => 638 + index)];
    const without = (file: UrxfFile, keys: readonly number[]) => {
      for (const id of keys) (file.current.params as unknown as Map<number, unknown>).delete(id);
      return file;
    };
    for (const model of models) {
      // All PEQ: the GEQ values are absent, and the plan keeps the same reasons as with them.
      const full = planCurrent(synthesize(model), model);
      const bare = planCurrent(without(synthesize(model), GEQ_KEYS), model);
      const geq = (plan: typeof full) => plan.omissions.filter((o) => o.setting.startsWith("bus.geq."));
      expect(geq(bare), model).toEqual(geq(full));
      expect(bare.steps, model).toEqual(full.steps);
      // MIX 1/2 PEQ, STEREO GEQ: MIX's GEQ values are still not required; STEREO's are.
      expect(() => planCurrent(without(synthesize(model, { "497:0": 2 }), GEQ_KEYS.slice(4)), model), model).not.toThrow();
      expect(() => planCurrent(without(synthesize(model, { "497:0": 2 }), [544]), model), model).toThrow(/invalid_input/);
      // The rate limit: a selected Flex12GEQ above 48 kHz refuses the file; PEQ at 96 kHz plans.
      expect(() => planCurrent(synthesize(model, { "590:0": 2, "766:0": 96000 }), model), model).toThrow(/invalid_input/);
      expect(() => planCurrent(synthesize(model, { "497:0": 2, "766:0": 88200 }), model), model).toThrow(/invalid_input/);
      expect(planCurrent(synthesize(model, { "766:0": 96000 }), model).fileRate, model).toBe(96000);
      expect(planCurrent(synthesize(model, { "497:0": 2, "590:0": 2, "766:0": 44100 }), model).fileRate, model).toBe(44100);
    }
  });

  it("send a Delay's Sync, BPM, Note, the rest, then Delay Time; omit the time with Sync On (F18-D-A)", () => {
    const delay = FX_RETURN_RULES["bus.fx.parameter"].effects["mono-delay"];
    const stored: Record<string, number> = { "679:0": 1024 };
    for (const field of Object.values(delay?.parameters ?? {})) {
      if (field === undefined || field.value.kind === "context-stops") continue;
      const codec = codecOf(field.value);
      stored[`681:${field.slot}`] = CANDIDATES.find((raw) => codec.decode(`${raw}`) !== undefined) as number;
    }
    for (const model of models) {
      for (const sync of [0, 1]) {
        const plan = planCurrent(synthesize(model, { ...stored, "681:4": sync }), model);
        const fx1 = (entries: readonly { setting: string; target: unknown }[]) =>
          entries.filter((e) => e.setting === "bus.fx.parameter" && (e.target as { bus: string }).bus === "fx-1").map((e) => (e.target as { parameter: string }).parameter);
        const rest = ["feedback", "hi-ratio", "hpf", "lpf"];
        expect(fx1(plan.steps), `${model} sync ${sync}`).toEqual(["sync", "bpm", "note", ...rest, ...(sync === 0 ? ["delay-time"] : [])]);
        expect(fx1(plan.omissions), `${model} sync ${sync}`).toEqual(sync === 1 ? ["delay-time"] : []);
        if (sync === 1) {
          expect(plan.omissions.find((o) => o.setting === "bus.fx.parameter")?.reason).toBe("device_controlled");
        }
      }
    }
  });

  it("send each jack's Off switches before its On switches, phantom first in each, then its gain and Clip Safe (K36, F18-IN-B)", () => {
    for (const model of models) {
      const jacks = INPUT_JACKS[model];
      const hiZ = HI_Z_JACKS[model];
      // Alternate: odd jacks phantom On / HI-Z Off, even jacks phantom Off / HI-Z On.
      const stored: Record<string, number> = {};
      for (const jack of jacks) {
        stored[`0:${jack - 1}`] = jack % 2;
        if (hiZ.includes(jack)) stored[`6:${jack - 1}`] = 1 - (jack % 2);
      }
      const plan = planCurrent(synthesize(model, stored), model);
      const phase3 = plan.steps.filter((s) => s.phase === 3 && s.setting.startsWith("input.")).map((s) => `${s.setting} ${(s.target as { input?: number }).input ?? ""} ${String(s.requested)}`);
      // K36: jack by jack, ascending; within a jack, Off switches before On (phantom before HI-Z), then gain, then Clip Safe.
      const expected = jacks.flatMap((jack) => {
        const switches = [
          { setting: "input.phantom", on: jack % 2 === 1 },
          ...(hiZ.includes(jack) ? [{ setting: "input.hi-z", on: jack % 2 === 0 }] : []),
        ];
        const ordered = [...switches.filter((each) => !each.on), ...switches.filter((each) => each.on)];
        return [...ordered.map((each) => `${each.setting} ${jack} ${each.on}`), `input.gain ${jack}`, `input.clip-safe ${jack}`];
      });
      expect(phase3.map((entry) => entry.split(" ").slice(0, entry.startsWith("input.gain") || entry.startsWith("input.clip-safe") ? 2 : 3).join(" ")), model).toEqual(expected);
    }
  });

  it("dry-run the FX parameters after the file's unsent type write as unverified, not refused (O13)", async () => {
    // FX 1 holds a Delay now; the file selects REV-X Hall. FX 2 already holds the file's Rev.R3 Hall.
    class Unit extends FakeTransport {
      override getNumeric(address: { paramId: number; x: string; y: string }, request: Parameters<FakeTransport["getNumeric"]>[1]): Promise<unknown> {
        const value = { 895: "0", 766: "48000", 679: "1024", 683: "768" }[address.paramId] ?? "0";
        this.calls.push({ method: "getNumeric", address: address as never, ticket: request.requestTicket });
        return Promise.resolve({ kind: "success", value, evidence: { state: "read" } });
      }
    }
    for (const model of models) {
      const file = synthesize(model);
      const plan = planCurrent(file, model);
      const unit = new Unit();
      const context = new OperationContext(unit, model);
      const guard = await ConsoleLockGuard.open(context);
      const result = await applyCurrent(context, plan, { guard, dryRun: true });
      await guard.release();
      expect(result.error, model).toBeNull();
      const fx = (bus: string) => result.steps.filter((s) => s.setting === "bus.fx.parameter" && (s.target as { bus: string }).bus === bus);
      const time = fx("fx-1").find((s) => (s.target as { parameter: string }).parameter === "reverb-time");
      expect([time?.planned, time?.unverified], model).toEqual([null, ["fx_type_matches", "revx_room_size"]]);
      expect(fx("fx-1").every((s) => s.unverified.includes("fx_type_matches")), model).toBe(true);
      // FX 2's type is also written by the file first, so its parameters are unverified as well.
      expect(fx("fx-2").every((s) => s.unverified.includes("fx_type_matches")), model).toBe(true);
      // No FX-1 array slot is read in a layout the live selector does not establish.
      expect(unit.calls.some((c) => c.address.paramId === 681), model).toBe(false);
      expect(unit.calls.filter((c) => c.method.startsWith("set")), model).toEqual([]);
      // Steps that no earlier step affects stay verified.
      expect(result.steps.filter((s) => s.setting === "channel.fader").every((s) => s.unverified.length === 0), model).toBe(true);
    }
  });

  it("order each phase by target, every target's settings together (K36)", () => {
    for (const model of models) {
      const plan = planCurrent(synthesize(model, { "497:0": 2, "590:0": 2 }), model);
      const position = (predicate: (step: (typeof plan.steps)[number]) => boolean) => plan.steps.map((step, index) => (predicate(step) ? index : -1)).filter((index) => index >= 0);
      // Phase 4: every step of the first channel before any step of the second.
      const [first, second] = [...new Set(plan.steps.filter((s) => s.phase === 4).map((s) => (s.target as { channel: number }).channel))];
      expect(Math.max(...position((s) => s.phase === 4 && (s.target as { channel?: number }).channel === first)), model).toBeLessThan(
        Math.min(...position((s) => s.phase === 4 && (s.target as { channel?: number }).channel === second)),
      );
      // Phase 5, MIX 1: the bus's sideless settings, then its left GEQ, then its right GEQ; STEREO entirely before MIX 1.
      const mix1 = plan.steps.filter((s) => s.phase === 5 && (s.target as { bus?: string }).bus === "mix-1");
      const sides = mix1.map((s) => (s.target as { side?: string }).side ?? "none");
      expect(sides, model).toEqual([...sides].sort((a, b) => ["none", "left", "right"].indexOf(a) - ["none", "left", "right"].indexOf(b)));
      expect(mix1.findIndex((s) => s.setting === "bus.geq.link"), model).toBeLessThan(mix1.findIndex((s) => (s.target as { side?: string }).side === "left"));
      expect(Math.max(...position((s) => s.phase === 5 && (s.target as { bus?: string }).bus === "stereo")), model).toBeLessThan(
        Math.min(...position((s) => s.phase === 5 && (s.target as { bus?: string }).bus === "mix-1")),
      );
      // Phase 9: every step of one send route before the next route's.
      const routes = plan.steps.filter((s) => s.phase === 9 && "destination" in (s.target as object)).map((s) => JSON.stringify(s.target));
      const seen: string[] = [];
      for (const route of routes) if (seen.at(-1) !== route) seen.push(route);
      expect(new Set(seen).size, model).toBe(seen.length);
    }
  });

  it("keep every phase's targets in the canonical order, whichever setting a target first appears in (K36)", () => {
    const buses = ["stereo", "mix-1", "mix-2", "fx-1", "fx-2", "stream", "monitor-1", "monitor-2"];
    const outputs = ["main", "line", "usb-main-a", "usb-main-b", "usb-main-c", "usb-sub", "phones-1", "phones-2"];
    const sendSource = (source: string) => (source.startsWith("channel-") ? Number(source.slice(8)) : 100 + Number(source.slice(3)));
    const canonical = (target: Record<string, unknown>): [string, number] => {
      if (typeof target.destination === "string") return ["send", sendSource(`${target.source}`) * 10 + ["mix-1", "mix-2", "fx-1", "fx-2"].indexOf(target.destination)];
      if (typeof target.input === "number") return ["input", target.input];
      if (typeof target.channel === "number") return ["channel", target.channel];
      if (typeof target.bus === "string") return ["bus", buses.indexOf(target.bus)];
      if (typeof target.output === "string") return ["output", outputs.indexOf(target.output)];
      if (typeof target.track === "number") return ["track", target.track];
      if (typeof target.source === "string") return ["source", SOURCE_TOKENS.indexOf(target.source as (typeof SOURCE_TOKENS)[number])];
      return ["device", 0];
    };
    for (const model of models) {
      for (const overrides of [{ "497:0": 2, "590:0": 2 }, {}] as Record<string, number>[]) {
        const plan = planCurrent(synthesize(model, overrides), model);
        for (const phase of new Set(plan.steps.map((s) => s.phase))) {
          if (phase === 6) continue;
          const runs: [string, number][] = [];
          for (const step of plan.steps.filter((s) => s.phase === phase)) {
            const entity = canonical(step.target as Record<string, unknown>);
            const last = runs.at(-1);
            if (last?.[0] !== entity[0] || last[1] !== entity[1]) runs.push(entity);
          }
          const label = `${model} phase ${phase}`;
          // Each target's settings stay together, and the targets of one kind ascend.
          expect(new Set(runs.map(([kind, position]) => `${kind} ${position}`)).size, label).toBe(runs.length);
          for (const kind of new Set(runs.map(([each]) => each))) {
            const positions = runs.filter(([each]) => each === kind).map(([, position]) => position);
            expect(positions, `${label} ${kind}`).toEqual([...positions].sort((a, b) => a - b));
          }
        }
      }
    }
  });

  it("apply a plan only to its own model, with the rate it was built from; keep a failed live step's planned value", async () => {
    const file = synthesize("URX44", { "497:0": 2 });
    const plan = planCurrent(file, "URX44");
    expect([plan.model, plan.fileRate]).toEqual(["URX44", 48000]);
    const other = new FakeTransport().script("getNumeric", { kind: "success", value: "0", evidence: { state: "read" } });
    const otherContext = new OperationContext(other, "URX44V");
    const guard = await ConsoleLockGuard.open(otherContext);
    const refused = await applyCurrent(otherContext, plan, { guard });
    await guard.release();
    expect(refused.error).toBe("invalid_input");
    expect(other.calls).toEqual([]);
    // A file without a valid rate is refused when the plan is built.
    expect(() => planCurrent(synthesize("URX44", { "766:0": 32000 }), "URX44")).toThrow(/invalid_input/);
    // A GEQ gain step plans at execution; its write is rejected, and the step keeps the value it planned.
    const gain = plan.steps.find((s) => s.setting === "bus.geq.gain" && (s.target as { bus: string }).bus === "stereo");
    expect(gain?.planned).toBeNull();
    const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
    const rejected = { kind: "failure", failure: { kind: "cause", code: "device_rejected", phase: "response" }, evidence: { state: "rejected", responseCode: "9" } };
    const t = new FakeTransport().script("getNumeric", read("0"), read("48000"), read("2"), read("0")).script("setNumeric", rejected);
    const context = new OperationContext(t, "URX44");
    const own = await ConsoleLockGuard.open(context);
    const result = await applyCurrent(context, { ...plan, steps: [gain as (typeof plan.steps)[number]] }, { guard: own });
    await own.release();
    expect(result.error).toBe("device_rejected");
    expect([result.steps[0]?.outcome, result.steps[0]?.planned]).toEqual(["rejected", gain?.requested]);
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
    const head = { ...plan, steps: plan.steps.filter((s) => s.planned !== null).slice(0, 5), omissions: [] };
    const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
    const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
    const rejected = { kind: "failure", failure: { kind: "cause", code: "device_rejected", phase: "response" }, evidence: { state: "rejected", responseCode: "9" } };
    // Each import is one guarded write operation: the lock read (895) first, then the rate (766).
    const apply = async (transport: FakeTransport, dryRun = false) => {
      const context = new OperationContext(transport, "URX22");
      const guard = await ConsoleLockGuard.open(context);
      try {
        return await applyCurrent(context, head, { guard, dryRun });
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
    // L5: a rate notification other than the file's after two accepted steps stops the third; a later
    // return to the file's rate does not resume; a matching notification, another address, or none, changes nothing.
    const rate = (value: string) => ({ kind: "numeric", address: { paramId: 766, x: "0", y: "0" }, value }) as const;
    const scheduled = async (events: readonly (readonly ["at", number, ReturnType<typeof rate> | { kind: "numeric"; address: { paramId: number; x: string; y: string }; value: string }])[]) => {
      const t = new FakeTransport().script("getNumeric", read("0"), read("48000"));
      let count = 0;
      t.script(
        "setNumeric",
        ...[0, 1, 2, 3, 4].map(() => ({
          then(resolve: (record: unknown) => void) {
            count += 1;
            for (const [, after, notification] of events) if (after === count) t.notify(notification);
            resolve(accepted);
          },
        })),
      ).script("setText", accepted);
      const outcome = await apply(t);
      return { outcome, t };
    };
    const changed = await scheduled([["at", 2, rate("96000")], ["at", 2, rate("48000")]]);
    expect([changed.outcome.error, ...changed.outcome.steps.map((s) => s.outcome).slice(0, 3)]).toEqual(["precondition_failed", "accepted", "accepted", "not_sent"]);
    // One lock read and one rate read for the whole import, whatever arrives.
    expect(changed.t.calls.filter((c) => c.method === "getNumeric").map((c) => c.address.paramId)).toEqual([895, 766]);
    expect(changed.t.subscriptions.map((s) => [s.addresses[0]?.paramId, s.state])).toEqual([
      [895, "released"],
      [766, "released"],
    ]);
    for (const quiet of [[["at", 1, rate("48000")]], [["at", 1, { kind: "numeric", address: { paramId: 767, x: "0", y: "0" }, value: "96000" }]], []] as const) {
      const { outcome } = await scheduled(quiet);
      expect(outcome.error, JSON.stringify(quiet)).not.toBe("precondition_failed");
      expect(outcome.steps[2]?.outcome, JSON.stringify(quiet)).toBe("accepted");
    }
    // The rate observation is active before the one rate read.
    const ordered = new FakeTransport();
    let observedAtRead: string | undefined;
    ordered
      .script("getNumeric", read("0"), {
        then(resolve: (record: unknown) => void) {
          observedAtRead = ordered.subscriptions.find((s) => s.addresses[0]?.paramId === 766)?.state;
          resolve(read("96000"));
        },
      });
    expect((await apply(ordered)).error).toBe("precondition_failed");
    expect(observedAtRead).toBe("active");
    const invalid = await scheduled([["at", 1, rate("-1")]]);
    expect([invalid.outcome.error, invalid.outcome.steps[1]?.outcome]).toEqual(["invalid_response", "not_sent"]);
    // A rate notification is judged by the rate read's codec: a rate the unit cannot run is invalid, not a mismatch.
    const unknown = await scheduled([["at", 1, rate("32000")]]);
    expect([unknown.outcome.error, unknown.outcome.steps[1]?.outcome]).toEqual(["invalid_response", "not_sent"]);
    // A failed rate observation or read prevents every write, keeping its cause.
    const readFails = new FakeTransport().script("getNumeric", read("0"), new Error("adapter failure"));
    const noRead = await apply(readFails);
    expect(noRead.error).toBe("internal_error");
    expect(readFails.calls.filter((c) => c.method.startsWith("set"))).toEqual([]);
  });

  it("report the first cause that stopped the import, in a dry run and at execution", async () => {
    const plan = planCurrent(synthesize("URX22"), "URX22");
    const head = { ...plan, steps: plan.steps.filter((s) => s.planned !== null).slice(0, 3), omissions: [] };
    const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
    const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
    const rejected = { kind: "failure", failure: { kind: "cause", code: "device_rejected", phase: "response" }, evidence: { state: "rejected", responseCode: "9" } };
    const lock = (value: string) => ({ kind: "numeric", address: { paramId: 895, x: "0", y: "0" }, value }) as const;
    const rate = (value: string) => ({ kind: "numeric", address: { paramId: 766, x: "0", y: "0" }, value }) as const;
    type Note = { readonly kind: "numeric"; readonly address: { readonly paramId: number; readonly x: string; readonly y: string }; readonly value: string };
    /** A reply that delivers `notes` before it settles with `record`. */
    const after = (t: FakeTransport, notes: readonly Note[], record: unknown) => ({
      then(resolve: (value: unknown) => void) {
        for (const note of notes) t.notify(note);
        resolve(record);
      },
    });
    const apply = async (build: (t: FakeTransport) => void, dryRun = false) => {
      const t = new FakeTransport();
      build(t);
      const context = new OperationContext(t, "URX22");
      const guard = await ConsoleLockGuard.open(context);
      try {
        return { result: await applyCurrent(context, head, { guard, dryRun }), t };
      } finally {
        // A release failure set for the rate observation fails the guard's release too; that is not under test.
        await guard.release().catch(() => undefined);
      }
    };
    // Dry run: a lock, a rate change, or an invalid one during the rate read stops it, though no later step reads.
    for (const [note, code] of [
      [lock("1"), "precondition_failed"],
      [lock("2"), "invalid_response"],
      [rate("96000"), "precondition_failed"],
      [rate("32000"), "invalid_response"],
    ] as const) {
      const { result, t } = await apply((t) => t.script("getNumeric", read("0"), after(t, [note], read("48000"))), true);
      expect([result.error, ...result.steps.map((s) => s.outcome)], JSON.stringify(note)).toEqual([code, "not_sent", "not_sent", "not_sent"]);
      expect(t.calls.filter((c) => c.method.startsWith("set"))).toEqual([]);
    }
    // Execution: a rate change, then an invalid lock value, keeps the rate's cause; the reverse keeps the lock's.
    for (const [notes, code] of [
      [[rate("96000"), lock("2")], "precondition_failed"],
      [[lock("2"), rate("96000")], "invalid_response"],
    ] as const) {
      const { result } = await apply((t) => t.script("getNumeric", read("0"), read("48000")).script("setNumeric", after(t, notes, accepted), accepted, accepted).script("setText", accepted, accepted, accepted));
      // The refused step reports the same first cause.
      expect([result.error, ...result.steps.map((s) => `${s.outcome} ${s.error}`)], JSON.stringify(notes)).toEqual([code, "accepted null", `not_sent ${code}`, "not_sent null"]);
    }
    // During the lock read, a lock before an invalid read value: the lock's cause stays, nothing is read or sent after.
    const reading = await apply((t) => t.script("getNumeric", after(t, [lock("1")], read("3"))));
    expect([reading.result.error, reading.t.calls.length]).toEqual(["precondition_failed", 1]);
    // During the rate read, an invalid lock value before a mismatched rate: the lock's cause stays.
    const early = await apply((t) => t.script("getNumeric", read("0"), after(t, [lock("2")], read("96000"))));
    expect(early.result.error).toBe("invalid_response");
    // A sent write rejected after a lock: the step keeps its rejection, the import the lock.
    const raced = await apply((t) => t.script("getNumeric", read("0"), read("48000")).script("setNumeric", accepted, after(t, [lock("1")], rejected), accepted).script("setText", accepted, accepted, accepted));
    expect([raced.result.error, ...raced.result.steps.map((s) => `${s.outcome} ${s.error}`)]).toEqual([
      "precondition_failed",
      "accepted null",
      "rejected device_rejected",
      "not_sent null",
    ]);
    // E3: a stop while the last write is in flight is the overall error, the write keeping its acceptance.
    const inFlight = await apply((t) => t.script("getNumeric", read("0"), read("48000")).script("setNumeric", accepted, accepted, after(t, [lock("1")], accepted)).script("setText", accepted, accepted, after(t, [lock("1")], accepted)));
    expect([inFlight.result.error, ...inFlight.result.steps.map((s) => s.outcome)]).toEqual(["precondition_failed", "accepted", "accepted", "accepted"]);
    for (const cause of ["interrupted", "connection_lost"] as const) {
      let context: OperationContext | undefined;
      const cancelling = (record: unknown) => ({
        then(resolve: (value: unknown) => void) {
          context?.cancel(cause);
          resolve(record);
        },
      });
      const t = new FakeTransport().script("getNumeric", read("0"), read("48000")).script("setNumeric", accepted, accepted, cancelling(accepted)).script("setText", accepted, accepted, cancelling(accepted));
      context = new OperationContext(t, "URX22");
      const guard = await ConsoleLockGuard.open(context);
      const result = await applyCurrent(context, head, { guard });
      await guard.release();
      expect([result.error, ...result.steps.map((s) => s.outcome)], cause).toEqual([cause, "accepted", "accepted", "accepted"]);
    }
    // A stop after every step settled (here, during the rate observation's release): the accepted import stays a
    // success; a dry run, whose result is settled only after the release, reports it before a release failure.
    const releasing = (t: FakeTransport, fail: boolean) => {
      t.onRelease = () => {
        t.onRelease = undefined;
        t.notify(lock("1"));
      };
      if (fail) t.releaseFailure = new OperationFailureError({ code: "connection_lost", phase: "response", progress: null });
    };
    const settled = await apply((t) => {
      t.script("getNumeric", read("0"), read("48000")).script("setNumeric", accepted, accepted, accepted).script("setText", accepted, accepted, accepted);
      releasing(t, false);
    });
    expect([settled.result.error, settled.result.cleanup, ...settled.result.steps.map((s) => s.outcome)]).toEqual([null, null, "accepted", "accepted", "accepted"]);
    for (const fail of [false, true]) {
      const dry = await apply((t) => {
        t.script("getNumeric", read("0"), read("48000"));
        releasing(t, fail);
      }, true);
      expect([dry.result.error, dry.result.cleanup], `release fails: ${fail}`).toEqual(["precondition_failed", fail ? "connection_lost" : null]);
    }
  });

  it("keep the first failure and every step's result when the rate observation's release fails", async () => {
    const plan = planCurrent(synthesize("URX22"), "URX22");
    const head = { ...plan, steps: plan.steps.filter((s) => s.planned !== null).slice(0, 2), omissions: [] };
    const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
    const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
    const rejected = { kind: "failure", failure: { kind: "cause", code: "device_rejected", phase: "response" }, evidence: { state: "rejected", responseCode: "9" } };
    const lost = new OperationFailureError({ code: "connection_lost", phase: "response", progress: null });
    const apply = async (build: (t: FakeTransport) => void, activation?: Error) => {
      const t = new FakeTransport();
      build(t);
      const context = new OperationContext(t, "URX22");
      const guard = await ConsoleLockGuard.open(context);
      t.activation = activation;
      t.releaseFailure = lost;
      try {
        return await applyCurrent(context, head, { guard });
      } finally {
        await guard.release().catch(() => undefined);
      }
    };
    const outcomes = (result: { error: string | null; cleanup: string | null; steps: readonly { outcome: string }[] }) => [
      result.error,
      result.cleanup,
      ...result.steps.map((s) => s.outcome),
    ];
    // The rate registration fails: its own cause stays, the failed release beside it.
    const activation = await apply((t) => t.script("getNumeric", read("0")), new OperationFailureError({ code: "device_rejected", phase: "response", progress: null }));
    expect(outcomes(activation)).toEqual(["device_rejected", "connection_lost", "not_sent", "not_sent"]);
    // The rate read fails.
    const readFails = await apply((t) => t.script("getNumeric", read("0"), { kind: "failure", failure: { kind: "cause", code: "response_timeout", phase: "response" }, evidence: { state: "unconfirmed" } }));
    expect(outcomes(readFails)).toEqual(["response_timeout", "connection_lost", "not_sent", "not_sent"]);
    // The second write is rejected: the accepted and rejected steps are still returned.
    const second = await apply((t) => t.script("getNumeric", read("0"), read("48000")).script("setNumeric", accepted, rejected).script("setText", accepted, rejected));
    expect(outcomes(second)).toEqual(["device_rejected", "connection_lost", "accepted", "rejected"]);
    // Every write accepted: the release is the first failure.
    const all = await apply((t) => t.script("getNumeric", read("0"), read("48000")).script("setNumeric", accepted, accepted).script("setText", accepted, accepted));
    expect(outcomes(all)).toEqual(["connection_lost", "connection_lost", "accepted", "accepted"]);
    // The observation's owner fails to finish: the results are still returned, the failure in cleanup.
    const finishing = async (build: (t: FakeTransport) => void) => {
      const t = new FakeTransport();
      build(t);
      const context = new OperationContext(t, "URX22");
      const guard = await ConsoleLockGuard.open(context);
      t.finishFailure = new Error("adapter failure");
      try {
        return await applyCurrent(context, head, { guard });
      } finally {
        await guard.release().catch(() => undefined);
      }
    };
    expect(outcomes(await finishing((t) => t.script("getNumeric", read("0"), read("48000")).script("setNumeric", accepted, accepted).script("setText", accepted, accepted)))).toEqual([
      "internal_error",
      "internal_error",
      "accepted",
      "accepted",
    ]);
    expect(outcomes(await finishing((t) => t.script("getNumeric", read("0"), read("48000")).script("setNumeric", accepted, rejected).script("setText", accepted, rejected)))).toEqual([
      "device_rejected",
      "internal_error",
      "accepted",
      "rejected",
    ]);
    // A released observation reports no cleanup failure.
    const t = new FakeTransport().script("getNumeric", read("0"), read("48000")).script("setNumeric", accepted, accepted).script("setText", accepted, accepted);
    const context = new OperationContext(t, "URX22");
    const guard = await ConsoleLockGuard.open(context);
    expect(outcomes(await applyCurrent(context, head, { guard }))).toEqual([null, null, "accepted", "accepted"]);
    await guard.release();
  });
});
