import assert from "node:assert/strict";
import { readPublicDocumentation, type ReadAttempt } from "../src/purchasing/public-web-read.js";
import { parseReadRetryAfter, validateReadPolicy, readPolicy } from "../src/purchasing/read-retry.js";
const need = { id: "retry_guard", purpose: "public documentation", url: "https://example.com/",
  allowedHosts: ["example.com"], requiredTerms: ["USDC"], minBytes: 4, maxBytes: 200 };
const good = "Title: Public documentation\nURL Source: https://example.com/\nMarkdown Content:\nUSDC documentation";
const original = globalThis.fetch;
let scenarios = 0;
async function sequence(statuses: number[], retryAfter?: string) {
  let calls = 0;
  const events: ReadAttempt[] = [];
  globalThis.fetch = async (_url, options) => {
    calls++;
    const headers = new Headers(options?.headers);
    for (const key of ["authorization", "payment-signature", "x-payment"]) assert.equal(headers.has(key), false);
    const status = statuses[Math.min(calls - 1, statuses.length - 1)];
    return new Response(status === 200 ? good : "failed", { status, headers: {
      "content-type": "text/plain", ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }) } });
  };
  const result = await readPublicDocumentation(need, { retryDelayMs: 0 }, (event) => events.push(event));
  assert.equal(result.attempts.length, calls); assert.deepEqual(result.attempts, events);
  assert.equal(result.newPayments, 0); scenarios++;
  return { result, calls };
}
try {
  for (const status of [500, 502, 503, 504]) {
    const { result, calls } = await sequence([status, 200]);
    assert.equal(calls, 2); assert.equal(result.outcome, "free_delivery_pass");
    assert.equal(result.attempts[0].failure, `reader_http_${status}`);
    assert.equal(result.attempts[0].retryScheduled, true);
  }
  assert.equal((await sequence([429, 200], "0")).result.outcome, "free_delivery_pass");
  for (const header of ["60", "invalid", "999999999999999999999999999999999999"]) {
    const { result, calls } = await sequence([429], header);
    assert.equal(calls, 1); assert.equal(result.stopReason, "retry_after_exceeds_budget");
  }
  for (const status of [400, 401, 402, 403, 404, 501]) {
    const { result, calls } = await sequence([status]);
    assert.equal(calls, 1); assert.equal(result.stopReason, "non_retryable");
  }
  const repeated = await sequence([503]);
  assert.equal(repeated.calls, 2); assert.equal(repeated.result.stopReason, "attempt_limit");
  let journalCalls = 0;
  globalThis.fetch = async () => { journalCalls++; return new Response("unavailable", { status: 503 }); };
  await assert.rejects(readPublicDocumentation(need, { retryDelayMs: 0 }, () => { throw new Error("journal unavailable"); }), /journal unavailable/);
  assert.equal(journalCalls, 1, "checkpoint failure must stop before the next request"); scenarios++;
  let calls = 0;
  globalThis.fetch = async () => { if (++calls === 1) throw Object.assign(new Error("private sentinel"), { cause: { code: "ECONNRESET" } });
    return new Response(good, { headers: { "content-type": "text/plain" } }); };
  const reset = await readPublicDocumentation(need, { retryDelayMs: 0 }); scenarios++;
  assert.equal(reset.outcome, "free_delivery_pass");
  assert.equal(reset.attempts[0].failure, "reader_transport_ECONNRESET");
  assert.equal(JSON.stringify(reset).includes("private sentinel"), false);
  globalThis.fetch = async () => new Response("invalid source", { headers: { "content-type": "text/plain" } });
  const invalid = await readPublicDocumentation(need); scenarios++;
  assert.equal(invalid.attempts.length, 1); assert.equal(invalid.stopReason, "non_retryable");
  for (const streaming of [false, true]) {
    globalThis.fetch = async () => streaming ? new Response(new ReadableStream(), { headers: { "content-type": "text/plain" } }) : new Promise<Response>(() => {});
    const started = performance.now();
    const hung = await readPublicDocumentation(need, { maxAttempts: 3, attemptTimeoutMs: 10, totalTimeoutMs: 20, retryDelayMs: 0 }); scenarios++;
    assert.equal(hung.outcome, "held"); assert.equal(hung.attempts.every((a) => a.failure === "reader_timeout"), true);
    assert.ok(performance.now() - started < 200, "fetch/body watchdog must enforce total deadline");
    assert.ok(hung.attempts.length <= 3);
  }
  assert.equal(parseReadRetryAfter("Thu, 01 Jan 1970 00:00:02 GMT", 1000), 1000);
  assert.equal(parseReadRetryAfter("-1"), Infinity);
  assert.throws(() => validateReadPolicy({ ...readPolicy, maxAttempts: 4 }));
  assert.throws(() => validateReadPolicy({ ...readPolicy, totalTimeoutMs: 60_001 }));
} finally { globalThis.fetch = original; }
console.log(`PASS bounded Reader retry: ${scenarios} scenarios, complete attempt events, fetch/body deadlines, header and policy guards`);
