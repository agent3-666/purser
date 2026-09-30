# Marketplace snapshot: aggregate findings and method

Snapshot: 2026-09-23. This is historical unpaid research, not purchases or adoption.

- Listings in the catalog and probe input: **1,143**.
- Listings with at least one comparable live payee outside the catalog set: **20**.
- Distinct seller domains among these listings: **3**.
- Payee differences do not demonstrate fraud, unauthorized rotation, or lost funds.
- This was the returned catalog snapshot, not a proof of full market coverage.

## Computation

For each listing, build a set of catalog payout addresses per `(network, asset)` pair. Compare each live offer only if the catalog contains that pair. Count the listing once when any comparable live address is outside the set. Multiple catalog payees for the same pair remain valid alternatives; collapsing them to a single dictionary value produces false positives. Missing or failed live responses are not counted as matches. Domain count uses the URL hostname of affected listings.

HTTP probe outcomes: {"200": 32, "400": 34, "402": 1056, "404": 2, "422": 1, "None": 18}. A non-402 status is not evidence of payment or useful delivery.

Run `python3 research/summarize_probe.py /path/to/private/probe_results_2026-09-23.json` to recompute from the original input, or `python3 research/summarize_probe.py --self-test` for synthetic checks. These commands make no network requests. The raw catalog, headers and individual seller records are intentionally not published. Independent exact reproduction requires access to those private inputs; a new live probe may differ because offers change.

## Archived input fingerprints

SHA-256 hashes establish which local files were analyzed, not the truth of their contents:

- `catalog_2026-09-23.json`: `8a9d4cb650feb5b49050c207c7b4a73806948abe67bfaea18587b46ffdb9470b`
- `probe_results_2026-09-23.json`: `4cd0d97922d5c3d3e26a00c592e7c0d6233b8723f4d01db412793dbab17e0e69`
- `live_quotes_2026-09-29.json`: `48282ade0f625591624940e1157166bca4c53d01b06a0d2e9e0725f3d73db431`
