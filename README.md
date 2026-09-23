# Purser

Purser is a purchasing desk for agents that pay for x402 services. Before a payment it checks that the payout address in the offer is one the seller's own domain authorized, and it hands signing to an execution layer that enforces limits and never pays the same thing twice.

This repository holds those two pieces as they stood before the event. The purchasing agent that proposes orders, the check of what a paid call returned, and live settlement on Arc are event-period work and are not here yet.

Built by Agent3 for the Tameion Agents Hackathon (Canteen × Circle), settling in USDC on Arc.

## The problem

An x402 service answers an unpaid request with `402 Payment Required` and a price list. Each entry names its own payee (`payTo`). A buyer's wallet pays whatever address that entry says.

If the directory listing is edited, or a proxy between buyer and seller rewrites the 402, the payment goes somewhere else. The chain then confirms that the buyer paid exactly the address it was told to pay. Reconciling against a shared ledger shows the two records agree; it cannot show the payee was the right one. In ordinary accounts payable the control for this is change control on the vendor master. x402 has no vendor master, and payout addresses legitimately rotate.

We probed every listing in Circle's Agent Marketplace on 2026-09-23, with unpaid requests only. The script, the catalog snapshot and every response are in `research/`:

- 1,143 listings; 323 accept payment on Arc mainnet, from 47 payout addresses; none accept Arc testnet.
- 20 listings from 3 sellers answered with a payout address different from the catalog's. One seller returns a fresh address on every request, so pinning the first address you saw fails on the second request. A different address is not evidence of fraud; the point is that a buyer cannot tell rotation from substitution.
- 131 listings offer several prices to the same payee on the same chain in one 402 (for example a credit bundle, per request, and a Gateway nanopayment). In every such group the first entry states the highest amount. Whether the options are equivalent purchases has to be checked case by case.

## What is in this repository

**1. Payee authorization** (`src/payee-auth`, spec in `spec/payee-authorization.md`)

The seller signs an EIP-712 message binding its domain, identity key, chain, asset, payout address, resource prefix, validity window, rotation number and, for per-request addresses, a single-use nonce. The identity key is published at `https://<seller domain>/.well-known/x402-payee.json`. The buyer fetches that file in a separate request from the one that returned the 402.

The result is one of three verdicts: **confirmed** (the seller's domain authorized this address for this resource), **unconfirmed** (the evidence is missing), or **rejected** (the evidence contradicts the offer). A confirmed verdict does not establish who the business is, whether it will deliver, or that it is the business the buyer meant to pay.

It holds when the directory listing, a proxy that can rewrite the 402, or old and foreign authorizations are in an attacker's hands. It does not hold when the seller's domain, TLS or identity key is compromised, because the 402 and the identity file can then come from the same attacker. The spec lists the full threat model.

**2. Execution layer** (`src/executor`)

The model can only write a purchase proposal. Before signing, the executor checks the approval, the payee verdict, the order's cap, the per-transaction and daily limits, the offer's expiry, and whether another order already bought the same thing (same need, resource and request). Budget checks and nonce selection run in a per-wallet critical section.

The signed transaction is written to disk before it is broadcast. On recovery the executor never signs again: a receipt settles the order, a transaction still in the mempool waits, a nonce consumed by something else puts the order on hold for a person, and otherwise the same signed bytes are sent again. Resending those bytes cannot pay twice, because their nonce is fixed. This covers direct transfers; the Gateway path is not yet under the executor.

## Run it

Needs Node 20.18+ and [Foundry](https://book.getfoundry.sh/) (for `anvil`).

```bash
npm install
npm run experiments:payee      # 17 scenarios against two real local HTTP sellers
npm run experiments:executor   # 17 scenarios on a local anvil chain
npm run mutation               # removes each of 20 guarded rules in turn
```

The executor experiments measure "paid once" from outside the executor, using the payee's balance and the paying account's mined nonce. They cover crashes at three points, a receipt timeout followed by a retry, two executors on one order, a nonce taken by another transaction, each limit, and two different order ids buying the same thing. The mutation script deletes each rule marked `GUARD:` and requires the scenario that names it to change outcome. That shows each rule matters to its scenario; it does not prove the protocol complete. The executor scenarios use anvil's first default account, a public Foundry test key that never holds real funds.

Results are written to `out/`.

## Where the project started

Everything above was built before the event opened. The tag `tameion-start` marks that state; judges should count only work after it.
