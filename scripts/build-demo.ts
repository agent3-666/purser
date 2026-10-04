/** Generate public-only local fixtures, then bundle the real verifier and purchase boundary for a static demo. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeAuthorization, identityDocument, signPayeeAuthorization } from "../src/payee-auth/sign.js";
import { verifyPayee } from "../src/payee-auth/verify.js";
import { recommendPurchase, type PurchaseNeed, type PurchaseOffer } from "../src/purchasing/recommend.js";
import { evaluateDemoScenario, type DemoFixture } from "../src/demo/scenario.js";

const seller = privateKeyToAccount(generatePrivateKey());
const payee = privateKeyToAccount(generatePrivateKey()).address;
const sellerDomain = "local-demo.invalid";
const resource = `https://${sellerDomain}/v1/search`;
const now = Math.floor(Date.now() / 1000);
const authorization = await signPayeeAuthorization(seller, {
  sellerDomain, network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000",
  payTo: payee, resourcePrefix: `https://${sellerDomain}/v1/`, validAfter: now - 60,
  validBefore: now + 30 * 24 * 3600, rotationSeq: 1,
});
const identity = identityDocument(sellerDomain, [{ address: seller.address, validAfter: now - 60,
  validBefore: now + 30 * 24 * 3600, status: "active" }]);
const offer = { resource, network: "eip155:5042002", asset: authorization.message.asset,
  payTo: payee, amount: "100", extra: { payeeAuthorization: encodeAuthorization(authorization) } };
const ledger = { current: () => null, nonceSeen: () => false };
const fetchIdentity = async () => identity;
const confirmed = await verifyPayee(offer, { fetchIdentity, ledger, now });
const rejected = await verifyPayee({ ...offer, payTo: privateKeyToAccount(generatePrivateKey()).address }, { fetchIdentity, ledger, now });
const unconfirmed = await verifyPayee({ ...offer, extra: undefined }, { fetchIdentity, ledger, now });
assert.deepEqual([confirmed.verdict, rejected.verdict, unconfirmed.verdict], ["confirmed", "rejected", "unconfirmed"]);
const need: PurchaseNeed = { id: "local-demo-search", resourceKind: "web_search", billingUnit: "per_request",
  requiredCapabilities: ["web_results"], maxAmountWei: "100", minimumOfferLifetimeSeconds: 30 };
const purchaseOffer: PurchaseOffer = { id: "seller-a", sellerId: sellerDomain, payTo: payee,
  paymentRoute: "local_native_transfer", resource, resourceKind: "web_search", billingUnit: "per_request",
  capabilities: ["web_results"], amountWei: "100", validBefore: now + 3600, payeeVerdict: confirmed.verdict };
const positive = await recommendPurchase(need, [purchaseOffer], async () => ({ offerId: "seller-a", reason: "Only verified qualified option in this local example." }), now);
const negative = await recommendPurchase(need, [{ ...purchaseOffer, payeeVerdict: rejected.verdict }],
  async () => { throw new Error("model must not be called"); }, now);
assert.equal(positive.outcome, "propose");
assert.equal(negative.outcome, "defer");
const dir = new URL("../docs/demo/", import.meta.url);
mkdirSync(dir, { recursive: true });
// The private keys and model call do not enter these public fixtures.
const fixture: DemoFixture & { label: string } = { createdAt: new Date(now * 1000).toISOString(),
  label: "Synthetic local demo; no network service or payment is contacted",
  sellerDomain, identity, offer, need, purchaseOffer };
writeFileSync(new URL("fixtures.json", dir), JSON.stringify(fixture, null, 2));
// A future viewer must still see the historical clean example; the explicit expiry scenario must fail.
const originalDateNow = Date.now;
try {
  Date.now = () => (now + 365 * 24 * 3600) * 1000;
  const futureClean = await evaluateDemoScenario(fixture, "clean");
  assert.equal(futureClean.verification.verdict, "confirmed");
  assert.equal(futureClean.proposal.outcome, "propose");
  assert.equal(futureClean.asOf, now);
  const expired = await evaluateDemoScenario(fixture, "expired");
  assert.equal(expired.verification.verdict, "rejected");
  assert.ok(expired.verification.reasons.includes("expired"));
  assert.equal(expired.proposal.outcome, "defer");
  assert.equal(expired.modelCalls.length, 0);
} finally {
  Date.now = originalDateNow;
}
const built = await build({ entryPoints: [new URL("../src/demo/browser.ts", import.meta.url).pathname],
  outfile: new URL("bundle.js", dir).pathname, bundle: true, platform: "browser", format: "esm",
  target: "es2022", minify: true, metafile: true, logLevel: "warning" });
const inputs = Object.keys(built.metafile.inputs);
assert.ok(inputs.some((path) => path.endsWith("src/payee-auth/verify.ts")));
assert.ok(inputs.some((path) => path.endsWith("src/purchasing/recommend.ts")));
assert.ok(inputs.some((path) => path.endsWith("src/delivery/arc-block.ts")));
const bundle = readFileSync(new URL("bundle.js", dir), "utf8");
for (const forbidden of ["/Users/", "node:fs", "node:crypto", "Payment-Signature"]) {
  assert.ok(!bundle.includes(forbidden), `static demo bundle must not contain ${forbidden}`);
}
console.log("PASS static demo build: historical clean scenario survives future wall clock; simulated expiry rejects");
