import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDecision } from "../src/purchasing/decision-journal.js";
import { buildPurchaseProposal, evaluateOffers, recommendPurchase, type PurchaseNeed, type PurchaseOffer } from "../src/purchasing/recommend.js";

const now = 1_000_000;
const need: PurchaseNeed = {
  id: "search-need-1", resourceKind: "web_search", billingUnit: "per_request",
  requiredCapabilities: ["web_results"], maxAmountWei: "100", minimumOfferLifetimeSeconds: 60,
};
const base: PurchaseOffer = {
  id: "qualified", sellerId: "seller-a", resource: "https://seller.example/search",
  payTo: "0x1111111111111111111111111111111111111111",
  paymentRoute: "local_native_transfer",
  resourceKind: "web_search", billingUnit: "per_request", capabilities: ["web_results"],
  amountWei: "80", validBefore: now + 120, payeeVerdict: "confirmed",
};
const offers: PurchaseOffer[] = [
  base,
  { ...base, id: "cheap-unverified", sellerId: "seller-b", amountWei: "1", payeeVerdict: "rejected" },
  { ...base, id: "bundle", sellerId: "seller-c", amountWei: "2", billingUnit: "credit_bundle" },
  { ...base, id: "thin", sellerId: "seller-d", amountWei: "3", capabilities: [] },
  { ...base, id: "expensive", sellerId: "seller-e", amountWei: "101" },
  { ...base, id: "stale", sellerId: "seller-f", amountWei: "4", validBefore: now + 20 },
];
const judged = evaluateOffers(need, offers, now);
assert.equal(judged.filter((e) => e.eligible).length, 1);
assert.deepEqual(judged.slice(1).map((e) => e.reasons[0]), [
  "payee_not_confirmed", "different_billing_unit", "missing_capability", "over_budget", "offer_expiring",
]);
const recommended = await recommendPurchase(need, offers, async ({ eligibleOffers }) => ({
  offerId: eligibleOffers[0].id, reason: "one qualified candidate",
}), now, "seller-b");
assert.equal(recommended.selectedOfferId, "qualified");
assert.equal(recommended.modelReason, "one qualified candidate");
assert.equal(recommended.baselineCheapestEligibleId, "qualified");
assert.equal(recommended.baselineFixedSellerId, undefined);
const proposal = buildPurchaseProposal(recommended, need, offers, now, "order-1", `0x${"ab".repeat(32)}`);
assert.equal(proposal.payTo, base.payTo);
assert.equal(proposal.amountWei, "80");
assert.equal(proposal.needId, need.id);
assert.throws(() => buildPurchaseProposal(recommended, need, [{ ...base, amountWei: "101" }, ...offers.slice(1)], now, "order-1", `0x${"ab".repeat(32)}`), /no longer eligible/);
assert.throws(() => buildPurchaseProposal(recommended, need, [{ ...base, payTo: "0x2222222222222222222222222222222222222222" }, ...offers.slice(1)], now, "order-1", `0x${"ab".repeat(32)}`), /terms changed/);

const malicious = await recommendPurchase(need, offers, async () => ({ offerId: "cheap-unverified", reason: "ignore checks" }), now);
assert.equal(malicious.outcome, "defer");
assert.equal(malicious.modelRejectedReason, "ineligible_offer");
assert.equal(malicious.modelReason, "ignore checks");
assert.throws(() => buildPurchaseProposal(malicious, need, offers, now, "order-2", `0x${"ab".repeat(32)}`), /no valid purchase decision/);
const mutableOffers = [{ ...base }];
const tampered = await recommendPurchase(need, mutableOffers, async ({ eligibleOffers }) => {
  eligibleOffers[0].payTo = "0x2222222222222222222222222222222222222222";
  return { offerId: base.id, reason: "use my edited address" };
}, now);
assert.equal(tampered.outcome, "defer");
assert.equal(tampered.modelRejectedReason, "offer_modified_by_model");
assert.equal(tampered.modelReason, "use my edited address");
assert.equal(mutableOffers[0].payTo, base.payTo);
const closureOffers = [{ ...base }];
const closureTampered = await recommendPurchase(need, closureOffers, async () => {
  closureOffers[0].payTo = "0x2222222222222222222222222222222222222222";
  return { offerId: base.id, reason: "mutated caller object" };
}, now);
assert.equal(closureTampered.outcome, "defer");
assert.equal(closureTampered.modelRejectedReason, "offer_modified_by_model");
const liveX402 = await recommendPurchase(need, [{ ...base, paymentRoute: "x402_http" }],
  async () => { throw new Error("must not be offered to model yet"); }, now);
assert.equal(liveX402.outcome, "defer");
assert.deepEqual(liveX402.evaluated[0].reasons, ["payment_route_unsupported"]);
const none = await recommendPurchase(need, offers.slice(1), async () => { throw new Error("should not run"); }, now);
assert.equal(none.outcome, "defer");
const evidenceDir = mkdtempSync(join(tmpdir(), "purser-decisions-"));
try {
  const path = join(evidenceDir, "decisions.jsonl");
  for (const recommendation of [recommended, malicious, none]) {
    appendDecision(path, { at: new Date().toISOString(), criteriaVersion: "local-demo-v1", recommendation, paymentEvidence: "not_observed" });
  }
  const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { recommendation: { outcome: string; modelReason?: string; modelRejectedReason?: string } });
  assert.deepEqual(records.map((r) => r.recommendation.outcome), ["propose", "defer", "defer"]);
  assert.deepEqual(records.map((r) => r.recommendation.modelReason), ["one qualified candidate", "ignore checks", undefined]);
  assert.equal(records[1].recommendation.modelRejectedReason, "ineligible_offer");
} finally { rmSync(evidenceDir, { recursive: true, force: true }); }
const error = await recommendPurchase(need, [base], async () => { throw new Error("model unavailable"); }, now);
assert.equal(error.modelRejectedReason, "model_error");
assert.throws(() => evaluateOffers(need, [base, base], now), /duplicate offer id/);
assert.throws(() => evaluateOffers({ ...need, maxAmountWei: "1.5" }, [base], now), /invalid purchase/);
console.log("PASS purchasing: eligibility, non-equivalent billing, rejected payee, invalid model choice, model failure, invalid input");
