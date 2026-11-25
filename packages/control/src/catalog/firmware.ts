// Firmware validation facts (D15): keyed by model and exact reported System
// version. No order, prefix or cross-model inference. The entries require
// hardware evidence (V-HW) and are empty until it exists.

import { frozen } from "./frozen.js";
import type { Model } from "./models.js";

/** System versions validated per model; exact strings only. */
export const validatedFirmware: Readonly<Record<Model, readonly string[]>> = frozen({
  URX22: [],
  URX44: [],
  URX44V: [],
});

export type FirmwareStatus = "validated" | "unverified";

/**
 * Whether `version` is validated for `model`. An explicitly absent version
 * (`null`) is unverified, never validated.
 */
export function firmwareStatus(model: Model, version: string | null): FirmwareStatus {
  return version !== null && validatedFirmware[model].includes(version) ? "validated" : "unverified";
}
