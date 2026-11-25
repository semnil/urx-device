// Single-request native result records (K34, NATIVE-RESULTS.md) and their
// boundary validation. A record failing validation is never adopted: the
// adapter reports `internal_error` and keeps earlier trusted progress.

import { isI64Text, type I64Text } from "../catalog/i64.js";

export type NativeRequestPhase = "validation" | "admission" | "send" | "response" | "delivery";

export type NativeRequestCause =
  | "invalid_input"
  | "precondition_failed"
  | "not_connected"
  | "send_timeout"
  | "response_timeout"
  | "teardown_timeout"
  | "device_rejected"
  | "invalid_response"
  | "connection_lost"
  | "notification_overflow"
  | "internal_error";

export type NativeRequestFailure =
  | { kind: "cause"; code: NativeRequestCause; phase: NativeRequestPhase }
  | { kind: "cancelled"; phase: NativeRequestPhase };

export type PendingEvidence = { state: "not_sent" } | { state: "unconfirmed" };
export type RejectionEvidence = { state: "rejected"; responseCode: I64Text };
export type ReadEvidence = PendingEvidence | RejectionEvidence | { state: "read" };
export type PostEvidence = PendingEvidence | RejectionEvidence | { state: "accepted" };

export type NativeSuccess<T, E> = { kind: "success"; value: T; evidence: E };
export type NativeFailure<E> = { kind: "failure"; failure: NativeRequestFailure; evidence: E };

export type NativeReadResult<T> = NativeSuccess<T, { state: "read" }> | NativeFailure<ReadEvidence>;

export type NativeNameValue = { kind: "text"; value: string } | { kind: "integer"; value: I64Text };

export type NativeNumericReadResult = NativeReadResult<I64Text>;
export type NativeTextReadResult = NativeReadResult<string>;
export type NativeNameReadResult = NativeReadResult<NativeNameValue>;
export type NativePostResult = NativeSuccess<null, { state: "accepted" }> | NativeFailure<PostEvidence>;

const PHASES: readonly string[] = ["validation", "admission", "send", "response", "delivery"];
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
];
/** Causes a failure keeping `read` or `accepted` evidence may have (K34). */
const DELIVERY_CAUSES: readonly string[] = [
  "connection_lost",
  "notification_overflow",
  "invalid_response",
  "internal_error",
  "teardown_timeout",
];

type Record_ = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is an object with exactly `keys` as its own keys. */
function hasExactly(value: unknown, keys: readonly string[]): value is Record_ {
  if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function failureOf(value: unknown): NativeRequestFailure | undefined {
  if (hasExactly(value, ["kind", "code", "phase"]) && value.kind === "cause") {
    const { code, phase } = value;
    if (typeof code === "string" && CAUSES.includes(code) && typeof phase === "string" && PHASES.includes(phase)) {
      return { kind: "cause", code: code as NativeRequestCause, phase: phase as NativeRequestPhase };
    }
    return undefined;
  }
  if (hasExactly(value, ["kind", "phase"]) && value.kind === "cancelled") {
    const { phase } = value;
    if (typeof phase === "string" && PHASES.includes(phase)) {
      return { kind: "cancelled", phase: phase as NativeRequestPhase };
    }
  }
  return undefined;
}

type EvidenceState = "not_sent" | "unconfirmed" | "rejected" | "read" | "accepted";

function evidenceOf(
  value: unknown,
  established: "read" | "accepted",
): { state: EvidenceState; responseCode?: I64Text } | undefined {
  if (hasExactly(value, ["state", "responseCode"]) && value.state === "rejected") {
    const code = value.responseCode;
    // A rejection never carries the acceptance code.
    return isI64Text(code) && code !== "200" ? { state: "rejected", responseCode: code } : undefined;
  }
  if (hasExactly(value, ["state"])) {
    const { state } = value;
    if (state === "not_sent" || state === "unconfirmed") {
      return { state };
    }
    if (state === established) {
      return { state: established };
    }
  }
  return undefined;
}

/**
 * The cause/evidence constraints beyond the record shape (K34): established
 * evidence in a failure only at delivery with a delivery cause; cancellation
 * only with pending evidence; a rejection only as `device_rejected` at
 * response, and `device_rejected` only with a rejection.
 */
function consistent(failure: NativeRequestFailure, state: EvidenceState): boolean {
  if (failure.kind === "cancelled") {
    return state === "not_sent" || state === "unconfirmed";
  }
  if (state === "read" || state === "accepted") {
    return failure.phase === "delivery" && DELIVERY_CAUSES.includes(failure.code);
  }
  if (state === "rejected") {
    return failure.code === "device_rejected" && failure.phase === "response";
  }
  return failure.code !== "device_rejected";
}

function validate<T, E, S extends "read" | "accepted">(
  record: unknown,
  established: S,
  value: (raw: unknown) => T | undefined,
): NativeSuccess<T, { state: S }> | NativeFailure<E> | undefined {
  if (hasExactly(record, ["kind", "value", "evidence"]) && record.kind === "success") {
    const evidence = evidenceOf(record.evidence, established);
    const parsed = value(record.value);
    if (evidence?.state !== established || parsed === undefined) {
      return undefined;
    }
    return { kind: "success", value: parsed, evidence: { state: established } };
  }
  if (hasExactly(record, ["kind", "failure", "evidence"]) && record.kind === "failure") {
    const failure = failureOf(record.failure);
    const evidence = evidenceOf(record.evidence, established);
    if (failure === undefined || evidence === undefined || !consistent(failure, evidence.state)) {
      return undefined;
    }
    return { kind: "failure", failure, evidence: evidence as E };
  }
  return undefined;
}

/** A validated numeric read record, or undefined when the record is invalid. */
export function validateNumericRead(record: unknown): NativeNumericReadResult | undefined {
  return validate<I64Text, ReadEvidence, "read">(record, "read", (raw) => (isI64Text(raw) ? raw : undefined));
}

/** A validated text read record: a genuine string, digits included. */
export function validateTextRead(record: unknown): NativeTextReadResult | undefined {
  return validate<string, ReadEvidence, "read">(record, "read", (raw) => (typeof raw === "string" ? raw : undefined));
}

/** A validated name read record, keeping the wire's text/integer variant. */
export function validateNameRead(record: unknown): NativeNameReadResult | undefined {
  return validate<NativeNameValue, ReadEvidence, "read">(record, "read", (raw) => {
    if (!hasExactly(raw, ["kind", "value"])) {
      return undefined;
    }
    if (raw.kind === "text" && typeof raw.value === "string") {
      return { kind: "text", value: raw.value };
    }
    if (raw.kind === "integer" && isI64Text(raw.value)) {
      return { kind: "integer", value: raw.value };
    }
    return undefined;
  });
}

/** A validated setting-write record: success carries no value. */
export function validatePost(record: unknown): NativePostResult | undefined {
  return validate<null, PostEvidence, "accepted">(record, "accepted", (raw) => (raw === null ? null : undefined));
}
