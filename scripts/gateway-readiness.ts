/** Read-only Arc Gateway and QuickNode preflight. Never signs, approves, deposits, or pays. */
import { createPublicClient, erc20Abi, formatUnits, getAddress, http, isAddress } from "viem";
import { fetchUnpaidQuote, verifyObservedQuote } from "../src/x402/quote.js";

const walletArg = process.argv[2];
if (!walletArg || !isAddress(walletArg)) throw new Error("Pass the public Agent3 Arc wallet address");
const wallet = getAddress(walletArg);
const usdc = getAddress("0x3600000000000000000000000000000000000000");
const gateway = getAddress("0x0077777d7EBA4688BDeF3E311b846F25870A19B9");
const client = createPublicClient({ transport: http("https://rpc.testnet.arc.network", { timeout: 15_000 }) });
const chainId = await client.getChainId();
if (chainId !== 5042002) throw new Error(`Unexpected Arc RPC chain: ${chainId}`);
const [tokenBalance, gatewayAllowance] = await Promise.all([
  client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
  client.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [wallet, gateway] }),
]);

let gatewayBalance: unknown;
let gatewayBalanceError: string | undefined;
try {
  const response = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ depositor: wallet, domain: 26 }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Gateway API HTTP ${response.status}`);
  gatewayBalance = await response.json();
} catch (error) { gatewayBalanceError = error instanceof Error ? error.message : String(error); }

const request = { url: "https://x402.quicknode.com/arc-testnet", method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) };
let quicknode: unknown;
let quicknodeError: string | undefined;
try {
  const quote = await fetchUnpaidQuote(request);
  const verified = await verifyObservedQuote(quote);
  quicknode = { observedAt: quote.observedAt, headerSha256: quote.paymentRequiredSha256,
    offers: verified.filter(({ offer }) => offer.network === "eip155:5042002" && offer.asset === usdc)
      .map(({ offer, verification }) => ({ amountAtomicUsdc: offer.amount, amountUsdc: formatUnits(BigInt(offer.amount), 6),
        payTo: offer.payTo, verdict: verification.verdict, reason: verification.reason,
        route: (offer.extra as Record<string, unknown> | undefined)?.name })) };
} catch (error) { quicknodeError = error instanceof Error ? error.message : String(error); }

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), wallet, chainId,
  erc20Usdc: formatUnits(tokenBalance, 6), gatewayAllowanceUsdc: formatUnits(gatewayAllowance, 6),
  gatewayBalance, gatewayBalanceError, quicknode, quicknodeError,
  action: "read_only_no_signature_no_deposit_no_payment" }, null, 2));
