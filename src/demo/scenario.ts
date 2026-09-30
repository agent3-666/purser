/** Historical, synthetic evaluation shared by the browser and build-time regression. */
import { verifyPayee } from "../payee-auth/verify.js";
import { recommendPurchase, type PurchaseNeed, type PurchaseOffer } from "../purchasing/recommend.js";
import type { OfferUnderCheck, PayeeIdentityDocument } from "../payee-auth/types.js";

export interface DemoFixture {
  createdAt: string;
  sellerDomain: string;
  identity: PayeeIdentityDocument;
  offer: OfferUnderCheck;
  need: PurchaseNeed;
  purchaseOffer: PurchaseOffer;
}

export async function evaluateDemoScenario(fixture: DemoFixture, scenario: string, customPayTo?: string) {
  const snapshotMs = Date.parse(fixture.createdAt);
  if (!Number.isFinite(snapshotMs)) throw new Error("invalid synthetic snapshot time");
  const snapshotSeconds = Math.floor(snapshotMs / 1000);
  // Expiry is still enforced by the real modules. Only this historical demo fixes its as-of time.
  const asOf = scenario === "expired" ? snapshotSeconds + 31 * 24 * 3600 : snapshotSeconds;
  const offer: OfferUnderCheck = structuredClone(fixture.offer);
  const identity: PayeeIdentityDocument = structuredClone(fixture.identity);
  if (scenario === "tampered") offer.payTo = "0x2222222222222222222222222222222222222222";
  if (scenario === "missing") delete offer.extra?.payeeAuthorization;
  if (scenario === "revoked") identity.identities[0].status = "revoked";
  if (scenario === "custom") offer.payTo = (customPayTo ?? "") as `0x${string}`;
  const verification = await verifyPayee(offer, {
    ledger: { current: () => null, nonceSeen: () => false }, now: asOf,
    fetchIdentity: async (domain) => domain === fixture.sellerDomain ? identity : null,
  });
  const modelCalls: string[] = [];
  const proposal = await recommendPurchase(fixture.need,
    [{ ...fixture.purchaseOffer, payTo: offer.payTo, payeeVerdict: verification.verdict }],
    async ({ eligibleOffers }) => {
      modelCalls.push("Local scripted proposal was requested after eligibility checks");
      return { offerId: eligibleOffers[0].id, reason: "One qualified option in this local simulation." };
    }, asOf);
  return { asOf, offer, verification, proposal, modelCalls };
}
