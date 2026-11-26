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
  /** For a composite setting: its component writes in order, all `not_sent` in a plan (O11). */
  readonly steps?: readonly CompositeStep[];
}

/**
 * A prerequisite a dry run leaves unverified because an earlier unsent write
 * can change what it depends on (O13): the fixed K40 codes and F11-C-A's
 * `follow_usb_off`.
 */
export type UnverifiedCondition =
  | "file_rate_matches"
  | "insert_type_matches"
  | "insert_layout_compatible"
  | "fx_type_matches"
  | "revx_room_size"
  | "geq_type_selected"
  | "geq_limit_allows_gain"
  | "follow_usb_off";

/**
 * A dry run's plan (O13): the requested value, the value it would send, or
 * null where that needs a context an unsent write can change, and the
 * conditions left unverified, in check order.
 */
export interface DryRunPlan<V> {
  readonly requested: V;
  readonly planned: V | null;
  readonly unverified: readonly UnverifiedCondition[];
}

/** A dry run's plan with no earlier unsent write (O13): the value it would send, and nothing unverified. */
export interface VerifiedPlan<V> extends WritePlan<V> {
  readonly unverified: readonly UnverifiedCondition[];
}

/**
 * A composite read's failure (O12): the component whose request failed, or
 * null when the operation was stopped before or between component requests.
 * No component value is exposed.
 */
export interface CompositeReadProgress {
  readonly failedComponent: string | null;
}

/** One component write of a composite setting, in planned order (O11). */
export interface CompositeStep {
  readonly component: string;
  readonly requested: string;
  readonly planned: string;
  readonly outcome: WriteOutcome;
  readonly responseCode?: I64Text;
}

/** A write the unit accepted (W1): acceptance, not readback. */
export interface WriteResult<V> extends WritePlan<V> {
  readonly outcome: "accepted";
  /** For a composite setting, each component write in order (O11). */
  readonly steps?: readonly CompositeStep[];
}

/** How a failed write ended, from its request's evidence (K34, O11). */
export type WriteOutcome = "not_sent" | "uncertain" | "rejected" | "accepted";

/** The progress a failed write reports. */
export interface WriteProgress<V> extends WritePlan<V> {
  readonly outcome: WriteOutcome;
  /** The device's rejection code, for a rejected write. */
  readonly responseCode?: I64Text;
  /** For a composite setting: accepted steps kept, the failed one, later ones not sent (O11). */
  readonly steps?: readonly CompositeStep[];
}
