/**
 * The execution layer. The model proposes purchase orders; only this module can sign.
 *
 * Before signing it checks, independently of whatever the model said: the order was approved, the
 * payee verdict allows it, the amount is inside the order's cap and the per-transaction and daily
 * limits, and the offer has not expired. Then it signs once, writes the signed bytes to the journal,
 * and only then broadcasts.
 *
 * Recovery never signs again. An order left in `signed` or `submitted` is reconciled against the
 * chain: a receipt settles it; a transaction still in the mempool waits; a nonce already consumed by
 * something else holds it for a human; otherwise the same signed bytes are sent again, which cannot
 * pay twice because their nonce is fixed.
 */

import type { Address, Hex, PublicClient, WalletClient, Chain, Transport, Account } from "viem";
import { Journal, type PurchaseOrder } from "./journal.js";

export interface Policy {
  perTxCapWei: bigint;
  dailyCapWei: bigint;
  /** Payees a human has approved even though their authorization could not be confirmed. */
  humanAllowlist: Set<string>;
}

export type CrashPoint = "after-sign" | "after-broadcast-before-record" | "after-broadcast";

export interface ExecutorOptions {
  journal: Journal;
  policy: Policy;
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  now?: () => number;
  receiptTimeoutMs?: number;
  /** Test hook: throw at this point to simulate a crash. */
  crashAt?: CrashPoint;
  /** Test hook: awaited just before a nonce is chosen, to force an interleaving. */
  pauseBeforeSign?: () => Promise<void>;
}

export class CrashForTest extends Error {}

const FINAL = new Set(["settled", "failed", "held"]);

/** Two orders are for the same thing when they share the need, the resource and the request. */
export function businessKey(o: Pick<PurchaseOrder, "needId" | "resource" | "requestHash">): string {
  return `${o.needId}|${o.resource}|${o.requestHash}`;
}

export class Executor {
  constructor(private readonly o: ExecutorOptions) {}

  private now() {
    return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000);
  }

  /** The model's side of the boundary: it may only write a proposal. */
  propose(input: Omit<PurchaseOrder, "state" | "broadcasts" | "history">): PurchaseOrder {
    const existing = this.o.journal.get(input.id);
    if (existing) return existing; // the same order proposed twice is the same order
    const order: PurchaseOrder = { ...input, state: "proposed", broadcasts: 0, history: [] };
    this.o.journal.put(order, "proposed");
    return order;
  }

  approveByHuman(id: string): void {
    const order = this.o.journal.get(id);
    if (!order || order.state !== "held" || order.signed) return; // never un-hold a signed order
    // A human may accept missing evidence, not contradictory evidence or a breached spending limit.
    if (order.payeeVerdict !== "unconfirmed") return;
    order.state = "approved";
    order.approvedBy = "human";
    this.o.journal.put(order, "approved by a human");
  }

  /**
   * Money already committed today. Only signed orders count: the wallet section guarantees no other
   * order on this wallet is between approval and signing while this one is being checked, which is
   * what makes this a reservation rather than a race.
   */
  private spentToday(excludeId: string): bigint {
    const since = this.now() - 86_400;
    return this.o.journal
      .all()
      .filter((x) => x.id !== excludeId && x.signed !== undefined && x.state !== "failed")
      .filter((x) => Date.parse(x.history[0].at) / 1000 >= since)
      .reduce((sum, x) => sum + BigInt(x.amountWei), 0n);
  }

  private nextNonce(from: Address, chainPending: number): number {
    let n = chainPending;
    for (const x of this.o.journal.all()) {
      if (x.signed && x.signed.from.toLowerCase() === from.toLowerCase() && !FINAL.has(x.state)) {
        n = Math.max(n, x.signed.nonce + 1);
      }
    }
    return n;
  }

  /** Why this order may not be signed, or null if it may. Checked fresh every time. */
  refusal(order: PurchaseOrder): string | null {
    const p = this.o.policy;
    const amount = BigInt(order.amountWei);
    let payeeRefused = false;
    payeeRefused = order.payeeVerdict === "rejected" || (order.payeeVerdict === "unconfirmed" && !p.humanAllowlist.has(order.payTo.toLowerCase())); // GUARD:exec-payee-verdict
    if (payeeRefused) return `payee ${order.payeeVerdict}`;
    let overOrderCap = false;
    overOrderCap = amount > BigInt(order.maxAmountWei); // GUARD:exec-order-cap
    if (overOrderCap) return "amount exceeds the order's cap";
    let overPerTx = false;
    overPerTx = amount > p.perTxCapWei; // GUARD:exec-per-tx-cap
    if (overPerTx) return "amount exceeds the per-transaction limit";
    let overDaily = false;
    overDaily = this.spentToday(order.id) + amount > p.dailyCapWei; // GUARD:exec-daily-cap
    if (overDaily) return "amount would exceed the daily limit";
    let stale = false;
    stale = this.now() >= order.validBefore; // GUARD:exec-offer-expiry
    if (stale) return "the offer has expired";
    const key = businessKey(order);
    const twin = this.o.journal.all().find((x) => x.id !== order.id && businessKey(x) === key && x.state !== "failed" && x.state !== "proposed");
    let duplicate = false;
    duplicate = twin !== undefined; // GUARD:exec-business-dedupe
    if (duplicate) return `duplicate of order ${twin!.id}, which bought the same thing`;
    return null;
  }

  async execute(id: string): Promise<PurchaseOrder> {
    // Defence in depth, not the guarantee: the wallet section below already makes a second executor on
    // the same order find it signed. This lock only saves it the wait.
    const release = this.o.journal.lock(id);
    if (!release) return this.o.journal.get(id)!; // someone else is working it; leave it alone
    try {
      let order = this.o.journal.get(id);
      if (!order) throw new Error(`no order ${id}`);
      if (FINAL.has(order.state) && order.state !== "held") return order;

      if (order.state === "proposed" || order.state === "approved") {
        // Checking the budget and choosing a nonce must not interleave with another order on the same
        // wallet, or two orders can both see room in the budget, or both see the same free nonce.
        const releaseWallet = await this.walletSection();
        try {
          order = this.o.journal.get(id)!;
          order = await this.approveAndSign(order);
        } finally {
          releaseWallet();
        }
      }

      if (order.state === "signed" || order.state === "submitted") {
        order = await this.reconcile(order);
      }
      return order;
    } finally {
      release?.();
    }
  }

  private async walletSection(): Promise<() => void> {
    let serialize = false;
    serialize = true; // GUARD:exec-wallet-critical-section
    if (!serialize) return () => {};
    const name = `wallet-${this.o.walletClient.account.address.toLowerCase()}`;
    for (let i = 0; i < 600; i++) {
      const release = this.o.journal.lock(name);
      if (release) return release;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("could not enter the wallet section within 15s");
  }

  private async approveAndSign(order: PurchaseOrder): Promise<PurchaseOrder> {
      if (order.state === "proposed") {
        const why = this.refusal(order);
        if (why) {
          order.state = why.startsWith("payee") || why.includes("per-transaction") ? "held" : "failed";
          this.o.journal.put(order, `not approved: ${why}`);
          return order;
        }
        order.state = "approved";
        order.approvedBy = "policy";
        this.o.journal.put(order, "approved by policy");
      }

      if (order.state === "approved") {
        const why = this.refusal(order);
        if (why && !(order.approvedBy === "human" && order.payeeVerdict === "unconfirmed" && why === "payee unconfirmed")) {
          order.state = "failed";
          this.o.journal.put(order, `refused at signing: ${why}`);
          return order;
        }
        order = await this.sign(order);
      }
      return order;
  }

  private async sign(order: PurchaseOrder): Promise<PurchaseOrder> {
    const wallet = this.o.walletClient;
    const from = wallet.account.address;
    if (this.o.pauseBeforeSign) await this.o.pauseBeforeSign();
    const pending = await this.o.publicClient.getTransactionCount({ address: from, blockTag: "pending" });
    const nonce = this.nextNonce(from, pending);
    const request = await wallet.prepareTransactionRequest({
      to: order.payTo,
      value: BigInt(order.amountWei),
      nonce,
      chain: wallet.chain,
      account: wallet.account,
    });
    const raw = (await wallet.signTransaction(request as never)) as Hex;
    const { keccak256 } = await import("viem");
    order.signed = { from, nonce, hash: keccak256(raw), raw };
    order.state = "signed";
    this.o.journal.put(order, `signed once, nonce ${nonce}; written before any broadcast`); // GUARD:exec-persist-before-broadcast
    if (this.o.crashAt === "after-sign") throw new CrashForTest("crash after sign");
    return order;
  }

  private async reconcile(order: PurchaseOrder): Promise<PurchaseOrder> {
    const pc = this.o.publicClient;
    const s = order.signed!;

    const receipt = await pc.getTransactionReceipt({ hash: s.hash }).catch(() => null);
    if (receipt) return this.settle(order, receipt.blockNumber, receipt.status);

    const inPool = await pc.getTransaction({ hash: s.hash }).catch(() => null);
    if (!inPool) {
      const mined = await pc.getTransactionCount({ address: s.from, blockTag: "latest" });
      let consumed = false;
      consumed = mined > s.nonce; // GUARD:exec-nonce-consumed-means-hold
      if (consumed) {
        order.state = "held";
        this.o.journal.put(order, `nonce ${s.nonce} was used by another transaction and ours has no receipt; not re-signing`);
        return order;
      }
      // The same bytes, never a new signature.
      await pc.sendRawTransaction({ serializedTransaction: s.raw }).catch((e: Error) => {
        if (!/already known|nonce too low|known transaction/i.test(e.message)) throw e;
      });
      if (this.o.crashAt === "after-broadcast-before-record") throw new CrashForTest("crash between broadcast and its record");
      order.broadcasts += 1;
      order.state = "submitted";
      this.o.journal.put(order, `broadcast #${order.broadcasts} of the same signed bytes`);
      if (this.o.crashAt === "after-broadcast") throw new CrashForTest("crash after broadcast");
    }

    const final = await pc
      .waitForTransactionReceipt({ hash: s.hash, timeout: this.o.receiptTimeoutMs ?? 20_000 })
      .catch(() => null);
    if (final) return this.settle(order, final.blockNumber, final.status);
    order.state = "submitted";
    this.o.journal.put(order, "no receipt yet; will reconcile again, never re-sign");
    return order;
  }

  private settle(order: PurchaseOrder, blockNumber: bigint, status: "success" | "reverted"): PurchaseOrder {
    order.receipt = { blockNumber: blockNumber.toString(), status };
    order.state = status === "success" ? "settled" : "failed";
    this.o.journal.put(order, `receipt read back from the chain: ${status}`);
    return order;
  }

  /** Run after a restart: every order whose outcome is unknown is reconciled, none is re-signed. */
  async recoverAll(): Promise<PurchaseOrder[]> {
    const out: PurchaseOrder[] = [];
    for (const o of this.o.journal.all().filter((x) => x.state === "signed" || x.state === "submitted")) {
      out.push(await this.execute(o.id));
    }
    return out;
  }
}
