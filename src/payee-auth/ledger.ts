/**
 * The buyer's memory of every payee authorization it has acted on.
 *
 * This is the vendor-master change control: for each (seller identity, network, asset) it keeps the
 * highest rotation sequence seen and the address that sequence named, and it keeps every per-request
 * nonce already used. It is written to disk with write-then-rename, so a crash leaves either the old
 * file or the new one, never half of each.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";

interface Rotation {
  rotationSeq: string; // bigint as string, for JSON
  payTo: Address;
  firstSeenAt: string;
}

interface LedgerState {
  version: 1;
  rotations: Record<string, Rotation>;
  nonces: Record<string, string>; // `${sellerId}:${nonce}` -> first seen
}

export function rotationKey(sellerId: Address, network: string, asset: Address): string {
  return `${sellerId.toLowerCase()}|${network}|${asset.toLowerCase()}`;
}

export class PayeeLedger {
  private state: LedgerState;

  constructor(private readonly path: string | null) {
    this.state = { version: 1, rotations: {}, nonces: {} };
    if (path && existsSync(path)) {
      this.state = JSON.parse(readFileSync(path, "utf8")) as LedgerState;
    }
  }

  current(key: string): { rotationSeq: bigint; payTo: Address } | null {
    const r = this.state.rotations[key];
    return r ? { rotationSeq: BigInt(r.rotationSeq), payTo: r.payTo } : null;
  }

  nonceSeen(sellerId: Address, nonce: Hex): boolean {
    return `${sellerId.toLowerCase()}:${nonce.toLowerCase()}` in this.state.nonces;
  }

  /** Called only once a payment under this authorization is going ahead. */
  commit(observation: { key: string; rotationSeq: bigint; payTo: Address; nonce: Hex }, sellerId: Address): void {
    const existing = this.current(observation.key);
    if (!existing || observation.rotationSeq > existing.rotationSeq) {
      this.state.rotations[observation.key] = {
        rotationSeq: observation.rotationSeq.toString(),
        payTo: observation.payTo,
        firstSeenAt: new Date().toISOString(),
      };
    }
    if (!/^0x0+$/.test(observation.nonce)) {
      this.state.nonces[`${sellerId.toLowerCase()}:${observation.nonce.toLowerCase()}`] = new Date().toISOString();
    }
    this.persist();
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.path);
  }
}
