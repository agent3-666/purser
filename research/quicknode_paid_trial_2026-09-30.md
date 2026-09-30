# QuickNode Arc testnet paid trial — 2026-09-30

This is one user-authorized Agent3 Purser pilot order, not evidence of external buyer adoption. The initial observations below were followed by a read-only settlement verification on the same date.

- Task: one JSON-RPC `eth_blockNumber` call to `https://x402.quicknode.com/arc-testnet`.
- Arc testnet (chain 5042002), USDC asset `0x3600000000000000000000000000000000000000`.
- Price: 100 atomic USDC units = **0.0001 testnet USDC**. Payee: `0xF46394adDdA95A3d5bCC1124605E3d15D204623C`.
- Payee verdict remained `unconfirmed` (`no_authorization`): the observed 402 did not include a seller-signed authorization. Joey approved this one testnet trial with a payee/amount/request/quote/reason/time-bound exception. It remains an accepted risk, not a confirmed seller identity.
- Circle Gateway received **0.01 testnet USDC** after exact-amount ERC-20 approval (`0x8fa8a526f79c82a2cd857494ffdc3e9f1652b44b7a7d3e18f24d109fefab35d8`) and contract `deposit` (`0x4e13e4a6463e7405997dc9a433b4e72d5c88e6380e7c567125adffc25d52c015`); both receipts had `status=success`. The approval allowance was 0 after deposit.
- The first paid attempt was blocked **before signing** because QuickNode rotates `sign-in-with-x` nonce/issue/expiration fields on every 402. Comparing quotes while ignoring only those three volatile fields allowed a second attempt; the tests still reject a changed amount and other material changes. The first attempt has no payment journal or signature.
- The second attempt sent one Gateway x402 signature. QuickNode returned HTTP 200 and `PAYMENT-RESPONSE` with `success=true`, network `eip155:5042002`, payer matching the Agent3 wallet, and transaction identifier `fe8230bb-4618-48c9-9898-43ca041043f1`. This identifier is a UUID, **not an Arc transaction hash**. The local ignored journal records the exact quote/request, exception, signature, and server response; it prevents another send for the same order or request.
- QuickNode returned block height **64,804,554**. Arc public RPC returned **64,804,559** immediately after, a 5-block lag within the prospectively defined 10-block lag / 2-block future tolerance.
- Circle Gateway balance on the Agent3 depositor fell from **0.010000 to 0.009900 testnet USDC**, exactly 0.000100, with `pendingBatch=0`. This is an independent read after the seller response, but it is still Circle's API, not an independently observed final onchain settlement of the nanopayment.

No mainnet funds were used. No other order was placed. The raw payment signature and private key remain in ignored private state/wallet files and must not be published. This one trial establishes a working third-party testnet request and objective response check; it does not establish a real Agent3 business need, live model procurement, outside users, or final chain settlement of the batched payment.

## Settlement follow-up, 2026-09-30

Circle now reports the transfer completed and links it to Arc transaction `0x333a1462e1be41002bc569ebf98ac68d2eb6fa8caf521d72962be6e1025b22db`. An independent Arc public RPC confirms a successful Gateway batch whose decoded calldata debits this buyer 100 atomic USDC and credits the expected QuickNode payee 100. The UUID-to-hash mapping comes from Circle; the transaction and exact entries are independently readable on Arc. See the [verification report and read-only reproduction command](../docs/settlement-verification-20260930.md). This closes the original settlement-evidence gap to that stated scope, without changing the unconfirmed seller-domain authorization or the absence of outside adoption.
