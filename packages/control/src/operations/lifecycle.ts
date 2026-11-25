// Lifecycle outcome records (K37) and the discovery result (D14), validated
// at the adapter boundary like single-request records (K33/K34).

import type { NativeRequestCause } from "./native.js";

export type LifecyclePhase = "discovery" | "connect" | "identity" | "admission" | "subscription" | "teardown";

/** E2 causes a lifecycle call can report: its own and its nested requests'. */
export type LifecycleCause =
  | NativeRequestCause
  | "device_not_found"
  | "identity_error"
  | "connection_failed"
  | "discovery_timeout"
  | "connect_timeout";

export type LifecycleFailure =
  | { kind: "cause"; code: LifecycleCause; phase: LifecyclePhase }
  | { kind: "cancelled"; phase: LifecyclePhase };

export type CleanupState = "complete" | "connection_closed" | "incomplete";

export interface Cleanup {
  state: CleanupState;
  /** One structured cleanup failure, never a list. */
  failure: { kind: "cause"; code: LifecycleCause; phase: LifecyclePhase } | null;
}

export type LifecycleOutcome<T> =
  | { kind: "success"; value: T }
  | { kind: "failure"; failure: LifecycleFailure; cleanup: Cleanup };

/** One discovered device (D14): exact identity, model and System version. */
export interface DiscoveredDevice {
  id: string;
  model: string;
  /** The System version, or null when a valid response reports none. */
  firmware: string | null;
}

const PHASES: readonly string[] = ["discovery", "connect", "identity", "admission", "subscription", "teardown"];
const CAUSES: readonly string[] = [
  "invalid_input",
  "precondition_failed",
  "not_connected",
  "send_timeout",
  "response_timeout",
  "teardown_timeout",
  "device_rejected",
  "invalid_response",
  "connection_lost",
  "notification_overflow",
  "internal_error",
  "device_not_found",
  "identity_error",
  "connection_failed",
  "discovery_timeout",
  "connect_timeout",
];
const CLEANUP_STATES: readonly string[] = ["complete", "connection_closed", "incomplete"];

type Fields = Readonly<Record<string, unknown>>;

function hasExactly(value: unknown, keys: readonly string[]): value is Fields {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function causeOf(value: unknown): { kind: "cause"; code: LifecycleCause; phase: LifecyclePhase } | undefined {
  if (!hasExactly(value, ["kind", "code", "phase"]) || value.kind !== "cause") {
    return undefined;
  }
  const { code, phase } = value;
  return typeof code === "string" && CAUSES.includes(code) && typeof phase === "string" && PHASES.includes(phase)
    ? { kind: "cause", code: code as LifecycleCause, phase: phase as LifecyclePhase }
    : undefined;
}

function failureOf(value: unknown): LifecycleFailure | undefined {
  if (hasExactly(value, ["kind", "phase"]) && value.kind === "cancelled") {
    const { phase } = value;
    return typeof phase === "string" && PHASES.includes(phase)
      ? { kind: "cancelled", phase: phase as LifecyclePhase }
      : undefined;
  }
  return causeOf(value);
}

function cleanupOf(value: unknown): Cleanup | undefined {
  if (!hasExactly(value, ["state", "failure"])) {
    return undefined;
  }
  const { state, failure } = value;
  if (typeof state !== "string" || !CLEANUP_STATES.includes(state)) {
    return undefined;
  }
  if (failure === null) {
    return { state: state as CleanupState, failure: null };
  }
  const cause = causeOf(failure);
  // A cleanup failure leaves the connection closed or unconfirmed, never complete.
  return cause !== undefined && state !== "complete" ? { state: state as CleanupState, failure: cause } : undefined;
}

/**
 * A validated lifecycle outcome, or undefined when the record is invalid. A
 * success's value goes through `value`.
 */
export function validateLifecycle<T>(
  record: unknown,
  value: (raw: unknown) => T | undefined,
): LifecycleOutcome<T> | undefined {
  if (hasExactly(record, ["kind", "value"]) && record.kind === "success") {
    const parsed = value(record.value);
    return parsed === undefined ? undefined : { kind: "success", value: parsed };
  }
  if (hasExactly(record, ["kind", "failure", "cleanup"]) && record.kind === "failure") {
    const failure = failureOf(record.failure);
    const cleanup = cleanupOf(record.cleanup);
    return failure === undefined || cleanup === undefined ? undefined : { kind: "failure", failure, cleanup };
  }
  return undefined;
}

function deviceOf(value: unknown): DiscoveredDevice | undefined {
  if (!hasExactly(value, ["id", "model", "firmware"])) {
    return undefined;
  }
  const { id, model, firmware } = value;
  if (typeof id !== "string" || id === "" || typeof model !== "string" || model === "") {
    return undefined;
  }
  if (firmware !== null && typeof firmware !== "string") {
    return undefined;
  }
  return { id, model, firmware };
}

/**
 * A complete discovered device list (D14): every entry valid, and each
 * identity once. A list breaking either is invalid as a whole; there is no
 * partial list.
 */
export function validateDeviceList(value: unknown): DiscoveredDevice[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const devices: DiscoveredDevice[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const device = deviceOf(entry);
    if (device === undefined || ids.has(device.id)) {
      return undefined;
    }
    ids.add(device.id);
    devices.push(device);
  }
  return devices;
}

/** A validated discovery outcome (K37 `discover`). */
export function validateDiscovery(record: unknown): LifecycleOutcome<DiscoveredDevice[]> | undefined {
  return validateLifecycle(record, validateDeviceList);
}
