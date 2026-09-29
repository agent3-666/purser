/**
 * Execution-layer experiments on a local chain.
 *
 *   npx tsx experiments/executor.ts
 *
 * Starts anvil, funds nothing new (anvil's default account pays), and runs each scenario against a
 * fresh journal. "Exactly once" is measured from outside the executor: the payee's balance moved by
 * the amount once, and the paying account's mined nonce moved by one. The journal's own opinion is
 * not the measurement.
 *
 * Arc's native currency is USDC, so a native transfer on this chain models Arc's direct payment path.
 */

import { spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CrashForTest, Executor, type CrashPoint, type ExecutorOptions, type Policy } from "../src/executor/executor.js";
import { Journal, type OrderState } from "../src/executor/journal.js";
import { buildPurchaseProposal, recommendPurchase, type PurchaseNeed, type PurchaseOffer } from "../src/purchasing/recommend.js";

// anvil's first default account. A public test key; it never holds anything real.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PORT = 8545 + Math.floor(Math.random() * 1000);
const chain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } },
});
const transport = http(`http://127.0.0.1:${PORT}`);
const publicClient = createPublicClient({ chain, transport });
const account = privateKeyToAccount(ANVIL_KEY);
const walletClient = createWalletClient({ chain, transport, account });

export interface ExecResult {
  id: string;
  what: string;
  guard: string | null;
  expected: string;
  got: string;
  pass: boolean;
}

async function startAnvil(): Promise<ChildProcess> {
  const p = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await publicClient.getBlockNumber();
      return p;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
}

const rpc = (method: string, params: unknown[] = []) =>
  fetch(`http://127.0.0.1:${PORT}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());

const policy = (over: Partial<Policy> = {}): Policy => ({
  perTxCapWei: parseEther("1"),
  dailyCapWei: parseEther("3"),
  humanAllowlist: new Set(),
  ...over,
});

const NOW = () => Math.floor(Date.now() / 1000);

function order(id: string, payTo: Address, amount = "0.1", extra: Partial<{ verdict: "confirmed" | "unconfirmed" | "rejected"; max: string; validBefore: number }> = {}) {
  return {
    id,
    purpose: "experiment",
    resource: "http://seller.local/v1/search",
    payTo,
    amountWei: parseEther(amount).toString(),
    maxAmountWei: parseEther(extra.max ?? amount).toString(),
    validBefore: extra.validBefore ?? NOW() + 600,
    payeeVerdict: extra.verdict ?? ("confirmed" as const),
    needId: `need-${id}`,
    requestHash: "0x" + "00".repeat(32),
  };
}

async function measure<T>(payTo: Address, run: () => Promise<T>) {
  const before = await publicClient.getBalance({ address: payTo });
  const n0 = await publicClient.getTransactionCount({ address: account.address, blockTag: "latest" });
  const out = await run();
  await rpc("evm_mine");
  const after = await publicClient.getBalance({ address: payTo });
  const n1 = await publicClient.getTransactionCount({ address: account.address, blockTag: "latest" });
  return { out, received: after - before, sent: n1 - n0 };
}

export async function runExecutorExperiments(): Promise<ExecResult[]> {
  const anvil = await startAnvil();
  const results: ExecResult[] = [];
  const dirs: string[] = [];
  const fresh = (p: Policy = policy(), crashAt?: CrashPoint, j?: Journal) => {
    let journal = j;
    if (!journal) {
      const d = mkdtempSync(join(tmpdir(), "purser-"));
      dirs.push(d);
      journal = new Journal(d);
    }
    return new Executor({ journal, policy: p, publicClient: publicClient as never, walletClient, crashAt, receiptTimeoutMs: 3000 });
  };
  const record = (id: string, what: string, guard: string | null, expected: string, got: string) =>
    results.push({ id, what, guard, expected, got, pass: expected === got });
  const payee = () => privateKeyToAccount(generatePrivateKey()).address;
  const once = (m: { received: bigint; sent: number }, amount = "0.1") =>
    m.received === parseEther(amount) && m.sent === 1 ? "paid exactly once" : `received ${m.received} wei, ${m.sent} tx sent`;

  try {
    // X1 normal path
    {
      const ex = fresh(); const to = payee();
      const need: PurchaseNeed = { id: "need-x1", resourceKind: "web_search", billingUnit: "per_request",
        requiredCapabilities: ["web_results"], maxAmountWei: parseEther("0.1").toString(), minimumOfferLifetimeSeconds: 30 };
      const offer: PurchaseOffer = { id: "quote-x1", sellerId: "local-seller", payTo: to,
        resource: "http://seller.local/v1/search", resourceKind: "web_search", billingUnit: "per_request",
        capabilities: ["web_results"], amountWei: parseEther("0.1").toString(), validBefore: NOW() + 600,
        payeeVerdict: "confirmed" };
      const decision = await recommendPurchase(need, [offer], async () => ({ offerId: "quote-x1", reason: "only qualified quote" }), NOW());
      const m = await measure(to, async () => {
        ex.propose(buildPurchaseProposal(decision, need, [offer], NOW(), "x1", `0x${"00".repeat(32)}`));
        return ex.execute("x1");
      });
      record("X1", "qualified model proposal reaches local-chain executor", null, "paid exactly once / settled", `${once(m)} / ${m.out.state}`);
    }
    // X1b a model that selects an excluded, cheap quote must not reach signing.
    {
      const ex = fresh(); const to = payee();
      const need: PurchaseNeed = { id: "need-x1b", resourceKind: "web_search", billingUnit: "per_request",
        requiredCapabilities: ["web_results"], maxAmountWei: parseEther("0.1").toString(), minimumOfferLifetimeSeconds: 30 };
      const good: PurchaseOffer = { id: "good-x1b", sellerId: "local-seller", payTo: to,
        resource: "http://seller.local/v1/search", resourceKind: "web_search", billingUnit: "per_request",
        capabilities: ["web_results"], amountWei: parseEther("0.1").toString(), validBefore: NOW() + 600,
        payeeVerdict: "confirmed" };
      const bad: PurchaseOffer = { ...good, id: "bad-x1b", amountWei: "1", payeeVerdict: "rejected" };
      const decision = await recommendPurchase(need, [good, bad], async () => ({ offerId: bad.id, reason: "cheapest" }), NOW());
      const m = await measure(to, async () => {
        assert.equal(decision.modelRejectedReason, "ineligible_offer");
        assert.throws(() => ex.propose(buildPurchaseProposal(decision, need, [good, bad], NOW(), "x1b", `0x${"00".repeat(32)}`)), /no valid purchase decision/);
        return false;
      });
      record("X1b", "rejected model choice cannot create a payable order", null,
        "nothing sent / no order", `${m.received === 0n && m.sent === 0 ? "nothing sent" : "payment occurred"} / ${m.out ? "order exists" : "no order"}`);
    }
    // X2 crash after signing, before any broadcast; a new process recovers
    {
      const ex = fresh(policy(), "after-sign"); const to = payee();
      const m = await measure(to, async () => {
        ex.propose(order("x2", to));
        await ex.execute("x2").catch((e) => { if (!(e instanceof CrashForTest)) throw e; });
        const again = new Executor({ ...(ex as unknown as { o: ExecutorOptions }).o, crashAt: undefined });
        return (await again.recoverAll())[0];
      });
      record("X2", "crash after signing, recovered by a new process", null, "paid exactly once / settled", `${once(m)} / ${m.out?.state}`);
    }
    // X3 crash between broadcast and recording it
    {
      const ex = fresh(policy(), "after-broadcast-before-record"); const to = payee();
      const m = await measure(to, async () => {
        ex.propose(order("x3", to));
        await ex.execute("x3").catch((e) => { if (!(e instanceof CrashForTest)) throw e; });
        await rpc("evm_mine");
        const again = new Executor({ ...(ex as unknown as { o: ExecutorOptions }).o, crashAt: undefined });
        return (await again.recoverAll())[0] ?? again.execute("x3");
      });
      record("X3", "crash between broadcast and its record", "exec-persist-before-broadcast", "paid exactly once / settled", `${once(m)} / ${m.out?.state}`);
    }
    // X4 two executors pick up the same order at the same moment
    {
      const ex = fresh(); const to = payee();
      const twin = new Executor({ ...(ex as unknown as { o: ExecutorOptions }).o });
      const m = await measure(to, async () => {
        ex.propose(order("x4", to));
        const [a, b] = await Promise.all([ex.execute("x4"), twin.execute("x4")]);
        await rpc("evm_mine");
        return (await ex.execute("x4")) ?? a ?? b;
      });
      // Both sign the same nonce here, so the chain itself deduplicates: this does not test the lock.
      record("X4", "two executors run the same order at the same instant", null, "paid exactly once", once(m));
    }
    // X4b the interleaving the lock exists for: B broadcasts while A is between approving and choosing
    // a nonce, so A would pick the next nonce and sign a different transaction for the same order.
    {
      const d = mkdtempSync(join(tmpdir(), "purser-")); dirs.push(d);
      const journal = new Journal(d); const to = payee();
      let letAGo: () => void = () => {};
      const gate = new Promise<void>((r) => { letAGo = r; });
      const base = { journal, policy: policy(), publicClient: publicClient as never, walletClient, receiptTimeoutMs: 3000 };
      const A = new Executor({ ...base, pauseBeforeSign: () => gate });
      const B = new Executor(base);
      const m = await measure(to, async () => {
        A.propose(order("x4b", to));
        const aRun = A.execute("x4b");
        await new Promise((r) => setTimeout(r, 50)); // A now holds the order and waits before its nonce
        await B.execute("x4b");
        await rpc("evm_mine");
        letAGo();
        return aRun;
      });
      // Covered twice over (the order lock and the wallet section), so no single rule is credited.
      record("X4b", "second executor arrives while the first is choosing a nonce", null, "paid exactly once", once(m));
    }
    // X5 no receipt within the timeout (mining paused), then the chain catches up
    {
      const ex = fresh(); const to = payee();
      await rpc("evm_setAutomine", [false]);
      const m = await measure(to, async () => {
        ex.propose(order("x5", to));
        const first = await ex.execute("x5");
        const second = await ex.execute("x5"); // retry while still unknown
        await rpc("evm_setAutomine", [true]);
        await rpc("evm_mine");
        const last = await ex.execute("x5");
        return { first: first.state, second: second.state, last: last.state, broadcasts: last.broadcasts };
      });
      record("X5", "timeout with outcome unknown, retried, then mined", null, "paid exactly once / submitted,submitted,settled",
        `${once(m)} / ${m.out.first},${m.out.second},${m.out.last}`);
    }
    // X6 the signed nonce is consumed by a different transaction before ours is sent
    {
      const ex = fresh(policy(), "after-sign"); const to = payee();
      const m = await measure(to, async () => {
        ex.propose(order("x6", to));
        await ex.execute("x6").catch((e) => { if (!(e instanceof CrashForTest)) throw e; });
        // Something else with the same key uses that nonce.
        await walletClient.sendTransaction({ to: payee(), value: 1n, chain, account });
        await rpc("evm_mine");
        const again = new Executor({ ...(ex as unknown as { o: ExecutorOptions }).o, crashAt: undefined });
        return (await again.recoverAll())[0];
      });
      record("X6", "our nonce was used by another transaction", "exec-nonce-consumed-means-hold", "payee received 0 / held",
        `payee received ${m.received === 0n ? 0 : m.received} / ${m.out?.state}`);
    }
    // X7 payee rejected by the authorization check
    {
      const ex = fresh(); const to = payee();
      const m = await measure(to, async () => { ex.propose(order("x7", to, "0.1", { verdict: "rejected" })); return ex.execute("x7"); });
      record("X7", "payee authorization rejected", "exec-payee-verdict", "nothing sent / held", `${m.sent === 0 ? "nothing sent" : "SENT"} / ${m.out.state}`);
    }
    // X7b a rejected authorization must remain blocked even after a human tries to approve
    {
      const ex = fresh(); const to = payee();
      const m = await measure(to, async () => {
        ex.propose(order("x7b", to, "0.1", { verdict: "rejected" }));
        await ex.execute("x7b");
        ex.approveByHuman("x7b");
        return ex.execute("x7b");
      });
      record("X7b", "a human cannot override a rejected payee authorization", null,
        "nothing sent / held", `${m.sent === 0 ? "nothing sent" : "SENT"} / ${m.out.state}`);
    }
    // X8 payee unconfirmed, then a human allowlists it
    {
      const to = payee();
      const ex = fresh(policy({ humanAllowlist: new Set([to.toLowerCase()]) }));
      const m = await measure(to, async () => { ex.propose(order("x8", to, "0.1", { verdict: "unconfirmed" })); return ex.execute("x8"); });
      record("X8", "payee unconfirmed but on the human allowlist", null, "paid exactly once / settled", `${once(m)} / ${m.out.state}`);
    }
    // X8b missing authorization can be explicitly accepted by a human for this order
    {
      const ex = fresh(); const to = payee();
      const m = await measure(to, async () => {
        ex.propose(order("x8b", to, "0.1", { verdict: "unconfirmed" }));
        await ex.execute("x8b");
        ex.approveByHuman("x8b");
        return ex.execute("x8b");
      });
      record("X8b", "a human may approve an unconfirmed payee for one order", null,
        "paid exactly once / settled", `${once(m)} / ${m.out.state}`);
    }
    // X9 over the order's own cap
    {
      const ex = fresh(); const to = payee();
      const o = order("x9", to, "0.5"); o.maxAmountWei = parseEther("0.2").toString();
      const m = await measure(to, async () => { ex.propose(o); return ex.execute("x9"); });
      record("X9", "amount above the order's cap", "exec-order-cap", "nothing sent / failed", `${m.sent === 0 ? "nothing sent" : "SENT"} / ${m.out.state}`);
    }
    // X10 over the per-transaction limit
    {
      const ex = fresh(); const to = payee();
      const m = await measure(to, async () => { ex.propose(order("x10", to, "2", { max: "2" })); return ex.execute("x10"); });
      record("X10", "amount above the per-transaction limit", "exec-per-tx-cap", "nothing sent / held", `${m.sent === 0 ? "nothing sent" : "SENT"} / ${m.out.state}`);
    }
    // X11 the daily limit, across several orders
    {
      const ex = fresh(policy({ dailyCapWei: parseEther("0.25") })); const to = payee();
      const m = await measure(to, async () => {
        for (const id of ["x11a", "x11b", "x11c"]) { ex.propose(order(id, to)); await ex.execute(id); }
        return ex["o"].journal.get("x11c")!;
      });
      record("X11", "third order would exceed the daily limit", "exec-daily-cap", "2 paid / failed",
        `${m.sent === 2 ? "2" : m.sent} paid / ${m.out.state}`);
    }
    // X12 the offer expired before signing
    {
      const ex = fresh(); const to = payee();
      const m = await measure(to, async () => { ex.propose(order("x12", to, "0.1", { validBefore: NOW() - 1 })); return ex.execute("x12"); });
      record("X12", "offer expired before signing", "exec-offer-expiry", "nothing sent / failed", `${m.sent === 0 ? "nothing sent" : "SENT"} / ${m.out.state}`);
    }
    // X14 two different order ids for the same need and the same request
    {
      const ex = fresh(); const to = payee();
      const m = await measure(to, async () => {
        const a = order("x14a", to); a.needId = "need-shared";
        const b = order("x14b", to); b.needId = "need-shared";
        ex.propose(a); await ex.execute("x14a");
        ex.propose(b); return ex.execute("x14b");
      });
      record("X14", "a second order id for something already bought", "exec-business-dedupe", "paid exactly once / failed", `${once(m)} / ${m.out.state}`);
    }
    // X15 two different needs whose sum crosses the daily limit, arriving together
    {
      const d = mkdtempSync(join(tmpdir(), "purser-")); dirs.push(d);
      const journal = new Journal(d); const to = payee();
      let letAGo: () => void = () => {};
      const gate = new Promise<void>((r) => { letAGo = r; });
      const base = { journal, policy: policy({ dailyCapWei: parseEther("0.15") }), publicClient: publicClient as never, walletClient, receiptTimeoutMs: 3000 };
      const A = new Executor({ ...base, pauseBeforeSign: () => gate });
      const B = new Executor(base);
      const m = await measure(to, async () => {
        A.propose(order("x15a", to)); B.propose(order("x15b", to));
        const aRun = A.execute("x15a");
        await new Promise((r) => setTimeout(r, 50)); // A is approved and about to sign
        setTimeout(() => letAGo(), 300);
        const b = await B.execute("x15b");
        await aRun;
        return b;
      });
      record("X15", "two orders together would cross the daily limit", "exec-wallet-critical-section", "paid exactly once / failed", `${once(m)} / ${m.out.state}`);
    }
    // X16 two different, affordable orders signed at the same time on one wallet
    {
      const d = mkdtempSync(join(tmpdir(), "purser-")); dirs.push(d);
      const journal = new Journal(d); const to = payee();
      let letAGo: () => void = () => {};
      const gate = new Promise<void>((r) => { letAGo = r; });
      const base = { journal, policy: policy(), publicClient: publicClient as never, walletClient, receiptTimeoutMs: 3000 };
      // Both wait on the same gate, so without serialization both would read the same free nonce.
      const A = new Executor({ ...base, pauseBeforeSign: () => gate });
      const B = new Executor({ ...base, pauseBeforeSign: () => gate });
      const m = await measure(to, async () => {
        A.propose(order("x16a", to)); B.propose(order("x16b", to));
        const aRun = A.execute("x16a");
        const bRun = B.execute("x16b");
        setTimeout(() => letAGo(), 200);
        const [a, b] = await Promise.all([aRun, bRun]);
        await rpc("evm_mine");
        return `${(await A.execute("x16a")).state},${(await B.execute("x16b")).state}`;
      });
      record("X16", "two different orders on one wallet at the same time", "exec-wallet-critical-section", "both settled, 2 tx",
        `${m.out === "settled,settled" ? "both settled" : m.out}, ${m.sent} tx`);
    }
    // X13 the model proposes the same order twice
    {
      const ex = fresh(); const to = payee();
      const m = await measure(to, async () => {
        ex.propose(order("x13", to)); await ex.execute("x13");
        ex.propose(order("x13", to)); return ex.execute("x13");
      });
      record("X13", "the same order proposed and executed twice", null, "paid exactly once", once(m));
    }
  } finally {
    anvil.kill();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await runExecutorExperiments();
  const w = Math.max(...results.map((r) => r.what.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(4)} ${r.what.padEnd(w)}  ${r.got}${r.pass ? "" : `   (expected ${r.expected})`}`);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const outDir = new URL("../out/", import.meta.url).pathname;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}executor-experiments.json`, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios behaved as specified`);
  process.exit(failed ? 1 : 0);
}
