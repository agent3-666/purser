"""Reproduce the catalog/live payee difference count without collapsing duplicate offers."""
import collections
import json
from pathlib import Path

rows = json.loads((Path(__file__).parent / "probe_results_2026-09-23.json").read_text())
assert isinstance(rows, list) and len(rows) == 1143
changed = []
for row in rows:
    catalog, live = row.get("catalog"), row.get("live")
    if not isinstance(catalog, list) or not isinstance(live, list):
        continue
    catalog_payees = collections.defaultdict(set)
    for offer in catalog:
        if isinstance(offer, dict):
            catalog_payees[(offer.get("network"), offer.get("asset"))].add(offer.get("payTo"))
    if any(
        offer.get("payTo") not in catalog_payees[(offer.get("network"), offer.get("asset"))]
        for offer in live
        if isinstance(offer, dict)
        and (offer.get("network"), offer.get("asset")) in catalog_payees
    ):
        changed.append(row)

hosts = collections.Counter(row["resource"].split("/")[2] for row in changed)
assert len(changed) == 20 and len(hosts) == 3
print(json.dumps({"catalogListings": len(rows), "differentPayeeListings": len(changed),
                  "sellerDomains": dict(sorted(hosts.items()))}, indent=2))
