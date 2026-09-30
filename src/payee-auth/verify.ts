/**
 * Buyer side: decide whether the address in an x402 offer is one the seller authorized.
 *
 * The check compares two channels. The authorization arrives with the offer; the identity that must
 * have signed it is fetched separately from the seller's own domain. Rewriting the offer in transit,
 * or editing a directory listing, gives an attacker the first channel but not the second.
 *
 * Every rule carries a GUARD marker so scripts/mutation-check.ts can delete it and require the
 * experiment it exists for to change its outcome.
 */

import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { rotationKey } from "./key.js";
import {
  EIP712_DOMAIN,
  EIP712_TYPES,
  type OfferUnderCheck,
  type PayeeAuthorizationMessage,
  type PayeeIdentityDocument,
  type PayeeLedgerReader,
  type ReasonCode,
  type VerificationResult,
} from "./types.js";

export type IdentityFetcher = (domain: string) => Promise<PayeeIdentityDocument | null>;

export interface VerifyOptions {
  fetchIdentity: IdentityFetcher;
  ledger: PayeeLedgerReader;
  now?: number; // unix seconds
  /** Longest validity window accepted for a per-request (nonce-bearing) authorization. */
  maxEphemeralWindowSeconds?: number;
}

/** Default fetcher: the seller's own domain, over HTTPS, independently of the offer. */
export const fetchIdentityOverHttps: IdentityFetcher = async (domain) => {
  try {
    const res = await fetch(`https://${domain}/.well-known/x402-payee.json`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as PayeeIdentityDocument;
  } catch {
    return null;
  }
};

function decode(raw: unknown): { message: PayeeAuthorizationMessage; signature: Hex } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, string>;
  try {
    for (const f of ["sellerId", "asset", "payTo"]) if (!isAddress(r[f])) return null;
    return {
      message: {
        sellerDomain: String(r.sellerDomain),
        sellerId: getAddress(r.sellerId),
        network: String(r.network),
        asset: getAddress(r.asset),
        payTo: getAddress(r.payTo),
        resourcePrefix: String(r.resourcePrefix),
        validAfter: BigInt(r.validAfter),
        validBefore: BigInt(r.validBefore),
        rotationSeq: BigInt(r.rotationSeq),
        nonce: r.nonce as Hex,
      },
      signature: r.signature as Hex,
    };
  } catch {
    return null;
  }
}

function validIdentityDocument(value: unknown): value is PayeeIdentityDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  if (doc.version !== 1 || typeof doc.sellerDomain !== "string" || !Array.isArray(doc.identities)) return false;
  const seen = new Set<string>();
  for (const raw of doc.identities) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.address !== "string" || !isAddress(entry.address) ||
        typeof entry.validAfter !== "number" || !Number.isSafeInteger(entry.validAfter) ||
        typeof entry.validBefore !== "number" || !Number.isSafeInteger(entry.validBefore) ||
        entry.validAfter >= entry.validBefore ||
        (entry.status !== "active" && entry.status !== "revoked")) return false;
    const key = entry.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export async function verifyPayee(offer: OfferUnderCheck, opts: VerifyOptions): Promise<VerificationResult> {
  const now = BigInt(opts.now ?? Math.floor(Date.now() / 1000));
  const maxWindow = BigInt(opts.maxEphemeralWindowSeconds ?? 900);
  const hard: ReasonCode[] = [];
  const soft: ReasonCode[] = [];

  const raw = offer.extra?.payeeAuthorization;
  if (raw === undefined) {
    return { verdict: "unconfirmed", reasons: ["no_authorization"] };
  }
  const auth = decode(raw);
  if (!auth) return { verdict: "rejected", reasons: ["malformed_authorization"] };
  const m = auth.message;

  // R2. The signature must come from the identity the message names.
  let signer: Address | null = null;
  try {
    signer = await recoverTypedDataAddress({
      domain: EIP712_DOMAIN,
      types: EIP712_TYPES,
      primaryType: "PayeeAuthorization",
      message: m,
      signature: auth.signature,
    });
  } catch {
    signer = null;
  }
  let badSignature = false;
  badSignature = !signer || signer !== m.sellerId; // GUARD:signature-matches-seller-id
  if (badSignature) hard.push("bad_signature");

  // R4. The authorization is for the host actually being paid, and for this resource.
  let host = "";
  try {
    host = new URL(offer.resource).host.toLowerCase();
  } catch {
    host = "";
  }
  let wrongDomain = false;
  wrongDomain = m.sellerDomain.toLowerCase() !== host; // GUARD:domain-bound-to-resource-host
  if (wrongDomain) hard.push("domain_mismatch");
  let outOfScope = false;
  outOfScope = !offer.resource.startsWith(m.resourcePrefix); // GUARD:resource-within-prefix
  if (outOfScope) hard.push("resource_out_of_scope");

  // R5. It names exactly the chain, asset and address this offer asks us to pay.
  let mismatch = false;
  const sameTerms = m.network === offer.network && m.asset.toLowerCase() === offer.asset.toLowerCase() && m.payTo.toLowerCase() === offer.payTo.toLowerCase();
  mismatch = !sameTerms; // GUARD:offer-matches-authorization
  if (mismatch) hard.push("offer_mismatch");

  // R6. Inside its validity window.
  let notYet = false;
  notYet = now < m.validAfter; // GUARD:not-before
  if (notYet) hard.push("not_yet_valid");
  let expired = false;
  expired = now >= m.validBefore; // GUARD:not-after
  if (expired) hard.push("expired");

  // R3. The signer is published by the seller's own domain, fetched independently of the offer.
  const doc = await opts.fetchIdentity(host).catch(() => null);
  if (!doc) {
    soft.push("identity_document_unreachable");
  } else if (!validIdentityDocument(doc)) {
    hard.push("malformed_identity_document");
  } else {
    const entry = doc.identities.find((i) => i.address.toLowerCase() === m.sellerId.toLowerCase());
    const docForHost = doc.sellerDomain.toLowerCase() === host;
    let unpublished = false;
    unpublished = !entry || !docForHost; // GUARD:identity-published-by-domain
    if (unpublished) soft.push("identity_not_published");
    else if (entry) {
      if (entry.status === "revoked") hard.push("identity_revoked");
      if (now < BigInt(entry.validAfter)) hard.push("identity_not_yet_valid");
      if (now >= BigInt(entry.validBefore)) hard.push("identity_expired");
    }
  }

  // R7/R8. Change control: a rotation may only move forward, and a nonce may only be used once.
  const key = rotationKey(m.sellerId, m.network, m.asset);
  const ephemeral = !/^0x0+$/.test(m.nonce);
  if (ephemeral) {
    let reused = false;
    reused = opts.ledger.nonceSeen(m.sellerId, m.nonce); // GUARD:nonce-single-use
    if (reused) hard.push("replay_nonce");
    let tooLong = false;
    tooLong = m.validBefore - m.validAfter > maxWindow; // GUARD:ephemeral-window-bounded
    if (tooLong) hard.push("ephemeral_window_too_long");
  } else {
    const seen = opts.ledger.current(key);
    if (seen) {
      let stale = false;
      stale = m.rotationSeq < seen.rotationSeq; // GUARD:rotation-moves-forward
      if (stale) hard.push("replay_stale_rotation");
      let equivocates = false;
      equivocates = m.rotationSeq === seen.rotationSeq && m.payTo.toLowerCase() !== seen.payTo.toLowerCase(); // GUARD:no-equivocation
      if (equivocates) hard.push("equivocation");
    }
  }

  if (hard.length) return { verdict: "rejected", reasons: [...hard, ...soft] };
  if (soft.length) return { verdict: "unconfirmed", reasons: soft };
  return {
    verdict: "confirmed",
    reasons: [],
    observation: { key, rotationSeq: m.rotationSeq, payTo: m.payTo, nonce: m.nonce },
  };
}
