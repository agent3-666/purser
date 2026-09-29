/** Read-only x402 v2 HTTP quote ingestion. Never sends a payment signature. */
import { createHash } from "node:crypto";
import { getAddress, isAddress, type Address } from "viem";
import { verifyPayee, fetchIdentityOverHttps, type VerifyOptions } from "../payee-auth/verify.js";
import type { OfferUnderCheck, VerificationResult } from "../payee-auth/types.js";
import { PayeeLedger } from "../payee-auth/ledger.js";

export interface UnpaidRequest {
  url: string;
  method: "GET" | "POST";
  /** Pre-agreed task bytes; a POST probe must itself be safe without payment. */
  body?: string;
  headers?: Record<string, string>;
}

export interface RawUnpaid402 {
  observedAt: string;
  request: UnpaidRequest;
  status: 402;
  /** Preserve the exact public wire header for review before any payment. */
  paymentRequiredHeader: string;
  paymentRequiredSha256: string;
  responseBodySha256: string;
  responseBodyText: string;
}

export interface ObservedQuote extends RawUnpaid402 {
  offers: OfferUnderCheck[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parsePaymentRequired(header: string, requestedUrl: string): OfferUnderCheck[] {
  if (!header || header.length > 128_000 || !/^[A-Za-z0-9+/]+=*$/.test(header)) throw new Error("invalid PAYMENT-REQUIRED header");
  let root: Record<string, unknown> | null = null;
  try { root = object(JSON.parse(Buffer.from(header, "base64").toString("utf8"))); }
  catch { throw new Error("PAYMENT-REQUIRED is not base64 JSON"); }
  if (!root || root.x402Version !== 2) throw new Error("unsupported x402 version");
  const resource = object(root.resource);
  if (!resource || resource.url !== requestedUrl) throw new Error("402 resource URL differs from requested URL");
  if (!Array.isArray(root.accepts) || root.accepts.length === 0 || root.accepts.length > 64) throw new Error("invalid x402 accepts list");
  const offers: OfferUnderCheck[] = [];
  for (const raw of root.accepts) {
    const a = object(raw);
    const asset = a?.asset;
    const payTo = a?.payTo;
    if (!a || a.scheme !== "exact" || typeof a.network !== "string" || !/^eip155:\d+$/.test(a.network) ||
        typeof asset !== "string" || !isAddress(asset) || typeof payTo !== "string" || !isAddress(payTo) ||
        typeof a.amount !== "string" || !/^(0|[1-9]\d*)$/.test(a.amount)) continue;
    offers.push({ resource: requestedUrl, network: a.network, asset: getAddress(asset) as Address,
      payTo: getAddress(payTo) as Address, amount: a.amount, extra: object(a.extra) ?? undefined });
  }
  if (!offers.length) throw new Error("no supported exact EVM offer in 402");
  return offers;
}

export async function captureUnpaid402(request: UnpaidRequest): Promise<RawUnpaid402> {
  const parsed = new URL(request.url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
    throw new Error("unpaid quote URL must use HTTPS or local HTTP");
  }
  // This request is returned to callers and may be saved as research evidence.
  // Allow only public content-negotiation headers so credentials cannot leak into it.
  for (const name of Object.keys(request.headers ?? {})) {
    if (/^(payment-signature|x-payment|x-payment-signature)$/i.test(name)) {
      throw new Error("unpaid probe must not include a payment header");
    }
    if (!/^(accept|content-type|user-agent)$/i.test(name)) {
      throw new Error(`unpaid probe header is not safe to persist: ${name}`);
    }
  }
  const response = await fetch(parsed, {
    method: request.method,
    body: request.method === "POST" ? request.body : undefined,
    headers: request.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 402) throw new Error(`expected unpaid 402, got HTTP ${response.status}`);
  const header = response.headers.get("payment-required");
  if (!header) throw new Error("402 did not include canonical PAYMENT-REQUIRED header");
  if (header.length > 128_000) throw new Error("PAYMENT-REQUIRED header exceeds size limit");
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 128_000) { await reader.cancel(); throw new Error("402 response body exceeds size limit"); }
      chunks.push(next.value);
    }
  }
  const body = Buffer.concat(chunks);
  return { observedAt: new Date().toISOString(), request, status: 402,
    paymentRequiredHeader: header,
    paymentRequiredSha256: createHash("sha256").update(header).digest("hex"),
    responseBodySha256: createHash("sha256").update(body).digest("hex"),
    responseBodyText: new TextDecoder().decode(body) };
}

export async function fetchUnpaidQuote(request: UnpaidRequest): Promise<ObservedQuote> {
  const raw = await captureUnpaid402(request);
  return { ...raw, offers: parsePaymentRequired(raw.paymentRequiredHeader, new URL(request.url).href) };
}

/** The payee verdict comes from live verification, never from catalog metadata or a model. */
export async function verifyObservedQuote(
  quote: ObservedQuote,
  options: Partial<VerifyOptions> & Pick<VerifyOptions, "ledger"> = { ledger: new PayeeLedger(null) },
): Promise<Array<{ offer: OfferUnderCheck; verification: VerificationResult }>> {
  const results = [];
  for (const offer of quote.offers) {
    results.push({ offer, verification: await verifyPayee(offer, {
      ledger: options.ledger,
      fetchIdentity: options.fetchIdentity ?? fetchIdentityOverHttps,
      now: options.now,
      maxEphemeralWindowSeconds: options.maxEphemeralWindowSeconds,
    }) });
  }
  return results;
}
