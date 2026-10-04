/** Credential-free, operator-requested public documentation reading.
 * Jina Reader wire contract: https://jina.ai/reader/
 * This path never loads a wallet, sends payment headers, or falls back to a paid route.
 */
import { createHash } from "node:crypto";
import { reviewPublicDocument } from "../delivery/public-document.js";
import { decideReadRetry, parseReadRetryAfter, readPolicy, validateReadPolicy, type ReadPolicy } from "./read-retry.js";

export interface PublicReadNeed {
  id: string;
  purpose: string;
  url: string;
  allowedHosts: string[];
  requiredTerms: string[];
  minBytes: number;
  maxBytes: number;
}

export interface PublicReadResult {
  at: string;
  criteriaVersion: "public-document-v3";
  attempts: ReadAttempt[];
  stopReason?: string;
  nextAction?: string;
  needId: string;
  purpose: string;
  targetUrl: string;
  provider: "jina_reader_no_credentials";
  outcome: "free_delivery_pass" | "held";
  reason: "free_route_satisfies_need" | "paid_route_requires_separate_approval" | "delivery_failed";
  status?: number;
  bytes?: number;
  bodySha256?: string;
  missingTerms?: string[];
  sourceMatches?: boolean;
  hasContentEnvelope?: boolean;
  failure?: string;
  /** Deliverable for the caller, omitted from metrics and append-only task logs. */
  contentText?: string;
  paymentEvidence: "not_observed";
  newPayments: 0;
}

export function validatePublicReadNeed(need: PublicReadNeed): URL {
  const url = new URL(need.url);
  if (!need.id.trim() || !need.purpose.trim() || url.protocol !== "https:" || url.username || url.password ||
      url.port || url.search || url.hash || !need.allowedHosts.includes(url.hostname) ||
      !/^[a-z0-9.-]+$/i.test(url.hostname) || !/[a-z]/i.test(url.hostname) ||
      url.hostname === "localhost" || url.hostname.endsWith(".local") ||
      !Number.isSafeInteger(need.minBytes) || !Number.isSafeInteger(need.maxBytes) ||
      need.minBytes < 1 || need.maxBytes < need.minBytes || need.maxBytes > 1_000_000 ||
      !need.requiredTerms.length || need.requiredTerms.some((term) => !term.trim())) {
    throw new Error("invalid public documentation need");
  }
  return url;
}

export interface ReadAttempt {
  number: number; startedAt: string; elapsedMs: number; status?: number;
  outcome: "free_delivery_pass" | "held"; failure?: string;
  retryable: boolean; retryAfterMs?: number; retryScheduled: boolean; retryDelayMs: number;
}
type AttemptResult = Omit<PublicReadResult, "attempts"> & { retryable: boolean; retryAfterMs?: number };

export async function readPublicDocumentation(need: PublicReadNeed, overrides: Partial<ReadPolicy> = {},
  onAttempt?: (attempt: ReadAttempt) => void): Promise<PublicReadResult> {
  const target = validatePublicReadNeed(need);
  const policy = { ...readPolicy, ...overrides };
  validateReadPolicy(policy);
  const base = { at: new Date().toISOString(), criteriaVersion: "public-document-v3" as const,
    needId: need.id, purpose: need.purpose, targetUrl: target.href,
    provider: "jina_reader_no_credentials" as const, paymentEvidence: "not_observed" as const, newPayments: 0 as const };
  const started = performance.now();
  const attempts: ReadAttempt[] = [];
  let last: AttemptResult = { ...base, outcome: "held", reason: "delivery_failed", failure: "reader_total_timeout", retryable: false };
  let stopReason = "total_time_limit";
  async function runAttempt(signal: AbortSignal): Promise<AttemptResult> {
    let status: number | undefined;
    try {
      const response = await fetch(`https://r.jina.ai/${target.href}`, {
        headers: { Accept: "text/markdown", "X-Return-Format": "markdown" }, redirect: "error", signal,
      });
      status = response.status;
      if (!response.ok) {
        const retryAfterMs = parseReadRetryAfter(response.headers.get("retry-after"));
        // No credential or paid fallback is ever supplied, including on a 402.
        void response.body?.cancel().catch(() => undefined);
        return { ...base, status, outcome: "held",
          reason: status === 402 ? "paid_route_requires_separate_approval" : "delivery_failed",
          failure: `reader_http_${status}`, retryable: [408, 429, 500, 502, 503, 504].includes(status), retryAfterMs };
      }
      const type = response.headers.get("content-type") ?? "";
      if (!/^(text\/plain|text\/markdown)(;|$)/i.test(type)) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("unexpected_content_type");
      }
      if (!response.body) throw new Error("missing_response_body");
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          if (signal.aborted) throw signal.reason;
          const { done, value } = await reader.read();
          if (signal.aborted) throw signal.reason;
          if (done) break;
          size += value.length;
          if (size > need.maxBytes) throw new Error("response_over_size_limit");
          chunks.push(value);
        }
      } finally { signal.removeEventListener("abort", cancel); cancel(); }
      const body = Buffer.concat(chunks);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      const { missingTerms, pass, sourceMatches, hasContentEnvelope } = reviewPublicDocument(text, target.href, need.requiredTerms, need.minBytes);
      return { ...base, status, bytes: size, bodySha256: createHash("sha256").update(body).digest("hex"),
        missingTerms, sourceMatches, hasContentEnvelope, contentText: pass ? text : undefined,
        outcome: pass ? "free_delivery_pass" : "held", reason: pass ? "free_route_satisfies_need" : "delivery_failed",
        failure: pass ? undefined : "document_validation_failed", retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const structural = /^(unexpected_content_type|missing_response_body|response_over_size_limit)$/.test(message);
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
      const transport = ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
      const timeout = signal.aborted || error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      return { ...base, status, outcome: "held", reason: "delivery_failed",
        failure: structural ? message : timeout ? "reader_timeout" : transport ? `reader_transport_${code}` : "reader_transport_or_decode_failed",
        retryable: timeout || transport };
    }
  }
  for (let number = 1; number <= policy.maxAttempts; number++) {
    const remaining = policy.totalTimeoutMs - (performance.now() - started);
    if (remaining <= 0) break;
    const attemptStarted = performance.now();
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<AttemptResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new DOMException("reader deadline", "TimeoutError"));
        resolve({ ...base, outcome: "held", reason: "delivery_failed", failure: "reader_timeout", retryable: true });
      }, Math.min(policy.attemptTimeoutMs, remaining));
    });
    last = await Promise.race([runAttempt(controller.signal), timeout]);
    clearTimeout(timer);
    controller.abort();
    const decision = decideReadRetry({ retryable: last.retryable, attempt: number,
      remainingMs: policy.totalTimeoutMs - (performance.now() - started), retryAfterMs: last.retryAfterMs }, policy);
    attempts.push({ number, startedAt, elapsedMs: Math.round(performance.now() - attemptStarted), status: last.status,
      outcome: last.outcome, failure: last.failure, retryable: last.retryable,
      retryAfterMs: Number.isFinite(last.retryAfterMs) ? last.retryAfterMs : undefined,
      retryScheduled: decision.retry, retryDelayMs: decision.delayMs });
    onAttempt?.(attempts.at(-1)!);
    if (!decision.retry) { stopReason = last.outcome === "free_delivery_pass" ? "success" : decision.stopReason!; break; }
    await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
  }
  const { retryable: _retryable, retryAfterMs: _retryAfter, ...result } = last;
  return { ...result, attempts, stopReason, nextAction: result.outcome === "free_delivery_pass" ? "use_checked_document" :
    result.reason === "paid_route_requires_separate_approval" ? "stop_no_payment_authorization" :
    last.retryable ? "rerun_read_business_docs_later_with_same_bounds" : "inspect_request_or_delivery_before_rerunning" };
}
