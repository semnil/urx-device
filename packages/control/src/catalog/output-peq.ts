// Output PEQ rules (F07-P): the channel EQ's codecs on STEREO (anchor 498,
// y 0) and MIX 1/2 (anchor 591, representative y 0 or 2). Band i's base is
// anchor + 5 + 5i: on/type/Q/frequency/gain at base + 0…4; only low and high
// have a type. 1-knob On/Type/Level at anchor + 2/3/4. MIX writes have a
// partner instance (y + 1): they write the representative once on the
// models in PARTNER_FOLLOWS (F03-G) and stay unbound elsewhere; STEREO
// writes once.

import { BUS_TOKENS } from "./buses.js";
import { EQ_BANDS, EQ_BAND_FIELDS, EQ_ONE_KNOB_FIELDS, EQ_RULES } from "./eq.js";
import { frozen } from "./frozen.js";
import { PARTNER_FOLLOWS } from "./models.js";
import type { BusBandSettingRule, BusSettingRule } from "./rules.js";

const BUSES = {
  stereo: { anchor: 498, y: 0, write: true },
  "mix-1": { anchor: 591, y: 0, write: PARTNER_FOLLOWS },
  "mix-2": { anchor: 591, y: 2, write: PARTNER_FOLLOWS },
} as const;

function bandAddress(field: keyof typeof EQ_BAND_FIELDS, bands: readonly string[] = EQ_BANDS): BusBandSettingRule["address"] {
  return Object.fromEntries(
    Object.entries(BUSES).map(([bus, { anchor, y, write }]) => [
      bus,
      Object.fromEntries(
        bands.map((band) => [band, { paramId: anchor + 5 + 5 * EQ_BANDS.indexOf(band as (typeof EQ_BANDS)[number]) + EQ_BAND_FIELDS[field], y, write }]),
      ),
    ]),
  );
}

function oneKnobAddress(field: keyof typeof EQ_ONE_KNOB_FIELDS): BusSettingRule["address"] {
  return Object.fromEntries(
    Object.entries(BUSES).map(([bus, { anchor, y, write }]) => [bus, { paramId: anchor + EQ_ONE_KNOB_FIELDS[field], y, write }]),
  );
}

const band = (field: keyof typeof EQ_BAND_FIELDS, value: BusBandSettingRule["value"], bands?: readonly string[]): BusBandSettingRule => ({
  target: "bus-band",
  known: BUS_TOKENS,
  bands: EQ_BANDS,
  address: bandAddress(field, bands),
  value,
});

const oneKnob = (field: keyof typeof EQ_ONE_KNOB_FIELDS, value: BusSettingRule["value"]): BusSettingRule => ({
  target: "bus",
  known: BUS_TOKENS,
  address: oneKnobAddress(field),
  value,
});

const eq = EQ_RULES;

export const OUTPUT_PEQ_RULES = frozen({
  "bus.peq.band.on": band("on", eq["channel.eq.band.on"].value),
  "bus.peq.band.type": band("type", eq["channel.eq.band.type"].value, ["low", "high"]),
  "bus.peq.band.q": band("q", eq["channel.eq.band.q"].value),
  "bus.peq.band.frequency": band("frequency", eq["channel.eq.band.frequency"].value),
  "bus.peq.band.gain": band("gain", eq["channel.eq.band.gain"].value),
  "bus.peq.one-knob.on": oneKnob("on", eq["channel.eq.one-knob.on"].value),
  "bus.peq.one-knob.type": oneKnob("type", eq["channel.eq.one-knob.type"].value),
  "bus.peq.one-knob.level": oneKnob("level", eq["channel.eq.one-knob.level"].value),
} as const satisfies Record<string, BusBandSettingRule | BusSettingRule>);
