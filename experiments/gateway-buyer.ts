import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { isBatchPayment } from "@circle-fin/x402-batching/server";
import { encodeAuthorization, identityDocument, signPayeeAuthorization } from "../src/payee-auth/sign.js";
import { PayeeLedger } from "../src/payee-auth/ledger.js";
import { fetchUnpaidQuote } from "../src/x402/quote.js";
import { buyGatewayOnce } from "../src/x402/gateway-buyer.js";

const now = Math.floor(Date.now() / 1000);
const seller = privateKeyToAccount(generatePrivateKey());
const buyer = privateKeyToAccount(generatePrivateKey());
let signCount = 0;
const observedBuyer = new Proxy(buyer, { get(target, property, receiver) {
  if (property === "signTypedData") return (...args: unknown[]) => {
    signCount++;
    return (target.signTypedData as (...a: unknown[]) => Promise<string>)(...args);
  };
  return Reflect.get(target, property, receiver);
} });
const payee = privateKeyToAccount(generatePrivateKey()).address;
const dir = mkdtempSync(join(tmpdir(), "purser-gateway-"));
let host = "", challenge = "", paidCount = 0, unpaidCount = 0, omitReceipt = false;
const server = createServer(async (req, res) => {
  if (req.url === "/.well-known/x402-payee.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(identityDocument(host, [{ address: seller.address, validAfter: now - 10, validBefore: now + 3600, status: "active" }])));
    return;
  }
  if (req.url === "/work") {
    if (!req.headers["payment-signature"]) {
      unpaidCount++;
      res.writeHead(402, { "payment-required": challenge }); res.end("unpaid");
      return;
    }
    paidCount++;
    const wire = JSON.parse(Buffer.from(req.headers["payment-signature"] as string, "base64").toString("utf8"));
    assert.equal(isBatchPayment(wire.accepted), true);
    assert.equal(wire.x402Version, 2);
    assert.equal(wire.accepted.network, "eip155:5042002");
    assert.equal(wire.payload.authorization.from, buyer.address);
    assert.equal(wire.payload.authorization.to, payee);
    assert.equal(wire.payload.authorization.value, "1000");
    assert.match(wire.payload.signature, /^0x[0-9a-f]{130}$/i);
    const authorization = wire.payload.authorization;
    const recovered = await recoverTypedDataAddress({
      domain: { name: "GatewayWalletBatched", version: "1", chainId: 5042002,
        verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ] }, primaryType: "TransferWithAuthorization", message: {
        from: authorization.from, to: authorization.to, value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce,
      }, signature: wire.payload.signature });
    assert.equal(recovered, buyer.address);
    assert.ok(Number(wire.payload.authorization.validBefore) - now <= 605000);
    res.writeHead(200, omitReceipt ? {} : { "payment-response": Buffer.from(JSON.stringify({ success: true, network: "eip155:5042002", transaction: "local-simulated" })).toString("base64") });
    res.end(JSON.stringify({ result: "local test delivery" }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = `http://${host}/work`;
  const auth = await signPayeeAuthorization(seller, { sellerDomain: host, network: "eip155:5042002",
    asset: "0x3600000000000000000000000000000000000000", payTo: payee, resourcePrefix: `http://${host}/`,
    validAfter: now - 10, validBefore: now + 3600, rotationSeq: 1 });
  const offer = { scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000",
    amount: "1000", payTo: payee, maxTimeoutSeconds: 60,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
      payeeAuthorization: encodeAuthorization(auth) } };
  challenge = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url }, accepts: [offer] })).toString("base64");
  const quote = await fetchUnpaidQuote({ url, method: "POST", body: JSON.stringify({ task: "test" }), headers: { "content-type": "application/json" } });
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const base = { quote, approvedQuoteSha256: quote.paymentRequiredSha256,
    approvedRequestSha256: digest(JSON.stringify(quote.request)), approvedPayTo: payee, maxAtomicAmount: 1000n,
    dailyAtomicLimit: 2000n, totalAtomicLimit: 2000n, journalDir: dir, signer: observedBuyer,
    payeeVerification: { ledger: new PayeeLedger(join(dir, "payee-ledger.json")), now,
      fetchIdentity: async () => identityDocument(host, [{ address: seller.address, validAfter: now - 10, validBefore: now + 3600, status: "active" }]) } };
  const originalChallenge = challenge;
  challenge = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url }, accepts: [{ ...offer, amount: "2000" }] })).toString("base64");
  await assert.rejects(buyGatewayOnce({ ...base, orderId: "changed-402" }), /live 402 changed/);
  challenge = originalChallenge;
  await assert.rejects(buyGatewayOnce({ ...base, orderId: "bad-amount", maxAtomicAmount: 999n }), /approved Arc Gateway offer/);
  await assert.rejects(buyGatewayOnce({ ...base, orderId: "bad-request", approvedRequestSha256: "0".repeat(64) }), /request changed/);
  await assert.rejects(buyGatewayOnce({ ...base, orderId: "bad-payee", payeeVerification: { ledger: new PayeeLedger(join(dir, "bad-ledger.json")), now,
    fetchIdentity: async () => null } }), /not confirmed/);
  await assert.rejects(buyGatewayOnce({ ...base, orderId: "expired-identity", payeeVerification: { ledger: new PayeeLedger(join(dir, "expired-ledger.json")),
    now: now - 3600, fetchIdentity: async () => identityDocument(host, [{ address: seller.address,
      validAfter: now - 7200, validBefore: now - 1, status: "active" }]) } }), /not confirmed/);
  const expiredAuth = await signPayeeAuthorization(seller, { sellerDomain: host, network: "eip155:5042002",
    asset: "0x3600000000000000000000000000000000000000", payTo: payee, resourcePrefix: `http://${host}/`,
    validAfter: now - 7200, validBefore: now - 1, rotationSeq: 1 });
  challenge = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url },
    accepts: [{ ...offer, extra: { ...offer.extra, payeeAuthorization: encodeAuthorization(expiredAuth) } }] })).toString("base64");
  const expiredQuote = await fetchUnpaidQuote(quote.request);
  await assert.rejects(buyGatewayOnce({ ...base, orderId: "expired-auth", quote: expiredQuote,
    approvedQuoteSha256: expiredQuote.paymentRequiredSha256, payeeVerification: {
      ...base.payeeVerification, now: now - 3600 } }), /not confirmed/);
  challenge = originalChallenge;
  assert.equal(paidCount, 0);
  const result = await buyGatewayOnce({ ...base, orderId: "purchase-1" });
  assert.equal(result.state, "server_ack_unverified");
  assert.equal(paidCount, 1);
  assert.equal(signCount, 1);
  assert.equal(unpaidCount, 8); // every preflight remains unpaid; one paid send, no retry
  const record = JSON.parse(readFileSync(join(dir, "order-purchase-1.json"), "utf8"));
  assert.equal(record.state, "server_ack_unverified");
  assert.ok(record.paymentHeader);
  await assert.rejects(buyGatewayOnce({ ...base, orderId: "purchase-1" }), /already attempted/);
  await assert.rejects(buyGatewayOnce({ ...base, orderId: "purchase-2" }), /same business request already attempted/);
  assert.equal(paidCount, 1);
  assert.equal(signCount, 1);
  omitReceipt = true;
  const secondQuote = await fetchUnpaidQuote({ ...quote.request, body: JSON.stringify({ task: "different local test" }) });
  const secondBase = { ...base, quote: secondQuote, approvedQuoteSha256: secondQuote.paymentRequiredSha256,
    approvedRequestSha256: digest(JSON.stringify(secondQuote.request)) };
  const uncertain = await buyGatewayOnce({ ...secondBase, orderId: "unknown-1" });
  assert.equal(uncertain.state, "sent_unknown");
  assert.equal(paidCount, 2);
  assert.equal(signCount, 2);
  await assert.rejects(buyGatewayOnce({ ...secondBase, orderId: "unknown-2" }), /same business request already attempted/);
  assert.equal(paidCount, 2);
  assert.equal(signCount, 2);
  for (const headers of [{ Authorization: "Bearer secret" }, { Cookie: "secret=1" }, { "x-api-key": "secret" }] as Record<string, string>[]) {
    await assert.rejects(fetchUnpaidQuote({ url, method: "GET", headers }), /not safe to persist/);
  }
  console.log("PASS Gateway buyer: approved 402, confirmed payee, one send per order, unknown receipt hold, journal and credential guards");
} finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
