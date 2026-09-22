/**
 * The purchase journal: one file per purchase order, written before every step that has an effect
 * outside this process.
 *
 * The rule it exists for: a payment whose outcome is unknown is never paid again. The signed
 * transaction is written to disk before it is broadcast, so after a crash, a timeout or a second
 * process picking up the same order, the only thing that can ever be sent is those same signed bytes.
 * Their nonce is fixed, so sending them again cannot move money twice.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";

export type OrderState =
  | "proposed" // the model asked for it
  | "approved" // within policy, or a human approved it
  | "signed" // signed bytes are on disk; nothing has been broadcast yet, as far as this record knows
  | "submitted" // broadcast at least once; outcome not yet known
  | "settled" // receipt read back from the chain
  | "failed" // the chain says it did not happen, or policy refused it before signing
  | "held"; // outcome cannot be established; a human decides

export interface PurchaseOrder {
  id: string; // also the idempotency key
  purpose: string;
  /** The business need this buys for, from the requesting workflow, not from the model. */
  needId: string;
  resource: string;
  /** Hash of the request body being bought, so two orders for the same thing can be recognized. */
  requestHash: string;
  payTo: Address;
  amountWei: string;
  maxAmountWei: string; // the most this order may ever spend
  validBefore: number; // the offer's expiry, unix seconds
  payeeVerdict: "confirmed" | "unconfirmed" | "rejected";
  state: OrderState;
  approvedBy?: "policy" | "human";
  signed?: { from: Address; nonce: number; hash: Hex; raw: Hex };
  broadcasts: number;
  receipt?: { blockNumber: string; status: "success" | "reverted" };
  history: Array<{ at: string; state: OrderState; note: string }>;
}

export class Journal {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string) {
    return join(this.dir, `${id}.json`);
  }

  get(id: string): PurchaseOrder | null {
    const p = this.path(id);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as PurchaseOrder) : null;
  }

  all(): PurchaseOrder[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as PurchaseOrder);
  }

  /** Durable write: temp file, fsync, rename. A crash leaves the old record or the new one. */
  put(order: PurchaseOrder, note: string): void {
    order.history.push({ at: new Date().toISOString(), state: order.state, note });
    const tmp = `${this.path(order.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(order, null, 2));
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.path(order.id));
  }

  /**
   * An exclusive claim on one order, so two executors cannot both work it. O_EXCL makes creation
   * atomic on the filesystem; the loser gets null and leaves the order alone.
   */
  lock(id: string): (() => void) | null {
    const p = join(this.dir, `${id}.lock`);
    try {
      closeSync(openSync(p, "wx"));
    } catch {
      return null;
    }
    return () => rmSync(p, { force: true });
  }
}
