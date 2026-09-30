/** One-shot, fail-closed Arc testnet Gateway deposit for the approved 0.01 test USDC pilot. */
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const walletFile = process.env.AGENT3_WALLET_FILE;
const expectedAddress = process.env.AGENT3_EXPECTED_WALLET;
if (!walletFile || !expectedAddress) throw new Error("Set isolated wallet file and expected public address");
const stateDir = fileURLToPath(new URL("../state", import.meta.url));
const journalPath = join(stateDir, "quicknode-gateway-deposit.json");
if (existsSync(journalPath)) throw new Error("Existing deposit journal; reconcile before doing anything else");
const raw = readFileSync(walletFile, "utf8");
const key = raw.match(/^private_key:\s*['"]?(0x[0-9a-fA-F]{64})['"]?\s*$/m)?.[1];
if (!key) throw new Error("Isolated wallet file has no valid private key");
const account = privateKeyToAccount(key as `0x${string}`);
if (account.address !== getAddress(expectedAddress)) throw new Error("Wrong wallet; no transaction sent");

const usdc = getAddress("0x3600000000000000000000000000000000000000");
const gateway = getAddress("0x0077777d7EBA4688BDeF3E311b846F25870A19B9");
const amount = 10_000n; // exactly 0.01 test USDC; do not turn into a standing approval
const transport = http("https://rpc.testnet.arc.network", { timeout: 15_000 });
const publicClient = createPublicClient({ chain: arcTestnet, transport });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport });
const depositAbi = parseAbi(["function deposit(address token, uint256 value)"]);
if (await publicClient.getChainId() !== 5042002) throw new Error("Wrong chain");
const [balance, allowance] = await Promise.all([
  publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, gateway] }),
]);
if (balance < amount || allowance !== 0n) throw new Error("Unexpected balance or pre-existing allowance; no transaction sent");
const response = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "USDC", sources: [{ depositor: account.address, domain: 26 }] }),
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Gateway balance unavailable: HTTP ${response.status}`);
const data = await response.json() as { balances?: { balance?: string; pendingBatch?: string }[] };
if (data.balances?.length !== 1 || data.balances[0].balance !== "0" || data.balances[0].pendingBatch !== "0") {
  throw new Error("Gateway already has funds or an unknown pending batch; no transaction sent");
}
await publicClient.simulateContract({ address: usdc, abi: erc20Abi, functionName: "approve",
  args: [gateway, amount], account });
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const save = (stage: string, txHash?: string) => writeFileSync(journalPath,
  JSON.stringify({ wallet: account.address, chainId: 5042002, amountAtomicUsdc: amount.toString(),
    stage, txHash, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
save("approval_prepared");
const approvalHash = await walletClient.writeContract({ address: usdc, abi: erc20Abi,
  functionName: "approve", args: [gateway, amount] });
save("approval_sent", approvalHash);
const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash, timeout: 60_000 });
if (approvalReceipt.status !== "success") throw new Error("Approval reverted; inspect journal");
save("approval_confirmed", approvalHash);
const actualAllowance = await publicClient.readContract({ address: usdc, abi: erc20Abi,
  functionName: "allowance", args: [account.address, gateway] });
if (actualAllowance !== amount) throw new Error("Approval amount differs from 0.01; inspect journal");
await publicClient.simulateContract({ address: gateway, abi: depositAbi, functionName: "deposit",
  args: [usdc, amount], account });
save("deposit_prepared", approvalHash);
const depositHash = await walletClient.writeContract({ address: gateway, abi: depositAbi,
  functionName: "deposit", args: [usdc, amount] });
save("deposit_sent", depositHash);
const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash, timeout: 60_000 });
if (depositReceipt.status !== "success") throw new Error("Deposit reverted; inspect journal");
save("deposit_confirmed", depositHash);
const remainingAllowance = await publicClient.readContract({ address: usdc, abi: erc20Abi,
  functionName: "allowance", args: [account.address, gateway] });
if (remainingAllowance !== 0n) throw new Error("Unexpected remaining allowance; inspect journal");
console.log(JSON.stringify({ wallet: account.address, amountTestUsdc: "0.01",
  approvalHash, depositHash, remainingAllowance: "0", state: "deposit_confirmed_not_yet_payment" }, null, 2));
