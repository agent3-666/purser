import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeAuthorization, identityDocument, signPayeeAuthorization } from "../src/payee-auth/sign.js";
import { PayeeLedger } from "../src/payee-auth/ledger.js";
import { fetchUnpaidQuote, parsePaymentRequired, verifyObservedQuote } from "../src/x402/quote.js";

const seller = privateKeyToAccount(generatePrivateKey());
const payee = privateKeyToAccount(generatePrivateKey()).address;
let host = "";
let header = "";
const server = createServer((req, res) => {
  if (req.url === "/.well-known/x402-payee.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(identityDocument(host, [{ address: seller.address, validAfter: 0, validBefore: 4_000_000_000, status: "active" }])));
    return;
  }
  if (req.url === "/v1/search") {
    res.writeHead(402, { "payment-required": header, "content-type": "application/json" });
    res.end("{}");
    return;
  }
  res.writeHead(200).end("ordinary response");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = `http://${host}/v1/search`;
  const auth = await signPayeeAuthorization(seller, {
    sellerDomain: host, network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000",
    payTo: payee, resourcePrefix: `http://${host}/v1/`, validAfter: 1_790_000_000 - 60,
    validBefore: 1_790_000_000 + 3600, rotationSeq: 1,
  });
  const terms = { scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000",
    amount: "100", payTo: payee, maxTimeoutSeconds: 60, extra: { payeeAuthorization: encodeAuthorization(auth) } };
  const envelope = { x402Version: 2, resource: { url, mimeType: "application/json" }, accepts: [terms] };
  header = Buffer.from(JSON.stringify(envelope)).toString("base64");
  const observed = await fetchUnpaidQuote({ url, method: "GET" });
  assert.equal(observed.status, 402);
  assert.equal(observed.offers.length, 1);
  const checked = await verifyObservedQuote(observed, {
    ledger: new PayeeLedger(null), now: 1_790_000_000,
    fetchIdentity: async (domain) => {
      assert.equal(domain, host);
      const r = await fetch(`http://${domain}/.well-known/x402-payee.json`);
      return r.ok ? await r.json() : null;
    },
  });
  assert.equal(checked[0].verification.verdict, "confirmed");
  const rewritten = Buffer.from(JSON.stringify({ ...envelope, accepts: [{ ...terms, payTo: "0x2222222222222222222222222222222222222222" }] })).toString("base64");
  const forged = parsePaymentRequired(rewritten, url);
  assert.equal((await verifyObservedQuote({ ...observed, offers: forged }, {
    ledger: new PayeeLedger(null), now: 1_790_000_000,
    fetchIdentity: async () => identityDocument(host, [{ address: seller.address, validAfter: 0, validBefore: 4_000_000_000, status: "active" }]),
  }))[0].verification.verdict, "rejected");
  assert.throws(() => parsePaymentRequired(header, `http://${host}/different`), /resource URL differs/);
  await assert.rejects(fetchUnpaidQuote({ url: `http://${host}/ordinary`, method: "GET" }), /expected unpaid 402/);
  await assert.rejects(fetchUnpaidQuote({ url, method: "GET", headers: { "PAYMENT-SIGNATURE": "should-not-send" } }), /must not include a payment header/);
  console.log("PASS x402 quote: live local HTTP 402 ingestion, separate identity fetch, rewritten payee rejected, wrong resource rejected");
} finally { server.close(); }
