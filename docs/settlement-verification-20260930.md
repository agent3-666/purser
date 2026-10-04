# QuickNode trial: Gateway batch settlement verification

The single Agent3 Arc testnet purchase made on 2026-09-30 has a completed Circle Gateway transfer record and a successful Arc Gateway batch transaction containing the exact buyer debit and payee credit. This is stronger than the original HTTP receipt and balance-decrease observations. It remains **one self-funded testnet purchase**, not external buyer adoption, a mainnet payment, or proof of the seller's real-world identity.

## Public, independently repeatable checks

Run `npx tsx scripts/verify-settlement.ts` from the repository root. The script needs only public HTTPS endpoints. It does not load wallet files, sign, deposit, or send a paid HTTP request. On 2026-09-30 19:40 UTC it passed the following assertions:

| Check | Observed value |
|---|---|
| [Circle Gateway transfer lookup](https://gateway-api-testnet.circle.com/v1/x402/transfers/fe8230bb-4618-48c9-9898-43ca041043f1) | ID `fe8230bb-4618-48c9-9898-43ca041043f1`, `completed`, Arc testnet → Arc testnet, 100 atomic USDC, expected buyer and payee |
| Circle-reported batch transaction | `0x333a1462e1be41002bc569ebf98ac68d2eb6fa8caf521d72962be6e1025b22db` |
| [Arc testnet public RPC](https://rpc.testnet.arc.network) transaction receipt | `success`, block `64805221`, target GatewayWallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Decoded `submitBatch(bytes,bytes)` calldata | Domain 26, USDC `0x3600000000000000000000000000000000000000`, four entries; buyer `0xC1fF46183e6f92642b8Bb3fA3fc73b32B22AFdED` −100 and QuickNode payee `0xF46394adDdA95A3d5bCC1124605E3d15D204623C` +100 atomic units |

The batch also contains an unrelated −3054/+3054 pair. The public calldata does **not** contain the Circle transfer UUID. The link between UUID and transaction hash comes from Circle's transfer API; the signed batch calldata and successful receipt then independently show the matching 100-unit debit and credit. This supports a completed batched testnet settlement for the stated addresses and amount. The verifier script asserts each link and fails if any field disagrees.

The seller's original x402 offer still lacked a seller-signed payee authorization. The user approved a narrow one-order exception for that risk; the onchain match does not upgrade the identity verdict from `unconfirmed`. The paid HTTP response and prospective block-height check are recorded separately in the [trial evidence](../research/quicknode_paid_trial_2026-09-30.md).

Calldata decoding follows the public `submitBatch` layout documented in [The Canteen's Arc Gateway trace example](https://github.com/the-canteen-dev/circle-agent/blob/main/decode-batch.ts). The script decodes the live transaction itself and checks the entry values; it does not rely on that example's precomputed result.

## 2026-10-04 operational recheck

The historical transaction was rechecked at 18:07:58 UTC. The transfer remains completed, with a successful receipt on chain 5042002, the original transaction hash, matching transaction/receipt blocks, and a balanced four-entry batch. The checker now rejects a changed batch layout rather than interpreting it as the historical format. See [the recheck report](../research/settlement-recheck-20261004.json). This is a repeat verification of the original purchase: zero new purchases and zero verified external users.

The block-height delivery checker also now rejects contradictory JSON-RPC result/error responses and malformed reference envelopes. The previous version accepted a result alongside an error; this was reproduced before the fix. Twelve regression cases cover valid, stale, future, malformed and contradictory responses.
