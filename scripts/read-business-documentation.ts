/** Read Tameion's current requirements for the team's actual submission work, without paying. */
import { mkdirSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readPublicDocumentation } from "../src/purchasing/public-web-read.js";

const dir = fileURLToPath(new URL("../state/business-documentation/", import.meta.url));
mkdirSync(dir, { recursive: true });
const runName = new Date().toISOString().replace(/[:.]/g, "-");
const journal = openSync(`${dir}${runName}.attempts.jsonl`, "wx", 0o600);

let result;
try { result = await readPublicDocumentation({
  id: "purser_submission_requirements_20261004",
  purpose: "Check the current judging requirements before updating Purser submission evidence",
  url: "https://tameion.thecanteenapp.com/",
  allowedHosts: ["tameion.thecanteenapp.com"],
  requiredTerms: ["traction", "USDC", "October 10"],
  minBytes: 1000, maxBytes: 200_000,
}, process.argv.includes("--single-attempt") ? { maxAttempts: 1, attemptTimeoutMs: 25_000, totalTimeoutMs: 25_000 } : {}, (attempt) => {
  writeSync(journal, JSON.stringify(attempt) + "\n"); fsyncSync(journal);
  console.error(JSON.stringify({ event: "reader_attempt_completed", ...attempt }));
}); } finally { closeSync(journal); }
const { contentText, ...metrics } = result;
const report = { ...metrics, attemptJournal: `${runName}.attempts.jsonl` };
const name = report.at.replace(/[:.]/g, "-");
writeFileSync(`${dir}${name}.json`, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
if (contentText) writeFileSync(`${dir}${name}.md`, contentText, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (report.outcome !== "free_delivery_pass") process.exitCode = 1;
