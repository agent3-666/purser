/** Read-only diagnostic: identify fields that change between consecutive QuickNode 402s. */
import { fetchUnpaidQuote } from "../src/x402/quote.js";
const request = { url: "https://x402.quicknode.com/arc-testnet", method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) };
const first = await fetchUnpaidQuote(request);
const second = await fetchUnpaidQuote(request);
const a = JSON.parse(Buffer.from(first.paymentRequiredHeader, "base64").toString("utf8"));
const b = JSON.parse(Buffer.from(second.paymentRequiredHeader, "base64").toString("utf8"));
function diff(x: unknown, y: unknown, path = "$", out: string[] = []): string[] {
  if (JSON.stringify(x) === JSON.stringify(y)) return out;
  if (x && y && typeof x === "object" && typeof y === "object") {
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)]))
      diff((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], `${path}.${key}`, out);
  } else out.push(path);
  return out;
}
console.log(JSON.stringify({ firstSha256: first.paymentRequiredSha256,
  secondSha256: second.paymentRequiredSha256, differentFields: diff(a, b) }, null, 2));
