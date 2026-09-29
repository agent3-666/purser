import assert from "node:assert/strict";
import { verifyDelivery, type DeliveryCriteria, type DeliveryObservation } from "../src/delivery/verify.js";

const criteria: DeliveryCriteria = {
  version: "search-v1-2026-09-29",
  expectedContentType: "application/json",
  minBytes: 12,
  maxBytes: 10_000,
  maxLatencyMs: 2_000,
  requiredJsonPaths: ["results.0.url"],
};
const body = (value: string) => new TextEncoder().encode(value);
const good: DeliveryObservation = {
  requestId: "local-example-1",
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: body('{"results":[{"url":"https://example.test"}]}'),
  startedAtMs: 1_000,
  completedAtMs: 1_500,
};

assert.equal(verifyDelivery(good, criteria).outcome, "objective_pass");
assert.equal(verifyDelivery(good, criteria).contentQualityUnverified, true);
assert.deepEqual(verifyDelivery({ ...good, status: 402 }, criteria).failures, ["http_status"]);
assert.deepEqual(verifyDelivery({ ...good, body: body('{"results":[]}') }, criteria).failures, ["required_path_missing"]);
assert.deepEqual(verifyDelivery({ ...good, body: body('{"results":[') }, criteria).failures, ["invalid_json"]);
assert.deepEqual(verifyDelivery({ ...good, completedAtMs: 4_000 }, criteria).failures, ["latency_exceeded"]);
assert.deepEqual(verifyDelivery({ ...good, completedAtMs: 500 }, criteria).failures, ["invalid_timing"]);
assert.deepEqual(verifyDelivery({ ...good, contentType: "text/html" }, criteria).failures, ["content_type"]);
console.log("PASS delivery: 7 objective checks; content quality remains unverified");
