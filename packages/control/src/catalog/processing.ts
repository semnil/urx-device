// Channel processing switches and mode (F04-S): fixed addresses per bank,
// with per-setting switch polarity. No mode read selects an address.

/** Processing mode values in raw order: comp-eq 0, ssmcs 1 (ID 21, mono). */
export const PROCESSING_MODES = ["comp-eq", "ssmcs"] as const;

/** The processing switches: ID per channel kind and the raw value meaning on. */
export const PROCESSING_SWITCHES = {
  "hpf.on": { ids: { mono: 25 }, on: 1 },
  "gate.on": { ids: { mono: 28 }, on: 1 },
  "comp.on": { ids: { mono: 34 }, on: 1 },
  "eq.on": { ids: { mono: 44, stereo: 213 }, on: 1 },
  "ssmcs.on": { ids: { mono: 89 }, on: 1 },
  "ssmcs.comp.on": { ids: { mono: 94 }, on: 0 },
  "ssmcs.eq.on": { ids: { mono: 106 }, on: 0 },
} as const;

export const PROCESSING_MODE_ID = 21;
export const HPF_FREQUENCY_ID = 26;

/**
 * The HPF stops the control link writes, Hz: the R40 grades the router's
 * HPF_FREQ_STOPS_HZ holds inside its 40 … 120 Hz link window (the top one is
 * 118 Hz). Written out, not computed (F04-S).
 */
export const HPF_WRITE_STOPS_HZ = [
  40, 42.5, 45, 47.5, 50, 53, 56, 60, 63, 67, 71, 75, 80, 85, 90, 95, 100, 106, 112, 118,
] as const;
/** The write window, checked before rounding; and the raw read range, 0.1 Hz. */
export const HPF_WRITE_HZ = { min: 40, max: 120 } as const;
export const HPF_READ_RAW = { min: 200, max: 6000 } as const;
