"""Aggregate-only payee comparison. No network calls or raw seller output."""
import collections
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit


def summarize(rows):
    if not isinstance(rows, list) or not rows or not all(isinstance(r, dict) for r in rows):
        raise ValueError('expected a nonempty list of probe objects')
    changed, hosts = 0, set()
    for row in rows:
        catalog, live = row.get('catalog'), row.get('live')
        if not isinstance(catalog, list) or not isinstance(live, list):
            continue
        known = collections.defaultdict(set)
        for offer in catalog:
            if isinstance(offer, dict) and all(offer.get(k) for k in ('network', 'asset', 'payTo')):
                known[(offer['network'], offer['asset'])].add(offer['payTo'])
        mismatch = any(
            isinstance(o, dict) and all(o.get(k) for k in ('network', 'asset', 'payTo'))
            and (o['network'], o['asset']) in known
            and o['payTo'] not in known[(o['network'], o['asset'])]
            for o in live
        )
        if mismatch:
            host = urlsplit(row.get('resource', '')).hostname
            if not host:
                raise ValueError('affected listing missing a valid hostname')
            changed += 1
            hosts.add(host)
    return {'catalogListings': len(rows), 'differentPayeeListings': changed,
            'sellerDomainCount': len(hosts)}


def self_test():
    def offer(payee, network='test:1'):
        return dict(network=network, asset='test-asset', payTo=payee)
    def row(live):
        return dict(resource='https://seller.example/service', catalog=[offer('A'), offer('B')], live=live)
    assert summarize([row([offer('B')])])['differentPayeeListings'] == 0
    assert summarize([row([offer('C'), offer('D')])])['differentPayeeListings'] == 1
    assert summarize([row([offer('C', 'test:2')])])['differentPayeeListings'] == 0
    assert summarize([row(None)])['differentPayeeListings'] == 0
    assert summarize([row([offer('C')]), row([offer('D')])])['sellerDomainCount'] == 1
    try:
        summarize({})
    except ValueError:
        pass
    else:
        raise AssertionError('invalid input accepted')
    print('6 synthetic method checks passed')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        self_test()
    elif len(sys.argv) == 2:
        rows = json.loads(Path(sys.argv[1]).read_text())
        result = summarize(rows)
        if Path(sys.argv[1]).name == 'probe_results_2026-09-23.json':
            assert result == {'catalogListings': 1143, 'differentPayeeListings': 20, 'sellerDomainCount': 3}
        print(json.dumps(result, indent=2))
    else:
        raise SystemExit('Usage: summarize_probe.py INPUT.json | --self-test')
