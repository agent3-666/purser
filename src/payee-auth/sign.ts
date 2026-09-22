/** Seller side: sign an authorization for one payout address, and publish the identity document. */

import type { Address, Hex, LocalAccount } from "viem";
import { toHex } from "viem";
import { randomBytes } from "node:crypto";
import {
  EIP712_DOMAIN,
  EIP712_TYPES,
  type PayeeAuthorizationMessage,
  type PayeeIdentityDocument,
  type SignedPayeeAuthorization,
  ZERO_NONCE,
} from "./types.js";

export interface AuthorizationInput {
  sellerDomain: string;
  network: string;
  asset: Address;
  payTo: Address;
  resourcePrefix: string;
  validAfter: number;
  validBefore: number;
  rotationSeq: number;
  /** Per-request addresses get a random nonce and a short window; long-lived ones use zero. */
  ephemeral?: boolean;
}

export async function signPayeeAuthorization(
  identity: LocalAccount,
  input: AuthorizationInput,
): Promise<SignedPayeeAuthorization> {
  const message: PayeeAuthorizationMessage = {
    sellerDomain: input.sellerDomain,
    sellerId: identity.address,
    network: input.network,
    asset: input.asset,
    payTo: input.payTo,
    resourcePrefix: input.resourcePrefix,
    validAfter: BigInt(input.validAfter),
    validBefore: BigInt(input.validBefore),
    rotationSeq: BigInt(input.rotationSeq),
    nonce: input.ephemeral ? (toHex(randomBytes(32)) as Hex) : ZERO_NONCE,
  };
  const signature = await identity.signTypedData({
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "PayeeAuthorization",
    message,
  });
  return { message, signature };
}

export function identityDocument(
  sellerDomain: string,
  identities: PayeeIdentityDocument["identities"],
): PayeeIdentityDocument {
  return { version: 1, sellerDomain, identities };
}

/** JSON-safe form, so it can sit inside an x402 `extra` field. */
export function encodeAuthorization(auth: SignedPayeeAuthorization): Record<string, string> {
  const m = auth.message;
  return {
    sellerDomain: m.sellerDomain,
    sellerId: m.sellerId,
    network: m.network,
    asset: m.asset,
    payTo: m.payTo,
    resourcePrefix: m.resourcePrefix,
    validAfter: m.validAfter.toString(),
    validBefore: m.validBefore.toString(),
    rotationSeq: m.rotationSeq.toString(),
    nonce: m.nonce,
    signature: auth.signature,
  };
}
