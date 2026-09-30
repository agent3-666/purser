/** Runs the real verifier and proposal boundary in the browser; deliberately contains no payment code. */
import { verifyPayee } from "../payee-auth/verify.js";
import { recommendPurchase, type PurchaseNeed, type PurchaseOffer } from "../purchasing/recommend.js";
import type { OfferUnderCheck, PayeeIdentityDocument } from "../payee-auth/types.js";

interface Fixture { createdAt: string; sellerDomain: string; identity: PayeeIdentityDocument;
  offer: OfferUnderCheck; need: PurchaseNeed; purchaseOffer: PurchaseOffer; }
const element = (id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing demo element ${id}`);
  return found;
};
const fixture = await fetch("./fixtures.json").then(async (response) => {
  if (!response.ok) throw new Error(`fixtures unavailable: ${response.status}`);
  return await response.json() as Fixture;
});
element("fixture-date").textContent = new Date(fixture.createdAt).toLocaleString();
const payTo = element("payee-input") as HTMLInputElement;
payTo.value = fixture.offer.payTo;
const ledger = { current: () => null, nonceSeen: () => false };

async function runScenario(scenario: string): Promise<void> {
  element("status").textContent = "Running local checks…";
  const offer: OfferUnderCheck = structuredClone(fixture.offer);
  const identity: PayeeIdentityDocument = structuredClone(fixture.identity);
  if (scenario === "tampered") offer.payTo = "0x2222222222222222222222222222222222222222";
  if (scenario === "missing") delete offer.extra?.payeeAuthorization;
  if (scenario === "revoked") identity.identities[0].status = "revoked";
  if (scenario === "custom") offer.payTo = payTo.value.trim() as `0x${string}`;
  const verification = await verifyPayee(offer, {
    ledger, now: Math.floor(Date.now() / 1000),
    fetchIdentity: async (domain) => domain === fixture.sellerDomain ? identity : null,
  });
  const modelCalls: string[] = [];
  const proposal = await recommendPurchase(fixture.need,
    [{ ...fixture.purchaseOffer, payTo: offer.payTo, payeeVerdict: verification.verdict }],
    async ({ eligibleOffers }) => {
      modelCalls.push("Local scripted proposal was requested after eligibility checks");
      return { offerId: eligibleOffers[0].id, reason: "One qualified option in this local simulation." };
    }, Math.floor(Date.now() / 1000));
  const verdict = verification.verdict;
  element("status").textContent = verdict === "confirmed" ? "Confirmed authorization" : verdict === "rejected" ? "Rejected: offer contradicts evidence" : "Unconfirmed: authorization missing";
  element("status").setAttribute("data-verdict", verdict);
  element("verdict").textContent = verdict;
  element("reasons").textContent = verification.reasons.length ? verification.reasons.join(", ") : "All authorization checks passed";
  element("decision").textContent = proposal.outcome === "propose" ? "Proposal only — no order signed" : "Defer — no order created";
  element("model-call").textContent = modelCalls.length ? modelCalls[0] : "Model not called: no eligible offer";
  element("trace").textContent = JSON.stringify({ scenario, offer: { resource: offer.resource, payTo: offer.payTo, amount: offer.amount },
    verification: { verdict, reasons: verification.reasons }, purchaseBoundary: {
      outcome: proposal.outcome, selectedOfferId: proposal.selectedOfferId ?? null,
      exclusions: proposal.evaluated.flatMap((entry) => entry.reasons), modelCalled: modelCalls.length > 0,
      paymentRoute: "local_native_transfer (synthetic only)" } }, null, 2);
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-scenario]")) {
  button.addEventListener("click", () => {
    for (const other of document.querySelectorAll<HTMLButtonElement>("[data-scenario]")) other.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-pressed", "true");
    void runScenario(button.dataset.scenario ?? "clean").catch((error) => { element("status").textContent = `Local check failed: ${String(error)}`; });
  });
}
void runScenario("clean").catch((error) => { element("status").textContent = `Local check failed: ${String(error)}`; });
