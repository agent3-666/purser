/** Objective checks for a paid HTTP response. Content usefulness needs separate review. */
import { createHash } from "node:crypto";

export interface DeliveryCriteria {
  version: string;
  expectedContentType: string;
  minBytes: number;
  maxBytes: number;
  maxLatencyMs: number;
  /** Dot-separated object paths. An array index is a decimal segment. */
  requiredJsonPaths?: string[];
}

export interface DeliveryObservation {
  requestId: string;
  status: number;
  contentType: string | null;
  body: Uint8Array;
  startedAtMs: number;
  completedAtMs: number;
}

export type DeliveryFailure =
  | "http_status"
  | "content_type"
  | "body_too_small"
  | "body_too_large"
  | "latency_exceeded"
  | "invalid_timing"
  | "invalid_json"
  | "required_path_missing";

export interface DeliveryResult {
  requestId: string;
  criteriaVersion: string;
  outcome: "objective_pass" | "objective_fail";
  failures: DeliveryFailure[];
  byteLength: number;
  latencyMs: number | null;
  sha256: string;
  /** True only when a separate semantic or human review is still needed. */
  contentQualityUnverified: true;
}

function presentAtPath(value: unknown, path: string): boolean {
  if (!path || path.split(".").some((part) => !part || part === "__proto__" || part === "constructor")) return false;
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, part)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return current !== null && current !== undefined && current !== "";
}

export function verifyDelivery(observed: DeliveryObservation, criteria: DeliveryCriteria): DeliveryResult {
  if (!criteria.version || !criteria.expectedContentType ||
      !Number.isSafeInteger(criteria.minBytes) || !Number.isSafeInteger(criteria.maxBytes) ||
      !Number.isSafeInteger(criteria.maxLatencyMs) || criteria.minBytes < 0 ||
      criteria.maxBytes < criteria.minBytes || criteria.maxLatencyMs < 0) {
    throw new Error("invalid delivery criteria");
  }
  const failures: DeliveryFailure[] = [];
  const add = (failure: DeliveryFailure) => { if (!failures.includes(failure)) failures.push(failure); };
  const size = observed.body.byteLength;
  const latency = observed.completedAtMs - observed.startedAtMs;
  const timingValid = Number.isFinite(latency) && latency >= 0;
  if (!Number.isInteger(observed.status) || observed.status < 200 || observed.status >= 300) add("http_status");
  const actualType = observed.contentType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (actualType !== criteria.expectedContentType.toLowerCase()) add("content_type");
  if (size < criteria.minBytes) add("body_too_small");
  if (size > criteria.maxBytes) add("body_too_large");
  if (!timingValid) add("invalid_timing");
  else if (latency > criteria.maxLatencyMs) add("latency_exceeded");

  if (criteria.requiredJsonPaths?.length) {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(observed.body)); }
    catch { add("invalid_json"); }
    if (!failures.includes("invalid_json") && criteria.requiredJsonPaths.some((path) => !presentAtPath(parsed, path))) {
      add("required_path_missing");
    }
  }
  return {
    requestId: observed.requestId,
    criteriaVersion: criteria.version,
    outcome: failures.length ? "objective_fail" : "objective_pass",
    failures,
    byteLength: size,
    latencyMs: timingValid ? latency : null,
    sha256: createHash("sha256").update(observed.body).digest("hex"),
    contentQualityUnverified: true,
  };
}
