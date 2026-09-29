# Unpaid buyer preflight

`fetchUnpaidQuote` performs only the initial HTTP request. It refuses redirects, non-402 responses, absent x402 v2 `PAYMENT-REQUIRED` headers, a mismatched `resource.url`, and any caller-supplied payment header. Use a pre-agreed GET or harmless POST body. This is a Purser policy for binding a quote to the requested resource; a rejected mismatch alone does not establish that the seller violates x402.

`verifyObservedQuote` calls the payee verifier for each parsed offer, independently fetching `https://<seller domain>/.well-known/x402-payee.json`. Use a persistent `PayeeLedger` when moving beyond a probe so rotation and nonce history survive restarts. A missing seller authorization is `unconfirmed`, never `confirmed`. Re-check immediately before any payment; the observed quote is time-sensitive.

The current `src/purchasing` experiment accepts only `local_native_transfer` offers. A real x402 HTTP offer must be marked `paymentRoute: "x402_http"`, which produces `payment_route_unsupported` and no executable order. The existing executor sends a native transfer; x402 requires a signed `PAYMENT-SIGNATURE` request or its scheme-specific equivalent and server-side settlement. Sending a native transfer to the quoted `payTo` does not buy the resource. No code in this repository currently sends a paid x402 request.

For review, run `npx tsx research/probe_live_2026-09-29.ts` from the repository root. It captures the exact public 402 headers and body text in `research/live_quotes_2026-09-29.json` without payment. Do not interpret a 402 challenge as delivered value or external adoption. The prospective acceptance rules for the two internal tasks are in `eval/criteria.v1.json`; both remain blocked on the unsupported Gateway buyer route, and GuardAgent also fails the current strict URL-binding policy.

Sources: [x402 Foundation HTTP v2 transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md), [QuickNode x402 documentation](https://www.quicknode.com/docs/build-with-ai/x402-payments), [Circle Gateway x402 example](https://www.circle.com/blog/turn-your-api-into-a-storefront-for-agents).
