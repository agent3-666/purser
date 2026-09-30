/** One approved Arc testnet block-height purchase; never retries an uncertain payment. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { PayeeLedger } from "../src/payee-auth/ledger.js";
import { fetchUnpaidQuote, verifyObservedQuote } from "../src/x402/quote.js";
import { buyGatewayOnce } from "../src/x402/gateway-buyer.js";

const walletFile = process.env.AGENT3_WALLET_FILE;
if (!walletFile) throw new Error("Set the isolated Agent3 wallet file");
const raw = readFileSync(walletFile, "utf8");
const key = raw.match(/^private_key:\s*['"]?(0x[0-9a-fA-F]{64})['"]?\s*$/m)?.[1];
if (!key) throw new Error("Invalid isolated wallet file");
const signer = privateKeyToAccount(key as `0x${string}`);
if (signer.address !== getAddress("0xC1fF46183e6f92642b8Bb3fA3fc73b32B22AFdED")) {
  throw new Error("Wrong wallet; no payment attempted");
}
const publicClient = createPublicClient({ chain: arcTestnet,
  transport: http("https://rpc.testnet.arc.network", { timeout: 15_000 }) });
if (await publicClient.getChainId() !== 5042002) throw new Error("Wrong network");
const gatewayResponse = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "USDC", sources: [{ depositor: signer.address, domain: 26 }] }),
  signal: AbortSignal.timeout(15_000),
});
if (!gatewayResponse.ok) throw new Error(`Gateway balance HTTP ${gatewayResponse.status}`);
const gatewayData = await gatewayResponse.json() as { balances?: { balance?: string; pendingBatch?: string }[] };
if (gatewayData.balances?.length !== 1 || Number(gatewayData.balances[0].balance) < 0.01 ||
    Number(gatewayData.balances[0].pendingBatch) !== 0) throw new Error("Unexpected Gateway balance");

const request = { url: "https://x402.quicknode.com/arc-testnet", method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) };
const quote = await fetchUnpaidQuote(request);
const ledger = new PayeeLedger(fileURLToPath(new URL("../state/quicknode-payee-ledger.json", import.meta.url)));
const verified = await verifyObservedQuote(quote, { ledger });
const expectedPayee = getAddress("0xF46394adDdA95A3d5bCC1124605E3d15D204623C");
const matching = verified.filter(({ offer }) => offer.network === "eip155:5042002" &&
  offer.asset === getAddress("0x3600000000000000000000000000000000000000") &&
  offer.amount === "100" && offer.payTo === expectedPayee &&
  (offer.extra as Record<string, unknown> | undefined)?.name === "GatewayWalletBatched");
if (matching.length !== 1 || matching[0].verification.verdict !== "unconfirmed" ||
    JSON.stringify(matching[0].verification.reasons) !== JSON.stringify(["no_authorization"])) {
  throw new Error("Quote or payee evidence changed; no payment attempted");
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const requestSha256 = digest(JSON.stringify(quote.request));
const now = Math.floor(Date.now() / 1000);
const orderId = "quicknode_arc_block_20260930_one";
const exception = {
  exceptionId: "joey_quicknode_testnet_20260930_one",
  orderId, quoteSha256: quote.paymentRequiredSha256, requestSha256,
  sellerHost: "x402.quicknode.com", payTo: expectedPayee,
  amountAtomicUsdc: "100", unconfirmedReasons: ["no_authorization"],
  expiresAt: now + 300,
  reason: "Joey approved one QuickNode Arc testnet block-height request despite missing seller-signed payee authorization.",
};
console.log(JSON.stringify({ action: "one_testnet_purchase", orderId,
  seller: request.url, method: request.method, task: "eth_blockNumber",
  amountTestUsdc: "0.0001", payee: expectedPayee,
  payeeVerdict: "unconfirmed", reasons: exception.unconfirmedReasons,
  quoteSha256: quote.paymentRequiredSha256, requestSha256 }, null, 2));
const result = await buyGatewayOnce({ orderId, quote, approvedQuoteSha256: quote.paymentRequiredSha256,
  approvedRequestSha256: requestSha256, approvedPayTo: expectedPayee, maxAtomicAmount: 100n,
  dailyAtomicLimit: 100n, totalAtomicLimit: 100n,
  journalDir: fileURLToPath(new URL("../state/quicknode-one-order", import.meta.url)),
  signer, payeeVerification: { ledger }, unconfirmedPayeeException: exception });
let delivery: unknown;
try {
  const parsed = JSON.parse(result.bodyText) as { result?: unknown; error?: unknown };
  const paidHeight = typeof parsed.result === "string" && /^0x[0-9a-f]+$/i.test(parsed.result)
    ? Number(BigInt(parsed.result)) : null;
  const publicHeight = await publicClient.getBlockNumber();
  delivery = { paidHeight, publicHeight: Number(publicHeight),
    withinTolerance: paidHeight !== null && paidHeight >= Number(publicHeight) - 10 &&
      paidHeight <= Number(publicHeight) + 2,
    serverError: parsed.error ?? null };
} catch (error) { delivery = { error: error instanceof Error ? error.message : String(error) }; }
console.log(JSON.stringify({ paymentState: result.state, httpStatus: result.status,
  settlement: result.settlement, bodySha256: result.bodySha256, delivery }, null, 2));
