/** Read-only, unpaid probe of publicly documented Arc-testnet x402 candidates. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { captureUnpaid402, parsePaymentRequired, verifyObservedQuote, type UnpaidRequest, type ObservedQuote } from "../src/x402/quote.js";
import { PayeeLedger } from "../src/payee-auth/ledger.js";

const candidates: Array<{ task: string; source: string; request: UnpaidRequest }> = [
  {
    task: "Check Agent3's Arc-testnet block height through a paid RPC provider",
    source: "https://www.quicknode.com/docs/build-with-ai/x402-payments",
    request: { url: "https://x402.quicknode.com/arc-testnet", method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) },
  },
  {
    task: "Obtain an independent risk memo on x402 payee mismatch for Agent3 Purser",
    source: "https://github.com/UnityNodes/arc-guard-agent",
    request: { url: "https://api.guardagent.org/api/infer", method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "For Agent3 Purser, explain two risks when an x402 payTo differs from a catalog address. Clearly distinguish observed facts from possible causes." }) },
  },
  {
    task: "Check Arc whale activity from public blockchain data",
    source: "https://agentpay.bond/docs",
    request: { url: "https://api.agentpay.bond/whales", method: "GET", headers: { accept: "application/json" } },
  },
];
const results = [];
for (const candidate of candidates) {
  try {
    const raw = await captureUnpaid402(candidate.request);
    let quote: ObservedQuote;
    try { quote = { ...raw, offers: parsePaymentRequired(raw.paymentRequiredHeader, new URL(candidate.request.url).href) }; }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      results.push({ ...candidate, raw402: raw, error });
      console.log(candidate.request.url, "402 but not usable:", error);
      continue;
    }
    const verification = await verifyObservedQuote(quote, { ledger: new PayeeLedger(null) });
    results.push({ ...candidate, quote, verification });
    console.log(candidate.request.url, "402", verification.map((v) => `${v.offer.network}:${v.offer.amount}:${v.verification.verdict}`).join(","));
  } catch (e) {
    results.push({ ...candidate, error: e instanceof Error ? e.message : String(e) });
    console.log(candidate.request.url, "not usable:", e instanceof Error ? e.message : String(e));
  }
}
const path = join(dirname(fileURLToPath(import.meta.url)), "live_quotes_2026-09-29.json");
writeFileSync(path, JSON.stringify({ observedAt: new Date().toISOString(), paymentAttempted: false, results },
  (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
console.log("saved", path);
