/** A proposal boundary for a purchasing model. Eligibility is decided here, not by the model. */
import { isAddress, type Address } from "viem";
import { createHash } from "node:crypto";
import type { PurchaseOrder } from "../executor/journal.js";
export interface PurchaseNeed {
  id: string;
  resourceKind: string;
  billingUnit: string;
  requiredCapabilities: string[];
  maxAmountWei: string;
  minimumOfferLifetimeSeconds: number;
}

export interface PurchaseOffer {
  id: string;
  sellerId: string;
  payTo: Address;
  resource: string;
  resourceKind: string;
  billingUnit: string;
  capabilities: string[];
  amountWei: string;
  validBefore: number;
  payeeVerdict: "confirmed" | "unconfirmed" | "rejected";
}

export type ExclusionReason =
  | "invalid_offer" | "wrong_resource_kind" | "different_billing_unit"
  | "missing_capability" | "over_budget" | "offer_expiring" | "payee_not_confirmed";

export interface EvaluatedOffer {
  offer: PurchaseOffer;
  eligible: boolean;
  reasons: ExclusionReason[];
}

export interface Recommendation {
  needId: string;
  outcome: "propose" | "defer";
  selectedOfferId?: string;
  selectedOfferFingerprint?: string;
  evaluated: EvaluatedOffer[];
  baselineCheapestEligibleId?: string;
  baselineFixedSellerId?: string;
  /** What the model actually proposed, even if rejected. */
  modelOfferId?: string;
  /** The model's explanation is evidence only; it never authorizes payment. */
  modelReason?: string;
  modelRejectedReason?: "unknown_offer" | "ineligible_offer" | "model_error" | "offer_modified_by_model" | "need_modified_by_model";
}

export type PurchasingModel = (input: {
  need: PurchaseNeed;
  eligibleOffers: PurchaseOffer[];
}) => Promise<{ offerId: string; reason: string }>;

function fingerprint(offer: PurchaseOffer): string {
  return createHash("sha256").update(JSON.stringify(offer)).digest("hex");
}

function amount(value: string): bigint | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

export function evaluateOffers(need: PurchaseNeed, offers: PurchaseOffer[], now: number): EvaluatedOffer[] {
  const cap = amount(need.maxAmountWei);
  if (!need.id || !need.resourceKind || !need.billingUnit || cap === null ||
      !Number.isSafeInteger(need.minimumOfferLifetimeSeconds) || need.minimumOfferLifetimeSeconds < 0 ||
      !Number.isSafeInteger(now) || new Set(offers.map((o) => o.id)).size !== offers.length) {
    throw new Error("invalid purchase need, timestamp or duplicate offer id");
  }
  return offers.map((offer) => {
    const reasons: ExclusionReason[] = [];
    const price = amount(offer.amountWei);
    if (!offer.id || !offer.sellerId || !isAddress(offer.payTo) || !/^https?:\/\//.test(offer.resource) ||
        price === null || !Number.isSafeInteger(offer.validBefore)) reasons.push("invalid_offer");
    if (offer.resourceKind !== need.resourceKind) reasons.push("wrong_resource_kind");
    if (offer.billingUnit !== need.billingUnit) reasons.push("different_billing_unit");
    if (need.requiredCapabilities.some((capability) => !offer.capabilities.includes(capability))) reasons.push("missing_capability");
    if (price !== null && price > cap) reasons.push("over_budget");
    if (Number.isSafeInteger(offer.validBefore) && offer.validBefore - now < need.minimumOfferLifetimeSeconds) reasons.push("offer_expiring");
    if (offer.payeeVerdict !== "confirmed") reasons.push("payee_not_confirmed");
    return { offer, eligible: reasons.length === 0, reasons };
  });
}

/** Model output is advisory. An invalid suggestion defers, rather than silently buying another offer. */
export async function recommendPurchase(
  need: PurchaseNeed,
  offers: PurchaseOffer[],
  model: PurchasingModel,
  now: number,
  fixedSellerId?: string,
): Promise<Recommendation> {
  // Model code is untrusted: keep evaluation objects and the caller's inputs separate from its view.
  const offersBefore = JSON.stringify(offers);
  const needBefore = JSON.stringify(need);
  const evaluated = evaluateOffers(structuredClone(need), structuredClone(offers), now);
  const eligible = evaluated.filter((e) => e.eligible).map((e) => e.offer);
  const cheapest = [...eligible].sort((a, b) => {
    const delta = BigInt(a.amountWei) - BigInt(b.amountWei);
    return delta < 0n ? -1 : delta > 0n ? 1 : a.id.localeCompare(b.id);
  })[0];
  const fixed = fixedSellerId ? eligible.find((o) => o.sellerId === fixedSellerId) : undefined;
  const base: Recommendation = {
    needId: need.id,
    outcome: "defer",
    evaluated,
    baselineCheapestEligibleId: cheapest?.id,
    baselineFixedSellerId: fixed?.id,
  };
  if (!eligible.length) return base;
  let suggested: { offerId: string; reason: string };
  const modelNeed = structuredClone(need);
  const modelOffers = structuredClone(eligible);
  const modelNeedBefore = JSON.stringify(modelNeed);
  const modelOffersBefore = JSON.stringify(modelOffers);
  try { suggested = await model({ need: modelNeed, eligibleOffers: modelOffers }); }
  catch { return { ...base, modelRejectedReason: "model_error" }; }
  if (JSON.stringify(offers) !== offersBefore || JSON.stringify(modelOffers) !== modelOffersBefore) {
    return { ...base, modelOfferId: suggested?.offerId, modelReason: suggested?.reason,
      modelRejectedReason: "offer_modified_by_model" };
  }
  if (JSON.stringify(need) !== needBefore || JSON.stringify(modelNeed) !== modelNeedBefore) {
    return { ...base, modelOfferId: suggested?.offerId, modelReason: suggested?.reason,
      modelRejectedReason: "need_modified_by_model" };
  }
  const matched = evaluated.find((e) => e.offer.id === suggested?.offerId);
  if (!matched) return { ...base, modelOfferId: suggested?.offerId, modelReason: suggested?.reason, modelRejectedReason: "unknown_offer" };
  if (!matched.eligible) return { ...base, modelOfferId: suggested.offerId, modelReason: suggested.reason, modelRejectedReason: "ineligible_offer" };
  return { ...base, outcome: "propose", selectedOfferId: matched.offer.id,
    selectedOfferFingerprint: fingerprint(matched.offer), modelOfferId: matched.offer.id, modelReason: suggested.reason };
}

/** Re-evaluate mutable offer terms at the handoff; the model cannot supply payment fields. */
export function buildPurchaseProposal(
  recommendation: Recommendation,
  need: PurchaseNeed,
  offers: PurchaseOffer[],
  now: number,
  orderId: string,
  requestHash: string,
): Omit<PurchaseOrder, "state" | "broadcasts" | "history"> {
  if (recommendation.outcome !== "propose" || !recommendation.selectedOfferId ||
      recommendation.needId !== need.id || !orderId || !/^0x[0-9a-fA-F]{64}$/.test(requestHash)) {
    throw new Error("no valid purchase decision");
  }
  const selected = evaluateOffers(need, offers, now).find((e) => e.offer.id === recommendation.selectedOfferId);
  if (!selected?.eligible || recommendation.selectedOfferFingerprint !== fingerprint(selected.offer)) {
    throw new Error("selected offer is no longer eligible or its terms changed");
  }
  return {
    id: orderId,
    purpose: `purchase ${need.resourceKind}`,
    needId: need.id,
    resource: selected.offer.resource,
    requestHash,
    payTo: selected.offer.payTo,
    amountWei: selected.offer.amountWei,
    maxAmountWei: need.maxAmountWei,
    validBefore: selected.offer.validBefore,
    payeeVerdict: selected.offer.payeeVerdict,
  };
}
