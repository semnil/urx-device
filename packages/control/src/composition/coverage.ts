// CURRENT coverage and the fixed phase order (K36). Each phase lists its
// settings in their table or local-precedence order (F18-O); within a
// setting, targets follow the canonical order of targets.ts. A setting not
// listed in a phase is in EXCLUDED with its reason, so the two lists together
// cover the whole catalog.

import type { SettingId } from "../catalog/settings.js";

/** The phases 1…10; phase 0 is planning and its preconditions. */
export const PHASES: readonly { readonly phase: number; readonly settings: readonly SettingId[] }[] = [
  // Structural controls before the values they reset.
  { phase: 1, settings: ["channel.stereo-link", "channel.pan-mode", "bus.type", "bus.pan-link"] },
  // Input sources, then outputs: analog and USB, STREAMING and MONITOR, recorder tracks.
  { phase: 2, settings: ["channel.source", "output.source", "bus.source", "recorder.source"] },
  // F18-IN: phantom and HI-Z, then analog gain, then Clip Safe; then source gains once each.
  { phase: 3, settings: ["input.phantom", "input.hi-z", "input.gain", "input.clip-safe", "source.gain"] },
  {
    phase: 4,
    settings: [
      "channel.processing-mode",
      "channel.hpf.on",
      "channel.hpf.frequency",
      "channel.polarity",
      "channel.rec-point",
      "channel.gate.on",
      "channel.gate.threshold",
      "channel.gate.range",
      "channel.gate.attack",
      "channel.gate.hold",
      "channel.gate.decay",
      // Ordinary COMP (F18-O): 1-knob, Auto Makeup, level, then the manual settings.
      "channel.comp.on",
      "channel.comp.one-knob.on",
      "channel.comp.auto-makeup",
      "channel.comp.one-knob.level",
      "channel.comp.threshold",
      "channel.comp.ratio",
      "channel.comp.knee",
      "channel.comp.gain",
      "channel.comp.attack",
      "channel.comp.release",
      // Ordinary PEQ (F18-O): 1-knob, type, level, then the bands.
      "channel.eq.on",
      "channel.eq.one-knob.on",
      "channel.eq.one-knob.type",
      "channel.eq.one-knob.level",
      "channel.eq.band.on",
      "channel.eq.band.type",
      "channel.eq.band.q",
      "channel.eq.band.frequency",
      "channel.eq.band.gain",
      // SSMCS after the ordinary bank (F18-O): preset, Morphing, the rest.
      "channel.ssmcs.on",
      "channel.ssmcs.preset",
      "channel.ssmcs.morphing",
      "channel.ssmcs.comp.on",
      "channel.ssmcs.comp-drive",
      "channel.ssmcs.comp.attack",
      "channel.ssmcs.comp.release",
      "channel.ssmcs.comp.ratio",
      "channel.ssmcs.comp.knee",
      "channel.ssmcs.sidechain.on",
      "channel.ssmcs.sidechain.q",
      "channel.ssmcs.sidechain.frequency",
      "channel.ssmcs.sidechain.gain",
      "channel.ssmcs.eq.on",
      "channel.ssmcs.eq.band.on",
      "channel.ssmcs.eq.band.q",
      "channel.ssmcs.eq.band.frequency",
      "channel.ssmcs.eq.band.gain",
      "channel.ssmcs.output-gain",
      // DUCKER after the channel's other processing.
      "channel.ducker.on",
      "channel.ducker.key-source",
      "channel.ducker.threshold",
      "channel.ducker.range",
      "channel.ducker.attack",
      "channel.ducker.decay",
    ],
  },
  // F18-G: Type, overall On, PEQ (1-knob first), then GEQ.
  {
    phase: 5,
    settings: [
      "bus.eq.type",
      "bus.eq.on",
      "bus.peq.one-knob.on",
      "bus.peq.one-knob.type",
      "bus.peq.one-knob.level",
      "bus.peq.band.on",
      "bus.peq.band.type",
      "bus.peq.band.q",
      "bus.peq.band.frequency",
      "bus.peq.band.gain",
      "bus.geq.link",
      "bus.geq.on",
      "bus.geq.limit",
      "bus.geq.gain",
    ],
  },
  // Selectors, then (shared engine parameters, unbound until F06-P evidence), then On.
  { phase: 6, settings: ["channel.insert-fx.type", "bus.insert-fx.type", "channel.insert-fx.on", "bus.insert-fx.on"] },
  { phase: 7, settings: ["bus.fx.type", "bus.fx.parameter"] },
  {
    phase: 8,
    settings: [
      "channel.on",
      "channel.fader",
      "channel.pan",
      "bus.on",
      "bus.fader",
      "bus.balance",
      "bus.mono",
      "bus.cue-interrupt",
      "output.level",
      "bus.delay.on",
      "bus.delay.time",
      "bus.delay.frame-rate",
      "cue.mode",
    ],
  },
  // Per source and destination: tap, on, level, then pan (F18-PAN); then the STEREO assignments.
  { phase: 9, settings: ["send.tap", "send.on", "send.level", "send.pan", "channel.stereo-assign", "bus.stereo-assign"] },
  // Names and colors. The bus identity rows await the OV-BUS decision and are not composed yet.
  { phase: 10, settings: ["channel.name", "channel.color"] },
];

export type OmissionReason = "excluded_by_scope" | "not_writable" | "inactive_bank" | "device_controlled";

/** Settings outside CURRENT coverage (L3, L4, F12-I, F18 and runtime state), with the reason they are reported under. */
export const EXCLUDED: Readonly<Partial<Record<SettingId, OmissionReason>>> = {
  "input.clip-safe-active": "not_writable",
  "channel.cue": "excluded_by_scope",
  "bus.cue": "excluded_by_scope",
  "oscillator.on": "excluded_by_scope",
  "oscillator.mode": "excluded_by_scope",
  "oscillator.frequency": "excluded_by_scope",
  "oscillator.level": "excluded_by_scope",
  "oscillator.burst-width": "excluded_by_scope",
  "oscillator.burst-interval": "excluded_by_scope",
  "oscillator.assign": "excluded_by_scope",
  "device.brightness": "excluded_by_scope",
  "device.auto-power-off": "excluded_by_scope",
  "device.auto-power-off-time": "excluded_by_scope",
  "device.language": "excluded_by_scope",
  "device.usb-suppression": "excluded_by_scope",
  "device.date-format": "excluded_by_scope",
  "device.time-format": "excluded_by_scope",
  "device.time-zone-index": "excluded_by_scope",
  "device.hdmi-hdcp": "excluded_by_scope",
  "device.hdmi-input-channels": "excluded_by_scope",
  "device.sample-rate": "excluded_by_scope",
  "device.follow-usb": "excluded_by_scope",
  "device.console-lock": "excluded_by_scope",
  "knob.assignment": "excluded_by_scope",
  "knob.bank": "excluded_by_scope",
  "integration.active": "excluded_by_scope",
  "integration.post-fader-source": "excluded_by_scope",
  "panel.sends-target": "excluded_by_scope",
  "scene.current": "excluded_by_scope",
  "scene.cursor": "excluded_by_scope",
  "recorder.state": "excluded_by_scope",
  "recorder.card-present": "excluded_by_scope",
  "recorder.track-count": "excluded_by_scope",
};

/** Settings whose CURRENT handling awaits an open design decision (OV-BUS). */
export const PENDING: readonly SettingId[] = ["bus.name", "bus.color"];
