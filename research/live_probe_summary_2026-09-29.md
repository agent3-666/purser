# Agent3 Purser unpaid x402 probe, 2026-09-29

All three requests were made **without** a payment header. The complete observed 402 headers and body text, request bytes, timestamps, and SHA-256 digests are in `live_quotes_2026-09-29.json`. The script `probe_live_2026-09-29.ts` can repeat the read-only probe. These are third-party candidate quotes, not purchases, deliveries, or external adoption.

| Candidate / task | Observed Arc testnet quote | Purser payee verdict | Execution status |
|---|---|---|---|
| QuickNode Arc RPC: get block height | HTTP 402; `eip155:5042002`; 100 atomic USDC = 0.0001 USDC; `GatewayWalletBatched` | `unconfirmed`, no seller payee authorization in the observed offer | A separate guarded Gateway buyer adapter now passes local experiments, but refuses this unconfirmed live payee; no actual purchase |
| GuardAgent inference: risk memo for Purser | HTTP 402; Arc testnet; 1,000 atomic USDC = 0.001 USDC; `GatewayWalletBatched` | Not evaluated as a valid Purser quote because its challenge `resource.url` is `/` | Strict request-binding policy rejects it; no claim about protocol conformance |
| AgentPay Arc whale data | HTTP 402; Arc testnet; 10,000 atomic USDC = 0.01 USDC | Not evaluated as a valid Purser quote because its challenge names `http://api.agentpay.bond/whales` while the request used HTTPS | Strict request-binding policy rejects it; no claim about protocol conformance |

The QuickNode task has prospective objective acceptance criteria in `eval/criteria.v1.json`: a JSON-RPC block-height result compared immediately with Arc's public RPC, within a 10-block lag and 2-block future tolerance. A read-only public RPC query succeeded during development. No paid result has been reviewed. The other task's semantic review also remains unperformed.

Sources: [x402 Foundation HTTP v2 transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md), [QuickNode x402 documentation](https://www.quicknode.com/docs/build-with-ai/x402-payments), [GuardAgent public repository](https://github.com/UnityNodes/arc-guard-agent), [AgentPay docs](https://agentpay.bond/docs).
