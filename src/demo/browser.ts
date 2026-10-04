/** Runs the real verifier and proposal boundary in the browser; deliberately contains no payment code. */
import { evaluateDemoScenario, type DemoFixture } from "./scenario.js";
import { verifyArcBlockHeight } from "../delivery/arc-block.js";
const element = (id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing demo element ${id}`);
  return found;
};
const fixture = await fetch("./fixtures.json").then(async (response) => {
  if (!response.ok) throw new Error(`fixtures unavailable: ${response.status}`);
  return await response.json() as DemoFixture;
});
element("fixture-date").textContent = new Date(fixture.createdAt).toLocaleString();
const payTo = element("payee-input") as HTMLInputElement;
payTo.value = fixture.offer.payTo;
async function runScenario(scenario: string): Promise<void> {
  element("status").textContent = "Running local checks…";
  const { asOf, offer, verification, proposal, modelCalls } =
    await evaluateDemoScenario(fixture, scenario, payTo.value.trim());
  const verdict = verification.verdict;
  element("status").textContent = verdict === "confirmed" ? "Confirmed authorization" : verdict === "rejected" ? "Rejected: authorization check failed" : "Unconfirmed: authorization missing";
  element("status").setAttribute("data-verdict", verdict);
  element("verdict").textContent = verdict;
  element("reasons").textContent = verification.reasons.length ? verification.reasons.join(", ") : "All authorization checks passed";
  element("decision").textContent = proposal.outcome === "propose" ? "Proposal only — no order signed" : "Defer — no order created";
  element("model-call").textContent = modelCalls.length ? modelCalls[0] : "Model not called: no eligible offer";
  element("evaluation-time").textContent = new Date(asOf * 1000).toLocaleString();
  element("trace").textContent = JSON.stringify({ scenario, simulatedEvaluationTime: new Date(asOf * 1000).toISOString(), offer: { resource: offer.resource, payTo: offer.payTo, amount: offer.amount },
    verification: { verdict, reasons: verification.reasons }, purchaseBoundary: {
      outcome: proposal.outcome, selectedOfferId: proposal.selectedOfferId ?? null,
      exclusions: proposal.evaluated.flatMap((entry) => entry.reasons), modelCalled: modelCalls.length > 0,
      paymentRoute: "local_native_transfer (synthetic only)" } }, null, 2);
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-scenario]")) {
  button.addEventListener("click", () => {
    for (const other of document.querySelectorAll<HTMLButtonElement>("[data-scenario]")) other.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-pressed", "true");
    void runScenario(button.dataset.scenario ?? "clean").catch((error) => { element("status").textContent = `Local check failed: ${String(error)}`; });
  });
}
void runScenario("clean").catch((error) => { element("status").textContent = `Local check failed: ${String(error)}`; });

const deliveryInput = element("delivery-input") as HTMLTextAreaElement;
function runDelivery(): void {
  const result = verifyArcBlockHeight(new TextEncoder().encode(deliveryInput.value), "0x67");
  element("delivery-status").textContent = result.outcome === "pass" ? "Pass: structurally valid, within height tolerance" : `Fail: ${result.reason}`;
  element("delivery-trace").textContent = JSON.stringify(result, null, 2);
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-delivery]")) {
  button.addEventListener("click", () => {
    const scenario = button.dataset.delivery;
    deliveryInput.value = JSON.stringify(scenario === "error" ? { jsonrpc: "2.0", id: 1, result: "0x64", error: { code: -32000, message: "upstream failure" } } :
      { jsonrpc: "2.0", id: 1, result: scenario === "stale" ? "0x10" : "0x64" }, null, 2);
    runDelivery();
  });
}
element("check-delivery").addEventListener("click", runDelivery);
deliveryInput.value = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x64" }, null, 2);
runDelivery();
