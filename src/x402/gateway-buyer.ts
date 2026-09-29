/** A single-attempt Arc testnet x402 Gateway buyer. No deposit, fallback or automatic retry. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { getAddress, type Address } from "viem";
import type { LocalAccount } from "viem/accounts";
import { captureUnpaid402, parsePaymentRequired, verifyObservedQuote, type ObservedQuote } from "./quote.js";
import { PayeeLedger } from "../payee-auth/ledger.js";
import type { VerifyOptions } from "../payee-auth/verify.js";

const NETWORK = "eip155:5042002";
const ASSET = "0x3600000000000000000000000000000000000000";
const GATEWAY = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const MAX_AUTH_SECONDS = 7 * 24 * 60 * 60 + 100;
type State = "reserved" | "signed" | "sent_unknown" | "server_ack_unverified";
interface Journal { version: 1; orderId: string; day: string; amount: string; requestSha256: string; quoteSha256: string;
  state: State; paymentHeader?: string; responseStatus?: number; settlement?: unknown; }
export interface ApprovedGatewayOrder {
  orderId: string;
  quote: ObservedQuote;
  /** Sha256 of the exact quote header approved by the caller. */
  approvedQuoteSha256: string;
  /** Sha256 of JSON.stringify(quote.request), including method, body and public headers. */
  approvedRequestSha256: string;
  /** The exact payee and maximum amount approved by the caller. */
  approvedPayTo: Address;
  maxAtomicAmount: bigint;
  dailyAtomicLimit: bigint;
  /** Lifetime cap for every recorded attempt, including unknown outcomes. */
  totalAtomicLimit: bigint;
  journalDir: string;
  signer: LocalAccount;
  payeeVerification: Partial<VerifyOptions> & Pick<VerifyOptions, "ledger">;
}
export interface GatewayAttempt { state: "server_ack_unverified" | "sent_unknown"; status: number; settlement?: unknown;
  bodySha256: string; bodyText: string; }

function sha256(input: string): string { return createHash("sha256").update(input).digest("hex"); }
function save(path: string, journal: Journal): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Gateway quote object");
  return value as Record<string, unknown>;
}

export async function buyGatewayOnce(order: ApprovedGatewayOrder): Promise<GatewayAttempt> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(order.orderId)) throw new Error("invalid order ID");
  if (order.maxAtomicAmount <= 0n || order.dailyAtomicLimit <= 0n || order.totalAtomicLimit <= 0n) throw new Error("invalid budget");
  if (!order.payeeVerification.ledger.isPersistent) throw new Error("Gateway buyer requires a persistent payee ledger");
  const quote = order.quote;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Math.floor(Date.parse(quote.observedAt) / 1000)) > 60) throw new Error("quote is stale");
  if (sha256(quote.paymentRequiredHeader) !== quote.paymentRequiredSha256 ||
      quote.paymentRequiredSha256 !== order.approvedQuoteSha256) throw new Error("quote changed since approval");
  const request = quote.request;
  const url = new URL(request.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("buyer URL must use HTTPS or local HTTP");
  }
  if (sha256(JSON.stringify(request)) !== order.approvedRequestSha256) throw new Error("request changed since approval");
  if (request.method !== "GET" && request.method !== "POST") throw new Error("unsupported method");
  if (Object.keys(request.headers ?? {}).some((name) => !/^(accept|content-type|user-agent)$/i.test(name))) {
    throw new Error("paid request contains a sensitive or unsupported header");
  }
  const fresh = await captureUnpaid402(request);
  if (fresh.paymentRequiredSha256 !== quote.paymentRequiredSha256) throw new Error("live 402 changed since approval");
  // Reparse raw wire bytes; do not trust editable derived offers from a model or caller.
  const parsedOffers = parsePaymentRequired(quote.paymentRequiredHeader, request.url);
  const root = asObject(JSON.parse(Buffer.from(quote.paymentRequiredHeader, "base64").toString("utf8")));
  const accepts = root.accepts as unknown[];
  const candidates = accepts.map(asObject).filter((a) => a.network === NETWORK && a.scheme === "exact" &&
    typeof a.asset === "string" && getAddress(a.asset) === getAddress(ASSET) &&
    typeof a.payTo === "string" && getAddress(a.payTo) === getAddress(order.approvedPayTo) &&
    typeof a.amount === "string" && /^\d+$/.test(a.amount) && BigInt(a.amount) > 0n &&
    BigInt(a.amount) <= order.maxAtomicAmount && BigInt(a.amount) <= order.dailyAtomicLimit &&
    Number.isSafeInteger(a.maxTimeoutSeconds) && (a.maxTimeoutSeconds as number) > 0 &&
    (a.maxTimeoutSeconds as number) <= MAX_AUTH_SECONDS &&
    asObject(a.extra).name === "GatewayWalletBatched" && asObject(a.extra).version === "1" &&
    typeof asObject(a.extra).verifyingContract === "string" &&
    getAddress(asObject(a.extra).verifyingContract as string) === getAddress(GATEWAY));
  if (candidates.length !== 1) throw new Error("expected exactly one approved Arc Gateway offer");
  const selected = candidates[0];
  const offer = parsedOffers.find((o) => o.network === selected.network && o.amount === selected.amount &&
    o.payTo === getAddress(selected.payTo as string) && o.asset === getAddress(selected.asset as string));
  if (!offer) throw new Error("selected offer not in parsed quote");
  // The purchaser cannot supply a historical verifier clock to revive an expired identity.
  const checked = await verifyObservedQuote({ ...quote, offers: [offer] }, { ...order.payeeVerification, now });
  if (checked[0]?.verification.verdict !== "confirmed") throw new Error("payee authorization is not confirmed");

  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const requestSha256 = sha256(JSON.stringify(request));
  mkdirSync(order.journalDir, { recursive: true, mode: 0o700 });
  const lock = join(order.journalDir, ".buyer-lock");
  mkdirSync(lock); // An abandoned lock fails closed; an operator must reconcile it.
  const journalPath = join(order.journalDir, `order-${order.orderId}.json`);
  const amount = BigInt(selected.amount as string);
  try {
    if (existsSync(journalPath)) throw new Error("order already attempted; reconcile before any new signature");
    let used = 0n, totalUsed = 0n;
    for (const file of readdirSync(order.journalDir).filter((f) => /^order-.*\.json$/.test(f))) {
      const prior = JSON.parse(readFileSync(join(order.journalDir, file), "utf8")) as Journal;
      if (prior.version !== 1) throw new Error("unreadable budget journal");
      if (prior.requestSha256 === requestSha256) throw new Error("same business request already attempted under another order");
      totalUsed += BigInt(prior.amount);
      if (prior.day === day) used += BigInt(prior.amount); // unknown attempts remain reserved
    }
    if (used + amount > order.dailyAtomicLimit) throw new Error("daily budget exceeded");
    if (totalUsed + amount > order.totalAtomicLimit) throw new Error("lifetime budget exceeded");
    let journal: Journal = { version: 1, orderId: order.orderId, day, amount: amount.toString(),
      requestSha256, quoteSha256: quote.paymentRequiredSha256, state: "reserved" };
    save(journalPath, journal); // reserve before any signature; crash means no automatic retry
    const observation = checked[0].verification.observation;
    const signedAuth = asObject(asObject(offer.extra).payeeAuthorization);
    if (!observation || typeof signedAuth.sellerId !== "string") throw new Error("confirmed authorization lacked ledger observation");
    order.payeeVerification.ledger.commit(observation, getAddress(signedAuth.sellerId));
    const scheme = new BatchEvmScheme(order.signer);
    const payload = await scheme.createPaymentPayload(2, selected as unknown as Parameters<typeof scheme.createPaymentPayload>[1]);
    const paymentHeader = Buffer.from(JSON.stringify({ ...payload, resource: root.resource, accepted: selected })).toString("base64");
    journal = { ...journal, state: "signed", paymentHeader };
    save(journalPath, journal); // persist the exact authorization, never re-sign this order
    let response: Response;
    try {
      response = await fetch(request.url, { method: request.method, body: request.method === "POST" ? request.body : undefined,
        headers: { ...request.headers, "Payment-Signature": paymentHeader }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    } catch {
      save(journalPath, { ...journal, state: "sent_unknown" });
      throw new Error("paid request outcome unknown; inspect journal and seller before any new order");
    }
    let responseBody: string;
    try {
      responseBody = await response.text();
      if (responseBody.length > 128_000) throw new Error("paid response exceeds limit");
    } catch {
      save(journalPath, { ...journal, state: "sent_unknown", responseStatus: response.status });
      throw new Error("paid response unreadable; outcome unknown");
    }
    const settlementHeader = response.headers.get("payment-response");
    let settlement: unknown;
    try { settlement = settlementHeader ? JSON.parse(Buffer.from(settlementHeader, "base64").toString("utf8")) : undefined; }
    catch { settlement = undefined; }
    const settlementObject = asObjectOrNull(settlement);
    const confirmed = response.ok && settlementObject?.success === true && settlementObject.network === NETWORK &&
      typeof settlementObject.transaction === "string" && settlementObject.transaction.length > 0;
    journal = { ...journal, state: confirmed ? "server_ack_unverified" : "sent_unknown", responseStatus: response.status, settlement };
    save(journalPath, journal);
    return { state: confirmed ? "server_ack_unverified" : "sent_unknown", status: response.status,
      settlement, bodySha256: sha256(responseBody), bodyText: responseBody };
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
function asObjectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
