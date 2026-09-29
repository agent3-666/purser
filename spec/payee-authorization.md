# Payee Authorization

A seller's signed statement that one address may receive payment for one resource, on one chain, in
one asset, for a bounded time. It rides inside an x402 offer, so a buyer that ignores it is unaffected.

## Why

An x402 offer names its own payee. The buyer's wallet pays whatever `payTo` the 402 says. A directory
listing, a proxy, a CDN edge or a compromised server that rewrites that field redirects the payment, and
nothing downstream notices: the chain confirms the buyer paid exactly the address it was told to pay.
Reconciling against the chain proves consistency, not that the payee was the right one.

In ordinary accounts payable the control for this is change control on the vendor master: the bank
account you are about to pay is compared with the one you paid last time, and a change needs evidence.
Two things make that harder in x402:

- Payout addresses rotate. In a probe of Circle's Agent Marketplace on 2026-09-23, 20 listings from 3
  sellers answered with an address different from the catalog's, and one seller handed out a fresh
  address on every request. "Pin the address you saw first" breaks on the second request.
- There is no invoice separate from the payment request. The 402 is the invoice.

## The message

EIP-712, domain `{ name: "x402 Payee Authorization", version: "1" }`.

| field | meaning |
|---|---|
| `sellerDomain` | host the authorization is for, including port if any |
| `sellerId` | the seller identity key that signs |
| `network` | CAIP-2 chain id, e.g. `eip155:5042002` |
| `asset` | token contract |
| `payTo` | the address authorized to receive |
| `resourcePrefix` | the authorization covers only URLs starting with this |
| `validAfter`, `validBefore` | unix seconds |
| `rotationSeq` | increases each time a long-lived address is replaced |
| `nonce` | zero for a long-lived address; random and single-use for a per-request address |

Carried as `accepts[i].extra.payeeAuthorization` with every field as a string plus `signature`.

## The identity document

`https://<sellerDomain>/.well-known/x402-payee.json`

```json
{ "version": 1, "sellerDomain": "api.example.com",
  "identities": [ { "address": "0x…", "validAfter": 0, "validBefore": 4000000000, "status": "active" } ] }
```

The buyer fetches it over a separate request from the one that returned the 402. Key rotation and
revocation are edits to this file.

## Verification

Three outcomes, never "safe":

- **confirmed**: every rule passed, against evidence from both channels.
- **unconfirmed**: evidence is missing (no authorization, identity document unreachable, signer not
  published). The seller's authorization could not be established. It is not evidence of an attack.
- **rejected**: evidence exists and contradicts the offer.

| rule | rejects | guard |
|---|---|---|
| signature recovers to `sellerId` | forged claim of the seller's identity | `signature-matches-seller-id` |
| `sellerId` is published, active, and inside the identity entry's own validity window, by the resource's own host | attacker's own key, stale or premature key | `identity-published-by-domain`; E17–E18 |
| `sellerDomain` equals the resource host | another seller's genuine authorization | `domain-bound-to-resource-host` |
| resource URL starts with `resourcePrefix` | authorization for one path used on another | `resource-within-prefix` |
| `network`, `asset`, `payTo` equal the offer | address rewritten in transit | `offer-matches-authorization` |
| inside `[validAfter, validBefore)` | expired or premature | `not-before`, `not-after` |
| `rotationSeq` never goes backwards | replay of a superseded address | `rotation-moves-forward` |
| one address per `rotationSeq` | two addresses signed under one number | `no-equivocation` |
| a nonce is used once | replay of a per-request address | `nonce-single-use` |
| per-request window is short (default 15 min) | a "per-request" address that lives for days | `ephemeral-window-bounded` |

The buyer's ledger records the highest rotation and every used nonce only once a payment under that
authorization goes ahead. It is written with write-then-rename and fsync.

## Threat model

**Defended**, meaning the attacker controls this and the payment is still not redirected:

- the directory or catalog listing
- any proxy, CDN or middlebox between buyer and seller that can rewrite the 402
- a copy of any authorization the seller ever issued, including expired and superseded ones
- another seller's genuine authorizations

**Not defended**, stated so nobody reads more into a `confirmed` than it says:

- the seller's domain or TLS: whoever serves the identity document decides which key is trusted
- the seller's identity key: a stolen key signs valid authorizations until the seller revokes it
- a buyer that pays on `unconfirmed` without a separate reason to trust the payee
- the seller itself: a seller that authorizes an address and then does not deliver is a delivery
  problem, handled after payment, not a payee problem
- first contact with an unknown seller: `confirmed` shows the payee is the one that domain authorized,
  not that the domain is the business the buyer meant to pay

The trust anchor is the same one ACME HTTP-01 uses to issue a TLS certificate: control of the domain.

## Reproduce

```bash
npm install
npx tsx experiments/payee-authorization.ts   # 17 scenarios over real local HTTP sellers
npx tsx scripts/mutation-check.ts            # deletes each guard, requires its scenario to change
```

Results are written to `out/payee-authorization-experiments.json`.
