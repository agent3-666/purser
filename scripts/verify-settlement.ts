/** Read-only proof of the one public Arc testnet Gateway batch entry. No wallet or signature is loaded. */
import assert from "node:assert/strict";
import { createPublicClient, decodeFunctionData, getAddress, hexToBigInt, http, parseAbi } from "viem";

const transferId = "fe8230bb-4618-48c9-9898-43ca041043f1";
const buyer = getAddress("0xC1fF46183e6f92642b8Bb3fA3fc73b32B22AFdED");
const payee = getAddress("0xF46394adDdA95A3d5bCC1124605E3d15D204623C");
const gateway = getAddress("0x0077777d7EBA4688BDeF3E311b846F25870A19B9");
const usdc = getAddress("0x3600000000000000000000000000000000000000");
const amount = 100n;
const expectedHash = "0x333a1462e1be41002bc569ebf98ac68d2eb6fa8caf521d72962be6e1025b22db";
const url = `https://gateway-api-testnet.circle.com/v1/x402/transfers/${transferId}`;
const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
assert.equal(response.status, 200, "Circle Gateway transfer lookup must succeed");
const transfer = await response.json() as Record<string, unknown>;
assert.equal(transfer.id, transferId);
assert.equal(transfer.status, "completed");
assert.equal(transfer.sendingNetwork, "eip155:5042002");
assert.equal(transfer.recipientNetwork, "eip155:5042002");
assert.equal(getAddress(String(transfer.fromAddress)), buyer);
assert.equal(getAddress(String(transfer.toAddress)), payee);
assert.equal(transfer.amount, amount.toString());
assert.match(String(transfer.txHash), /^0x[0-9a-f]{64}$/i);
assert.equal(String(transfer.txHash).toLowerCase(), expectedHash, "historical transfer must retain its observed transaction");

const client = createPublicClient({ transport: http("https://rpc.testnet.arc.network", { timeout: 15_000 }) });
assert.equal(await client.getChainId(), 5042002, "Arc testnet chain id");
const hash = transfer.txHash as `0x${string}`;
const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
assert.equal(receipt.status, "success");
assert.equal(tx.hash.toLowerCase(), expectedHash);
assert.equal(receipt.transactionHash.toLowerCase(), expectedHash);
assert.equal(tx.blockHash, receipt.blockHash, "transaction and receipt must refer to the same block");
assert.equal(tx.blockNumber, receipt.blockNumber);
assert.equal(getAddress(tx.to ?? ""), gateway);
const decoded = decodeFunctionData({ abi: parseAbi(["function submitBatch(bytes calldataBytes, bytes signature)"]), data: tx.input });
assert.equal(decoded.functionName, "submitBatch");
const calldata = decoded.args[0].slice(2);
const word = (i: number) => calldata.slice(i * 64, (i + 1) * 64);
const integer = (i: number, signed = false) => hexToBigInt(`0x${word(i)}`, { signed });
const address = (i: number) => getAddress(`0x${word(i).slice(24)}`);
assert.equal(Number(integer(2)), 26, "Arc testnet Gateway domain");
assert.equal(address(3), usdc);
assert.equal(address(4), gateway);
const count = Number(integer(5));
assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 1000);
assert.equal(calldata.length, (6 + 2 * count) * 64, "only the observed batch layout is supported; schema changes require review");
const entries = Array.from({ length: count }, (_, i) => ({ address: address(6 + i * 2), delta: integer(7 + i * 2, true) }));
assert.equal(entries.reduce((total, entry) => total + entry.delta, 0n), 0n, "batch debits and credits must balance");
assert.equal(entries.filter((entry) => entry.address === buyer && entry.delta === -amount).length, 1);
assert.equal(entries.filter((entry) => entry.address === payee && entry.delta === amount).length, 1);
console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), chainId: 5042002,
  scope: "historical_single_testnet_purchase_recheck", newPurchases: 0, externalUsersVerified: 0,
  transferId, circleStatus: transfer.status,
  transactionHash: hash, blockNumber: receipt.blockNumber.toString(), receiptStatus: receipt.status,
  gateway, domain: 26, token: usdc, batchId: `0x${word(1)}`, entryCount: count,
  buyer, buyerDeltaAtomic: (-amount).toString(), payee, payeeDeltaAtomic: amount.toString() }, null, 2));
