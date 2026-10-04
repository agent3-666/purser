import assert from "node:assert/strict";
import { readPublicDocumentation, validatePublicReadNeed } from "../src/purchasing/public-web-read.js";
const need = { id: "public_docs", purpose: "read official public documentation", url: "https://example.com/",
  allowedHosts: ["example.com"], requiredTerms: ["USDC"], minBytes: 4, maxBytes: 100 };
for (const url of ["http://example.com/", "https://user:pass@example.com/", "https://example.com/?token=value",
  "https://localhost/", "https://127.0.0.1/", "https://other.example/"]) {
  assert.throws(() => validatePublicReadNeed({ ...need, url }), /invalid/);
}
const original = globalThis.fetch;
const validBody = "Title: Public documentation\nURL Source: https://example.com/\nMarkdown Content:\nUSDC documentation";
try {
  for (const [status, body, type, outcome] of [
    [200, validBody, "text/markdown", "free_delivery_pass"],
    [200, "missing required information", "text/plain", "held"],
    [200, "USDC", "text/html", "held"],
    [200, "USDC".repeat(30), "text/plain", "held"],
    [200, validBody.replace("https://example.com/", "https://wrong.net/"), "text/plain", "held"],
    [200, validBody.replace("URL Source:", "Other Source:"), "text/plain", "held"],
    [200, validBody.replace("Markdown Content:", "Other Content:"), "text/plain", "held"],
    [402, "payment required", "text/plain", "held"],
    [500, "upstream failure", "text/plain", "held"],
  ] as const) {
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, "https://r.jina.ai/https://example.com/");
      const headers = new Headers(options?.headers);
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.has("payment-signature"), false);
      assert.equal(headers.has("x-payment"), false);
      return new Response(body, { status, headers: { "content-type": type } });
    };
    const result = await readPublicDocumentation(need);
    assert.equal(result.outcome, outcome);
    assert.equal(result.newPayments, 0);
    assert.equal(calls, 1, "no silent retry or paid fallback");
    if (status === 402) assert.equal(result.reason, "paid_route_requires_separate_approval");
}
} finally { globalThis.fetch = original; }
console.log("PASS public documentation workflow: 6 URL guards and 9 delivery/no-payment cases");
