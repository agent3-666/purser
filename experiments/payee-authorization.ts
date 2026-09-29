/**
 * Reproducible experiments for the payee authorization protocol.
 *
 *   npm run experiments
 *
 * Two sellers run as real local HTTP servers. Each serves its identity document at
 * /.well-known/x402-payee.json and answers unpaid requests with a 402 whose offer carries a signed
 * payee authorization. The buyer fetches the 402 over HTTP, fetches the identity document over a
 * separate request, and verifies. Attacks are applied where an attacker would sit: on the offer in
 * transit, or with a key of their own.
 *
 * Every scenario states the verdict it must produce and the rule it exists to exercise, so
 * scripts/mutation-check.ts can delete that rule and require this scenario to change.
 */

import { createServer, type Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { encodeAuthorization, identityDocument, signPayeeAuthorization } from "../src/payee-auth/sign.js";
import { PayeeLedger } from "../src/payee-auth/ledger.js";
import { verifyPayee, type IdentityFetcher } from "../src/payee-auth/verify.js";
import type { OfferUnderCheck, PayeeIdentityDocument, ReasonCode, Verdict } from "../src/payee-auth/types.js";

const NETWORK = "eip155:5042002"; // Arc testnet
const USDC = "0x3600000000000000000000000000000000000000" as Address; // Arc system USDC
const NOW = 1_790_000_000;

export interface ScenarioResult {
  id: string;
  what: string;
  guard: string | null;
  expected: { verdict: Verdict; reason?: ReasonCode };
  got: { verdict: Verdict; reasons: ReasonCode[] };
  pass: boolean;
}

interface Seller {
  host: string;
  base: string;
  identity: ReturnType<typeof privateKeyToAccount>;
  doc: PayeeIdentityDocument;
  offer: Record<string, unknown> | null; // what the next 402 will say
  server: Server;
}

async function startSeller(): Promise<Seller> {
  const identity = privateKeyToAccount(generatePrivateKey());
  const seller = { identity, offer: null } as unknown as Seller;
  seller.server = createServer((req, res) => {
    if (req.url === "/.well-known/x402-payee.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(seller.doc));
      return;
    }
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ x402Version: 2, accepts: seller.offer ? [seller.offer] : [] }));
  });
  await new Promise<void>((r) => seller.server.listen(0, "127.0.0.1", () => r()));
  const port = (seller.server.address() as { port: number }).port;
  seller.host = `127.0.0.1:${port}`;
  seller.base = `http://${seller.host}`;
  seller.doc = identityDocument(seller.host, [
    { address: identity.address, validAfter: 0, validBefore: 4_000_000_000, status: "active" },
  ]);
  return seller;
}

/** The experiments run over plain HTTP on localhost; production uses https (see verify.ts). */
const fetchIdentityLocal: IdentityFetcher = async (domain) => {
  try {
    const res = await fetch(`http://${domain}/.well-known/x402-payee.json`);
    return res.ok ? ((await res.json()) as PayeeIdentityDocument) : null;
  } catch {
    return null;
  }
};

async function sellerOffers(
  s: Seller,
  payTo: Address,
  rotationSeq: number,
  opts: { validAfter?: number; validBefore?: number; ephemeral?: boolean; prefix?: string } = {},
) {
  const auth = await signPayeeAuthorization(s.identity, {
    sellerDomain: s.host,
    network: NETWORK,
    asset: USDC,
    payTo,
    resourcePrefix: opts.prefix ?? `${s.base}/v1/`,
    validAfter: opts.validAfter ?? NOW - 60,
    validBefore: opts.validBefore ?? NOW + 3600,
    rotationSeq,
    ephemeral: opts.ephemeral,
  });
  s.offer = {
    scheme: "exact",
    network: NETWORK,
    asset: USDC,
    payTo,
    amount: "1000",
    extra: { payeeAuthorization: encodeAuthorization(auth) },
  };
  return auth;
}

/** What the buyer sees: a real HTTP 402 from the seller, parsed. */
async function fetchOffer(url: string): Promise<OfferUnderCheck> {
  const res = await fetch(url);
  const body = (await res.json()) as { accepts: Array<Record<string, unknown>> };
  const a = body.accepts[0];
  return {
    resource: url,
    network: String(a.network),
    asset: a.asset as Address,
    payTo: a.payTo as Address,
    amount: String(a.amount),
    extra: a.extra as Record<string, unknown>,
  };
}

const addr = () => privateKeyToAccount(generatePrivateKey()).address;

export async function runExperiments(): Promise<ScenarioResult[]> {
  const S = await startSeller();
  const T = await startSeller(); // a second, unrelated seller
  const ledger = new PayeeLedger(null);
  const results: ScenarioResult[] = [];
  const P1 = addr(), P2 = addr(), ATTACKER = addr();
  const attackerKey = privateKeyToAccount(generatePrivateKey());

  async function check(
    id: string,
    what: string,
    guard: string | null,
    offer: OfferUnderCheck,
    expected: { verdict: Verdict; reason?: ReasonCode },
    commitIfConfirmed = true,
  ) {
    const r = await verifyPayee(offer, { fetchIdentity: fetchIdentityLocal, ledger, now: NOW });
    const pass = r.verdict === expected.verdict && (!expected.reason || r.reasons.includes(expected.reason));
    if (r.verdict === "confirmed" && r.observation && commitIfConfirmed) {
      const sid = (offer.extra!.payeeAuthorization as Record<string, string>).sellerId as Address;
      ledger.commit(r.observation, sid);
    }
    results.push({ id, what, guard, expected, got: { verdict: r.verdict, reasons: r.reasons }, pass });
  }

  const url = `${S.base}/v1/search`;
  try {
    // Normal operation.
    await sellerOffers(S, P1, 1);
    const firstOffer = await fetchOffer(url);
    await check("E1", "first contact: seller authorizes P1 at rotation 1", null, firstOffer, { verdict: "confirmed" });

    await sellerOffers(S, P2, 2);
    await check("E2", "normal rotation: seller moves to P2 at rotation 2", null, await fetchOffer(url), { verdict: "confirmed" });

    // Replay: the old, still-in-window authorization for P1 is presented again after the rotation.
    await check("E3", "replay of the rotation-1 authorization after rotating to P2", "rotation-moves-forward", firstOffer, {
      verdict: "rejected",
      reason: "replay_stale_rotation",
    });

    // Substitution in transit: the address is rewritten, the authorization is left as it was.
    await sellerOffers(S, P2, 2);
    const rewritten = { ...(await fetchOffer(url)), payTo: ATTACKER };
    await check("E4", "address rewritten in transit, authorization untouched", "offer-matches-authorization", rewritten, {
      verdict: "rejected",
      reason: "offer_mismatch",
    });

    // Substitution with the attacker's own key, honestly naming itself.
    const forgedOwn = await signPayeeAuthorization(attackerKey, {
      sellerDomain: S.host, network: NETWORK, asset: USDC, payTo: ATTACKER,
      resourcePrefix: `${S.base}/v1/`, validAfter: NOW - 60, validBefore: NOW + 3600, rotationSeq: 99,
    });
    await check("E5", "attacker signs its own address with its own key", "identity-published-by-domain",
      { ...rewritten, extra: { payeeAuthorization: encodeAuthorization(forgedOwn) } },
      { verdict: "unconfirmed", reason: "identity_not_published" }, false);

    // Substitution with the attacker's key, claiming to be the seller.
    const claim = encodeAuthorization(forgedOwn);
    claim.sellerId = S.identity.address;
    await check("E6", "attacker signs but claims the seller's identity", "signature-matches-seller-id",
      { ...rewritten, extra: { payeeAuthorization: claim } }, { verdict: "rejected", reason: "bad_signature" });

    // Cross-domain replay: seller T's genuine authorization presented on seller S's resource.
    await sellerOffers(T, ATTACKER, 1);
    const tOffer = await fetchOffer(`${T.base}/v1/search`);
    await check("E7", "a different seller's genuine authorization replayed on this seller", "domain-bound-to-resource-host",
      { ...tOffer, resource: url }, { verdict: "rejected", reason: "domain_mismatch" }, false);

    // The same replay where the other seller signed a broad prefix, so only the domain binding stops it.
    const broad = await signPayeeAuthorization(T.identity, {
      sellerDomain: T.host, network: NETWORK, asset: USDC, payTo: ATTACKER,
      resourcePrefix: "http://", validAfter: NOW - 60, validBefore: NOW + 3600, rotationSeq: 1,
    });
    await check("E7b", "a different seller's broad-prefix authorization replayed on this seller", "domain-bound-to-resource-host",
      { ...tOffer, resource: url, extra: { payeeAuthorization: encodeAuthorization(broad) } },
      { verdict: "rejected", reason: "domain_mismatch" }, false);

    // Scope: an authorization for /v1/ used to pay for another path on the same host.
    await sellerOffers(S, P2, 2);
    await check("E8", "authorization for /v1/ used on /admin/", "resource-within-prefix",
      { ...(await fetchOffer(url)), resource: `${S.base}/admin/export` }, { verdict: "rejected", reason: "resource_out_of_scope" });

    // Equivocation: two different addresses signed under the same rotation number.
    await sellerOffers(S, ATTACKER, 2);
    await check("E9", "second address signed under an already-used rotation number", "no-equivocation",
      await fetchOffer(url), { verdict: "rejected", reason: "equivocation" });

    // Validity window.
    await sellerOffers(S, P2, 3, { validAfter: NOW - 7200, validBefore: NOW - 3600 });
    await check("E10", "authorization already expired", "not-after", await fetchOffer(url), { verdict: "rejected", reason: "expired" });
    await sellerOffers(S, P2, 3, { validAfter: NOW + 3600, validBefore: NOW + 7200 });
    await check("E11", "authorization not yet valid", "not-before", await fetchOffer(url), { verdict: "rejected", reason: "not_yet_valid" });

    // Per-request addresses, the case where pinning one address cannot work.
    const fresh = addr();
    await sellerOffers(S, fresh, 0, { ephemeral: true, validBefore: NOW + 300 });
    const ephemeralOffer = await fetchOffer(url);
    await check("E12", "per-request fresh address with a single-use nonce", null, ephemeralOffer, { verdict: "confirmed" });
    await check("E13", "the same per-request authorization presented a second time", "nonce-single-use", ephemeralOffer, {
      verdict: "rejected", reason: "replay_nonce",
    });
    await sellerOffers(S, addr(), 0, { ephemeral: true, validBefore: NOW + 86_400 });
    await check("E14", "per-request authorization with a one-day window", "ephemeral-window-bounded", await fetchOffer(url), {
      verdict: "rejected", reason: "ephemeral_window_too_long",
    });

    // Missing evidence is not the same as bad evidence.
    const stripped = { ...(await fetchOffer(url)) };
    delete stripped.extra;
    await check("E15", "authorization stripped from the offer", null, stripped, { verdict: "unconfirmed", reason: "no_authorization" });

    // Revocation, published by the seller's own domain.
    await sellerOffers(S, P2, 4);
    const beforeRevoke = await fetchOffer(url);
    S.doc = identityDocument(S.host, [{ ...S.doc.identities[0], status: "revoked" }]);
    await check("E16", "seller has revoked the identity that signed", null, beforeRevoke, { verdict: "rejected", reason: "identity_revoked" });
    S.doc = identityDocument(S.host, [{ address: S.identity.address, validAfter: 0, validBefore: NOW - 1, status: "active" }]);
    await check("E17", "published identity key expired even though signature is fresh", null, beforeRevoke,
      { verdict: "rejected", reason: "identity_expired" });
    S.doc = identityDocument(S.host, [{ address: S.identity.address, validAfter: NOW + 1, validBefore: NOW + 3600, status: "active" }]);
    await check("E18", "published identity key is not yet valid", null, beforeRevoke,
      { verdict: "rejected", reason: "identity_not_yet_valid" });
    S.doc = { version: 1, sellerDomain: S.host, identities: null } as unknown as PayeeIdentityDocument;
    await check("E19", "malformed identity document is rejected without throwing", null, beforeRevoke,
      { verdict: "rejected", reason: "malformed_identity_document" });
  } finally {
    S.server.close();
    T.server.close();
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await runExperiments();
  const width = Math.max(...results.map((r) => r.what.length));
  for (const r of results) {
    const got = `${r.got.verdict}${r.got.reasons.length ? ` (${r.got.reasons.join(", ")})` : ""}`;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(4)} ${r.what.padEnd(width)}  ${got}`);
  }
  const failed = results.filter((r) => !r.pass);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const outDir = new URL("../out/", import.meta.url).pathname;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}payee-authorization-experiments.json`, JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} scenarios behaved as specified`);
  if (failed.length) process.exit(1);
}
