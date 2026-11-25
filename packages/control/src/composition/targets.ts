// Every target a setting has on a model, in canonical order (K36): channels
// by C12 number, buses STEREO, MIX 1/2, FX 1/2, STREAMING, MONITOR 1/2, then
// outputs; bands, jacks, tracks ascending; left before right. Enumerated from
// the catalog rules, never from the device or the file.

import { MONO_CHANNELS, STEREO_CHANNELS } from "../catalog/channels.js";
import type { Model } from "../catalog/models.js";
import type { SettingRule } from "../catalog/rules.js";

const SIDES = ["left", "right"] as const;

/** The model's channels by C12 number, with their kind. */
function channels(model: Model): { channel: number; kind: "mono" | "stereo" }[] {
  return [
    ...MONO_CHANNELS[model].map((channel) => ({ channel, kind: "mono" as const })),
    ...STEREO_CHANNELS[model].map((channel) => ({ channel, kind: "stereo" as const })),
  ].sort((a, b) => a.channel - b.channel);
}

/** The bus tokens of a rule, in the canonical bus order (the rule's own list order). */
const buses = (known: readonly string[], has: (bus: string) => boolean) => known.filter(has);

/** The targets `rule` addresses on `model`; empty when the model lacks the setting. */
export function targetsOf(rule: SettingRule, model: Model): object[] {
  switch (rule.target) {
    case "channel":
      return channels(model)
        .filter(({ kind }) => rule.address[kind] !== undefined && (rule.value.kind !== "by-kind" || rule.value.rules[kind] !== undefined))
        .map(({ channel }) => ({ channel }));
    case "channel-band":
      return channels(model).flatMap(({ channel, kind }) =>
        rule.bands.filter((band) => rule.address[band]?.[kind] !== undefined).map((band) => ({ channel, band })),
      );
    case "channel-side":
      return channels(model).flatMap(({ channel, kind }) => (kind === "mono" ? [{ channel }] : SIDES.map((side) => ({ channel, side }))));
    case "pair":
      return (rule.primaries[model] ?? []).map((channel) => ({ channel }));
    case "input": {
      const only = rule.only?.[model];
      return (rule.jacks[model] ?? []).filter((input) => only === undefined || only.includes(input)).map((input) => ({ input }));
    }
    case "source":
      return Object.entries(rule.sources)
        .filter(([, entry]) => entry?.models.includes(model) === true)
        .map(([source]) => ({ source }));
    case "send": {
      const sources = [
        ...channels(model).map(({ channel, kind }) => ({ source: `channel-${channel}`, from: kind })),
        { source: "fx-1", from: "fx" as const },
        { source: "fx-2", from: "fx" as const },
      ];
      const destinations = [
        { destination: "mix-1", to: "mix" as const },
        { destination: "mix-2", to: "mix" as const },
        { destination: "fx-1", to: "fx" as const },
        { destination: "fx-2", to: "fx" as const },
      ];
      return sources.flatMap(({ source, from }) =>
        destinations
          .filter(({ to }) => rule.routes.some((route) => route.from === from && route.to === to))
          .map(({ destination }) => ({ source, destination })),
      );
    }
    case "bus":
      return buses(rule.known, (bus) => rule.address[bus] !== undefined).map((bus) => ({ bus }));
    case "bus-side":
      return buses(rule.known, (bus) => rule.address[bus] !== undefined).flatMap((bus) =>
        rule.address[bus]?.sideless === true ? [{ bus }] : SIDES.map((side) => ({ bus, side })),
      );
    case "bus-band":
      return buses(rule.known, (bus) => rule.address[bus] !== undefined).flatMap((bus) =>
        rule.bands.filter((band) => rule.address[bus]?.[band] !== undefined).map((band) => ({ bus, band })),
      );
    case "bus-side-band":
      return buses(rule.known, (bus) => rule.address[bus] !== undefined).flatMap((bus) =>
        SIDES.flatMap((side) => rule.bands.map((band) => ({ bus, side, band }))),
      );
    case "output":
      return rule.known.filter((output) => rule.address[output] !== undefined).map((output) => ({ output }));
    case "output-side":
      return rule.known
        .filter((output) => rule.address[output]?.models.includes(model) === true)
        .flatMap((output) => SIDES.map((side) => ({ output, side })));
    case "device":
      return rule.models === undefined || rule.models.includes(model) ? [{}] : [];
    case "track":
      return rule.models.includes(model) ? Array.from({ length: rule.tracks }, (_, index) => ({ track: index + 1 })) : [];
    case "knob":
      return Array.from({ length: rule.banks }, (_, bank) => rule.knobs.map((knob) => ({ bank: bank + 1, knob }))).flat();
    case "fx-parameter":
      // Resolved from the file's selected effect per FX bus (F06-F, F18-R), not enumerated here.
      return [];
  }
}
