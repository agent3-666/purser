/** Revalidate a previously delivered document; never disguise this as a fresh network read. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reviewPublicDocument } from "../src/delivery/public-document.js";
const dir = fileURLToPath(new URL("../state/business-documentation/", import.meta.url));
const names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
assert.ok(names.length, "no previously delivered document exists");
const name = names.at(-1)!;
const original = JSON.parse(readFileSync(`${dir}${name.replace(/\.md$/, ".json")}`, "utf8"));
const bytes = readFileSync(`${dir}${name}`);
assert.equal(createHash("sha256").update(bytes).digest("hex"), original.bodySha256, "saved delivery must match its original receipt");
assert.equal(original.outcome, "free_delivery_pass");
const review = reviewPublicDocument(bytes.toString("utf8"), original.targetUrl, ["traction", "USDC", "October 10"], 1000);
assert.equal(review.pass, true);
const report = { reviewedAt: new Date().toISOString(), originalFetchedAt: original.at,
  targetUrl: original.targetUrl, bodySha256: original.bodySha256,
  scope: "historical_document_revalidation_no_network", criteriaVersion: "public-document-v2",
  ...review, newNetworkRequests: 0, newPayments: 0, verifiedExternalUsers: 0 };
const out = fileURLToPath(new URL("../state/business-documentation/reviews/", import.meta.url));
mkdirSync(out, { recursive: true });
writeFileSync(`${out}${report.reviewedAt.replace(/[:.]/g, "-")}.json`, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
