/** Read Tameion's current requirements for the team's actual submission work, without paying. */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readPublicDocumentation } from "../src/purchasing/public-web-read.js";

const result = await readPublicDocumentation({
  id: "purser_submission_requirements_20261004",
  purpose: "Check the current judging requirements before updating Purser submission evidence",
  url: "https://tameion.thecanteenapp.com/",
  allowedHosts: ["tameion.thecanteenapp.com"],
  requiredTerms: ["traction", "USDC", "October 10"],
  minBytes: 1000, maxBytes: 200_000,
});
const { contentText, ...report } = result;
const dir = fileURLToPath(new URL("../state/business-documentation/", import.meta.url));
mkdirSync(dir, { recursive: true });
const name = report.at.replace(/[:.]/g, "-");
writeFileSync(`${dir}${name}.json`, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
if (contentText) writeFileSync(`${dir}${name}.md`, contentText, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (report.outcome !== "free_delivery_pass") process.exitCode = 1;
