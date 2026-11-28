// Lifecycle outcome records (K37) and the discovery result (D14), validated
// at the adapter boundary like single-request records (K33/K34).

import type { LaterCause, OperationCause, OperationPhase } from "./failure.js";
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

/**
 * One discovered device (D14): exact identity and model, and the System
 * version when the discovery read metadata.
 */
export interface DiscoveredDevice {
  id: string;
  model: string;
  /**
   * Present only when metadata was read: the System version, or null when a
   * valid response reports none.
   */
  firmware?: string | null;
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

/** The phases a stage deadline's expiry can occur in (N2). */
const DEADLINE_PHASES: Readonly<Record<string, readonly string[]>> = {
  discovery_timeout: ["discovery"],
  connect_timeout: ["connect", "identity"],
};

function causeOf(value: unknown): { kind: "cause"; code: LifecycleCause; phase: LifecyclePhase } | undefined {
  if (!hasExactly(value, ["kind", "code", "phase"]) || value.kind !== "cause") {
    return undefined;
  }
  const { code, phase } = value;
  if (typeof code !== "string" || !CAUSES.includes(code) || typeof phase !== "string" || !PHASES.includes(phase)) {
    return undefined;
  }
  const phases = DEADLINE_PHASES[code];
  return phases === undefined || phases.includes(phase)
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

/** The lifecycle causes a shared operation reports as they are (E2); the rest are internal to it. */
const OPERATION_CAUSES: readonly string[] = [
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
];

/**
 * Where a cleanup's failure occurred, as an operation phase: a lifecycle
 * record names the lifecycle phase only, so the phase follows the cause as
 * K34 places it — causes before sending at admission, a send deadline, a lost
 * link or a teardown budget while sending, a verdict or its absence at the
 * response, and the remaining causes at delivery.
 */
function phaseOfCause(code: OperationCause): OperationPhase {
  switch (code) {
    case "invalid_input":
    case "precondition_failed":
    case "not_connected":
      return "admission";
    case "send_timeout":
    case "connection_lost":
    case "teardown_timeout":
      return "send";
    case "device_rejected":
    case "response_timeout":
    case "invalid_response":
      return "response";
    default:
      return "delivery";
  }
}

/**
 * The failure a failed subscription call's own cleanup settled, as the cause
 * that goes beside the call's failure (E3, `OperationFailure.later`): the
 * transport's release of what the call had registered, its automatic
 * unregistration of a registration the owner's cancellation stopped among
 * them. An adapter carries that cleanup as the call's `progress.cleanup`
 * (`TransportSubscription.activate`). None when the progress carries no
 * valid cleanup, or the cleanup failed nothing.
 */
export function cleanupFailureOf(progress: unknown): LaterCause | undefined {
  if (typeof progress !== "object" || progress === null || !("cleanup" in progress)) {
    return undefined;
  }
  const failure = cleanupOf(progress.cleanup)?.failure;
  if (failure == null) {
    return undefined;
  }
  const code = (OPERATION_CAUSES.includes(failure.code) ? failure.code : "internal_error") as OperationCause;
  return { code, phase: phaseOfCause(code) };
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

function deviceOf(value: unknown, metadata: boolean): DiscoveredDevice | undefined {
  if (!hasExactly(value, metadata ? ["id", "model", "firmware"] : ["id", "model"])) {
    return undefined;
  }
  const { id, model } = value;
  if (typeof id !== "string" || id === "" || typeof model !== "string" || model === "") {
    return undefined;
  }
  if (!metadata) {
    return { id, model };
  }
  const { firmware } = value;
  // A version is a nonempty string; its explicit absence is null (D14).
  if (firmware !== null && (typeof firmware !== "string" || firmware === "")) {
    return undefined;
  }
  return { id, model, firmware };
}

/**
 * A complete discovered device list (D14): every entry valid for whether
 * metadata was read, and each identity once, in the order received. A list
 * breaking either is invalid as a whole; there is no partial list.
 */
export function validateDeviceList(value: unknown, metadata: boolean): DiscoveredDevice[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const devices: DiscoveredDevice[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const device = deviceOf(entry, metadata);
    if (device === undefined || ids.has(device.id)) {
      return undefined;
    }
    ids.add(device.id);
    devices.push(device);
  }
  return devices;
}

/** The causes a discovery can fail with, all in its `discovery` phase. */
const DISCOVERY_CAUSES: readonly string[] = [
  "connection_failed",
  "connection_lost",
  "send_timeout",
  "response_timeout",
  "invalid_response",
  "identity_error",
  "discovery_timeout",
  "internal_error",
];

/**
 * A validated discovery outcome (K37 `discover`), for a discovery that read
 * metadata or not. A failure is in the `discovery` phase with a cause a
 * discovery has, and its cleanup is complete: it owns no connection.
 */
export function validateDiscovery(
  record: unknown,
  metadata: boolean,
): LifecycleOutcome<DiscoveredDevice[]> | undefined {
  const outcome = validateLifecycle(record, (value) => validateDeviceList(value, metadata));
  if (outcome === undefined || outcome.kind === "success") {
    return outcome;
  }
  const { failure, cleanup } = outcome;
  const possible =
    failure.phase === "discovery" &&
    (failure.kind === "cancelled" || DISCOVERY_CAUSES.includes(failure.code)) &&
    cleanup.state === "complete" &&
    cleanup.failure === null;
  return possible ? outcome : undefined;
}
