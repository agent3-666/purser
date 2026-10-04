/** Independent, objective check for an Arc block-height RPC purchase. */
export interface BlockHeightReview {
  outcome: "pass" | "fail";
  paidHeight: string | null;
  referenceHeight: string;
  difference: string | null;
  reason?: "invalid_paid_response" | "stale_or_future";
}

function parseHeight(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

export function verifyArcBlockHeight(paidBody: Uint8Array, referenceHeightHex: string, maxLagBlocks = 10n): BlockHeightReview {
  const reference = parseHeight(referenceHeightHex);
  if (reference === null || maxLagBlocks < 0n) throw new Error("invalid independent reference height");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(paidBody)); }
  catch { parsed = null; }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : null;
  const paid = record && record.jsonrpc === "2.0" && !Object.hasOwn(record, "error")
    ? parseHeight(record.result) : null;
  if (paid === null) return { outcome: "fail", paidHeight: null, referenceHeight: referenceHeightHex,
    difference: null, reason: "invalid_paid_response" };
  const difference = reference - paid;
  if (difference > maxLagBlocks || difference < -2n) return { outcome: "fail", paidHeight: `0x${paid.toString(16)}`,
    referenceHeight: referenceHeightHex, difference: difference.toString(), reason: "stale_or_future" };
  return { outcome: "pass", paidHeight: `0x${paid.toString(16)}`, referenceHeight: referenceHeightHex,
    difference: difference.toString() };
}

/** Query Arc's public RPC separately from the paid provider; never sign or send funds. */
export async function fetchIndependentArcHeight(rpcUrl = "https://rpc.testnet.arc.network"): Promise<string> {
  const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`independent Arc RPC returned HTTP ${response.status}`);
  const value = (await response.json()) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
  if (!value || value.jsonrpc !== "2.0" || value.id !== 1 || Object.hasOwn(value, "error") ||
      parseHeight(value.result) === null) throw new Error("independent Arc RPC returned no valid block height");
  return value.result as string;
}
