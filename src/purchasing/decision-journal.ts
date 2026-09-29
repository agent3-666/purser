/** Append-only local decision evidence; never rewrite a prior decision. */
import { closeSync, mkdirSync, openSync, writeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import type { Recommendation } from "./recommend.js";

export interface DecisionRecord {
  at: string;
  criteriaVersion: string;
  recommendation: Recommendation;
  /** A purchase is observed only after the executor returns a chain receipt. */
  paymentEvidence: "not_observed";
}

export function appendDecision(path: string, record: DecisionRecord): void {
  if (!record.criteriaVersion || !Number.isFinite(Date.parse(record.at))) throw new Error("invalid decision record");
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
