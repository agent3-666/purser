/** Credential-free, operator-requested public documentation reading.
 * Jina Reader wire contract: https://jina.ai/reader/
 * This path never loads a wallet, sends payment headers, or falls back to a paid route.
 */
import { createHash } from "node:crypto";
import { reviewPublicDocument } from "../delivery/public-document.js";

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
  criteriaVersion: "public-document-v2";
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

export async function readPublicDocumentation(need: PublicReadNeed): Promise<PublicReadResult> {
  const target = validatePublicReadNeed(need);
  const base = { at: new Date().toISOString(), criteriaVersion: "public-document-v2" as const,
    needId: need.id, purpose: need.purpose,
    targetUrl: target.href, provider: "jina_reader_no_credentials" as const,
    paymentEvidence: "not_observed" as const, newPayments: 0 as const };
  let responseStatus: number | undefined;
  try {
    const response = await fetch(`https://r.jina.ai/${target.href}`, {
      headers: { Accept: "text/markdown", "X-Return-Format": "markdown" },
      redirect: "error", signal: AbortSignal.timeout(25_000),
    });
    responseStatus = response.status;
    if (response.status === 402) return { ...base, status: 402, outcome: "held",
      reason: "paid_route_requires_separate_approval" };
    if (!response.ok) throw new Error(`reader_http_${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!/^(text\/plain|text\/markdown)(;|$)/i.test(type)) throw new Error("unexpected_content_type");
    if (!response.body) throw new Error("missing_response_body");
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > need.maxBytes) throw new Error("response_over_size_limit");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const body = Buffer.concat(chunks);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const { missingTerms, pass, sourceMatches, hasContentEnvelope } =
      reviewPublicDocument(text, target.href, need.requiredTerms, need.minBytes);
    return { ...base, status: response.status, bytes: size,
      bodySha256: createHash("sha256").update(body).digest("hex"), missingTerms, sourceMatches, hasContentEnvelope,
      contentText: pass ? text : undefined,
      outcome: pass ? "free_delivery_pass" : "held",
      reason: pass ? "free_route_satisfies_need" : "delivery_failed" };
  } catch (error) {
    // Do not persist upstream errors containing possible response bodies or request credentials.
    const message = error instanceof Error ? error.message : "";
    const safe = /^(reader_http_\d{3}|unexpected_content_type|missing_response_body|response_over_size_limit)$/.test(message);
    const failure = safe ? message : error instanceof Error &&
      ["TimeoutError", "AbortError"].includes(error.name) ? "reader_timeout_or_abort" : "reader_transport_or_decode_failed";
    return { ...base, status: responseStatus, outcome: "held", reason: "delivery_failed", failure };
  }
}
