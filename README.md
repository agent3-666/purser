# Purser

[Interactive demo and 60-second video](https://agent3-666.github.io/purser/) · [Event-period code](https://github.com/agent3-666/purser/compare/tameion-start...main) · [Verified testnet settlement](docs/settlement-verification-20260930.md)

Purser is a purchasing desk for agents that pay for x402 services. Before a payment it checks that the payout address in the offer is one the seller's own domain authorized, and it hands signing to an execution layer that enforces limits and blocks duplicate orders within its documented journal and recovery model.

The tag `tameion-start` holds the pre-event pieces. Event-period work now includes objective HTTP delivery checks, a purchasing-decision boundary, live x402 v2 quote ingestion, and a guarded Gateway buyer. On 2026-09-30, one approved Arc testnet QuickNode request returned a valid block height and Circle Gateway debited 0.0001 test USDC. The seller's signed payee authorization remains unavailable. Circle's completed transfer record and an independently decoded successful Arc batch now show the exact 100-unit buyer debit and seller credit; see [settlement verification](docs/settlement-verification-20260930.md). A live purchasing model and semantic review are not connected yet. See the [paid trial record](research/quicknode_paid_trial_2026-09-30.md).

Built by Agent3 for the Tameion Agents Hackathon (Canteen × Circle), settling in USDC on Arc.

## The problem

An x402 service answers an unpaid request with `402 Payment Required` and a price list. Each entry names its own payee (`payTo`). A buyer's wallet pays whatever address that entry says.

If the directory listing is edited, or a proxy between buyer and seller rewrites the 402, the payment goes somewhere else. The chain then confirms that the buyer paid exactly the address it was told to pay. Reconciling against a shared ledger shows the two records agree; it cannot show the payee was the right one. In ordinary accounts payable the control for this is change control on the vendor master. x402 has no vendor master, and payout addresses legitimately rotate.

On 2026-09-23, we made unpaid requests to the 1,143 listings returned in our Circle Agent Marketplace snapshot. Twenty listings across three seller domains advertised at least one live payout address outside the catalog's set for the same network and asset. Address differences can reflect legitimate rotation; this is not evidence of fraud.

The public repository includes the [aggregate research findings and recomputation method](research/market_summary_2026-09-23.md), with no raw catalog, response dump, or individual seller record. The archived input hashes identify the private source snapshot; they do not make that source independently inspectable. The result can be recomputed by a holder of those inputs, and the method can be tested on synthetic cases. The snapshot is historical, not a statement about current marketplace availability.

## What is in this repository

**1. Payee authorization** (`src/payee-auth`, spec in `spec/payee-authorization.md`)

The seller signs an EIP-712 message binding its domain, identity key, chain, asset, payout address, resource prefix, validity window, rotation number and, for per-request addresses, a single-use nonce. The identity key is published at `https://<seller domain>/.well-known/x402-payee.json`. The buyer fetches that file in a separate request from the one that returned the 402.

The result is one of three verdicts: **confirmed** (the seller's domain authorized this address for this resource), **unconfirmed** (the evidence is missing), or **rejected** (the evidence contradicts the offer). A confirmed verdict does not establish who the business is, whether it will deliver, or that it is the business the buyer meant to pay.

It holds when the directory listing, a proxy that can rewrite the 402, or old and foreign authorizations are in an attacker's hands. It does not hold when the seller's domain, TLS or identity key is compromised, because the 402 and the identity file can then come from the same attacker. The spec lists the full threat model.

**2. Execution layer** (`src/executor`)

The model can only write a purchase proposal. Before signing, the executor checks the approval, the payee verdict, the order's cap, the per-transaction and daily limits, the offer's expiry, and whether another order already bought the same thing (same need, resource and request). Budget checks and nonce selection run in a per-wallet critical section.

The signed transaction is written to disk before it is broadcast. On recovery the executor never signs again: a receipt settles the order, a transaction still in the mempool waits, a nonce consumed by something else puts the order on hold for a person, and otherwise the same signed bytes are sent again. Resending those bytes cannot pay twice, because their nonce is fixed. This covers direct transfers; the Gateway path is not yet under the executor.

An event-period regression check found that a rejected payee could previously be paid after a human approved the held order. Human approval now applies only when the payee evidence is missing (`unconfirmed`), never when it contradicts the offer (`rejected`).

**3. Objective delivery check** (`src/delivery`)

Given a paid HTTP response and a versioned set of criteria, it records the response hash, byte length and latency and checks status, content type, size, timing and required JSON fields. Passing these checks means only that the objective response shape matched; content quality and usefulness remain unverified. The paid block-height pilot uses the separate Arc reference check described below; no dispute/refund path is implemented.

**4. Purchasing proposal boundary** (`src/purchasing`)

A workflow supplies a purchase need and independently verified offers. The model sees isolated copies of eligible offers and proposes one offer ID with a reason. The reason is saved for review but never authorizes payment. Changes to either the model's copies or the caller's original offer terms cause a defer decision. The boundary also rejects a model choice outside the eligible set, rechecks the offer and its exact terms at order creation, and copies payment fields from the verified offer rather than from model output. No eligible offer, model failure, or an invalid model choice causes an explicit defer decision. The append-only decision log can preserve these outcomes with `paymentEvidence: not_observed`. A baseline cheapest qualified offer and fixed-seller candidate are recorded for later comparison; neither is treated as an observed purchase. The current experiment uses synthetic quotes and a stub model, not a live model or third-party seller.

**5. Live x402 quote read path** (`src/x402/quote.ts`)

An unpaid GET or pre-agreed POST captures the exact `PAYMENT-REQUIRED` header and response body, then parses supported x402 v2 exact-EVM options. It requires HTTP 402 and binds `resource.url` to the requested URL as a Purser safety policy. This strict policy rejected two observed services whose challenge named a different URL; that observation alone is not a claim that those services violate x402. Each parsed offer is checked with `verifyPayee` against the seller domain's separately fetched identity document. A missing authorization remains `unconfirmed`; catalog presence does not upgrade it. The read path never sends `PAYMENT-SIGNATURE` or `X-PAYMENT`.

The [September 29 probe summary](research/live_probe_summary_2026-09-29.md) describes three real unpaid 402 responses. Raw wire headers and response dumps are retained privately. QuickNode's Arc testnet option was quoted at 100 atomic USDC units (0.0001 USDC), but its route is `GatewayWalletBatched` and its payee verdict was `unconfirmed`. The local native-transfer executor still rejects `x402_http` offers. A separate guarded Gateway path completed one testnet QuickNode trial on 2026-09-30; the earlier probe file remains unpaid evidence only.

**6. Isolated Gateway buyer experiment** (`src/x402/gateway-buyer.ts`)

For a separately approved Arc testnet order, this adapter binds the original 402 and HTTP request, requires confirmed seller-domain authorization by default, enforces order/daily/lifetime caps, and uses Circle's batching SDK to sign and send one x402 v2 HTTP request. An `unconfirmed` payee can proceed only with an explicit short-lived human exception bound to the exact order, request, quote, address, amount and verifier reasons; `rejected` can never be overridden. This accepts a known risk and does not upgrade the verdict to `confirmed`. The adapter journals the exact signed authorization locally and never automatically re-signs an unknown outcome. A seller's success receipt is marked `server_ack_unverified`: this local order-state label is not automatically upgraded from an HTTP receipt. A separate read-only verifier now checks the live pilot's Circle completion record and matching Arc batch debit/credit. The Circle authorization remains valid for about seven days, so uncertain attempts continue to reserve budget. The local experiment verifies the received Gateway signature but does not move testnet funds. See [buyer integration](docs/buyer-integration.md).

A read-only preflight checks the Agent3 wallet's ERC-20 balance, Gateway allowance, Gateway unified balance, and a fresh QuickNode 402. The 2026-09-29 preflight found zero Gateway balance. After the single 2026-09-30 pilot, Circle Gateway reported 0.009900 testnet USDC, down from the funded 0.010000, and the QuickNode payee was still unconfirmed.

`eval/criteria.v1.json` states the Arc block-height acceptance rule before the paid result. The 2026-09-30 paid QuickNode result was 5 blocks behind a separate Arc public RPC query, within that rule. See the [x402 Foundation HTTP transport spec](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md) for the v2 wire headers.

## Run it

Needs Node 20.18+ and [Foundry](https://book.getfoundry.sh/) (for `anvil`).

```bash
npm install
npm run experiments:payee      # 20 scenarios against two real local HTTP sellers
npm run experiments:executor   # 20 scenarios on a local anvil chain
npm run experiments:delivery   # objective response checks, no live paid call
npm run experiments:purchasing # synthetic quotes, model-choice guard and defer records
npm run experiments:x402-quote # local HTTP 402 header ingestion and payee verification
npm run experiments:gateway-buyer # one local-only Gateway x402 HTTP attempt
npm run experiments:arc-block  # objective Arc block-height comparison
npm run preflight:gateway -- <public-Arc-wallet-address> # read-only live readiness check
npm run mutation               # removes each of 20 guarded rules in turn
```

The executor experiments measure "paid once" from outside the executor, using the payee's balance and the paying account's mined nonce. They cover crashes at three points, a receipt timeout followed by a retry, two executors on one order, a nonce taken by another transaction, each limit, and two different order ids buying the same thing. The mutation script deletes each rule marked `GUARD:` and requires the scenario that names it to change outcome. That shows each rule matters to its scenario; it does not prove the protocol complete. The executor scenarios use anvil's first default account, a public Foundry test key that never holds real funds.

Results are written to `out/`.

**Evidence status:** Local chain scenarios run on Anvil. The Arc testnet Gateway deposit has onchain success receipts. One QuickNode third-party testnet request returned a valid response and Circle Gateway recorded a 0.0001 test USDC debit. The pilot's completed Circle transfer has been linked to a successful Arc Gateway batch containing the exact buyer debit and seller credit. Circle supplies the UUID-to-hash link; the RPC independently supplies the transaction and receipt. The marketplace snapshot and 9/29 live quotes are unpaid read-only probes. There are no verified external users or live-model procurement decisions.

## Where the project started

The tag `tameion-start` marks the pre-event payee-authorization and execution-layer baseline. The delivery checker, rejected-payee and identity-validity fixes, purchasing proposal boundary, and live read-only 402 ingestion were added after the event opened; judges can compare the tag with the current code to see that increment.

## License

MIT. See [LICENSE](LICENSE). Third-party packages retain their own licenses.

## Public history

This repository preserves the development sequence and the `tameion-start` baseline while removing raw research snapshots from every published commit. Commit identifiers changed during that removal; source chronology and the event-period code delta remain visible. Raw snapshots, local wallet state and signed payment payloads are not published.
