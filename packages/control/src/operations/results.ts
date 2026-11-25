// Typed setting results (K3, K35): what reads, writes and previews return,
// and the progress a failed write keeps. No CLI envelope or terminal text.

import type { I64Text } from "../catalog/i64.js";

/** An observed value with its PC observation time, UTC ISO 8601 (O5). */
export interface Reading<V> {
  readonly value: V;
  readonly observedAt: string;
}

/** A planned single write (W2): what was asked and what will be sent. */
export interface WritePlan<V> {
  readonly requested: V;
  readonly planned: V;
}

/** A write the unit accepted (W1): acceptance, not readback. */
export interface WriteResult<V> extends WritePlan<V> {
  readonly outcome: "accepted";
}

/** How a failed write ended, from its request's evidence (K34, O11). */
export type WriteOutcome = "not_sent" | "uncertain" | "rejected" | "accepted";

/** The progress a failed write reports. */
export interface WriteProgress<V> extends WritePlan<V> {
  readonly outcome: WriteOutcome;
  /** The device's rejection code, for a rejected write. */
  readonly responseCode?: I64Text;
}
