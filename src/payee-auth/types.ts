/**
 * Payee Authorization: a seller's signed statement that a given address may receive payment for a
 * given resource, on a given chain, in a given asset, for a bounded time.
 *
 * It rides inside an x402 offer (`accepts[i].extra.payeeAuthorization`), so a buyer that ignores it
 * is unaffected. A buyer that checks it compares two channels that an attacker would have to
 * control at the same time: the payment response, and the seller's own domain.
 *
 * See spec/payee-authorization.md for the threat model.
 */

import type { Address, Hex } from "viem";

export const EIP712_DOMAIN = { name: "x402 Payee Authorization", version: "1" } as const;

export const EIP712_TYPES = {
  PayeeAuthorization: [
    { name: "sellerDomain", type: "string" },
    { name: "sellerId", type: "address" },
    { name: "network", type: "string" },
    { name: "asset", type: "address" },
    { name: "payTo", type: "address" },
    { name: "resourcePrefix", type: "string" },
    { name: "validAfter", type: "uint64" },
    { name: "validBefore", type: "uint64" },
    { name: "rotationSeq", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The signed message. `nonce` is zero for a long-lived address and random for a per-request one. */
export interface PayeeAuthorizationMessage {
  sellerDomain: string;
  sellerId: Address;
  network: string; // CAIP-2, e.g. "eip155:5042002"
  asset: Address;
  payTo: Address;
  resourcePrefix: string;
  validAfter: bigint;
  validBefore: bigint;
  rotationSeq: bigint;
  nonce: Hex;
}

export interface SignedPayeeAuthorization {
  message: PayeeAuthorizationMessage;
  signature: Hex;
}

/** Published by the seller at https://<domain>/.well-known/x402-payee.json */
export interface PayeeIdentityDocument {
  version: 1;
  sellerDomain: string;
  identities: Array<{
    address: Address;
    validAfter: number;
    validBefore: number;
    status: "active" | "revoked";
  }>;
}

/** The part of an x402 offer this protocol checks against. */
export interface OfferUnderCheck {
  resource: string; // full URL being paid for
  network: string;
  asset: Address;
  payTo: Address;
  amount: string;
  extra?: Record<string, unknown>;
}

export const ZERO_NONCE: Hex = `0x${"00".repeat(32)}`;

/**
 * Three outcomes, never "safe".
 *   confirmed:   every check passed against evidence from both channels
 *   unconfirmed: evidence is missing, so the seller's authorization could not be established
 *   rejected:    evidence exists and contradicts the offer
 */
export type Verdict = "confirmed" | "unconfirmed" | "rejected";

export type ReasonCode =
  | "no_authorization"
  | "malformed_authorization"
  | "bad_signature"
  | "identity_document_unreachable"
  | "malformed_identity_document"
  | "identity_not_published"
  | "identity_revoked"
  | "identity_not_yet_valid"
  | "identity_expired"
  | "domain_mismatch"
  | "resource_out_of_scope"
  | "offer_mismatch"
  | "not_yet_valid"
  | "expired"
  | "ephemeral_window_too_long"
  | "replay_stale_rotation"
  | "replay_nonce"
  | "equivocation";

export interface VerificationResult {
  verdict: Verdict;
  reasons: ReasonCode[];
  /** What the buyer's ledger should remember if the payment proceeds. */
  observation?: {
    key: string;
    rotationSeq: bigint;
    payTo: Address;
    nonce: Hex;
  };
}
