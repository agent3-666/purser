"""Unpaid probe of every catalog listing: does the live 402 match what the catalog says?
Read-only. No payment is ever signed. One request per listing."""
import json, base64, urllib.request, urllib.error, concurrent.futures as cf, socket, time
items = json.load(open(__import__('os').path.join(__import__('os').path.dirname(__file__),'catalog_2026-09-23.json')))

def decode_header(v):
    for fn in (lambda x: json.loads(base64.b64decode(x + '==')), json.loads):
        try: return fn(v)
        except Exception: pass
    return None

def probe(it):
    url = it['resource']; m = (it.get('metadata') or {}).get('method') or 'GET'
    data = b'{}' if m.upper() in ('POST','PUT','PATCH') else None
    req = urllib.request.Request(url, data=data, method=m.upper(),
        headers={'User-Agent':'agent3-probe/1.0','Content-Type':'application/json','Accept':'application/json'})
    out = {'resource': url, 'method': m}
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            out['status'] = r.status; body = r.read(20000).decode(errors='replace'); hdr = dict(r.headers)
    except urllib.error.HTTPError as e:
        out['status'] = e.code
        try: body = e.read(20000).decode(errors='replace')
        except Exception: body = ''
        hdr = dict(e.headers or {})
    except Exception as e:
        out['status'] = None; out['error'] = type(e).__name__ + ':' + str(e)[:80]; out['ms']=int((time.time()-t0)*1000); return out
    out['ms'] = int((time.time()-t0)*1000)
    req_obj = None
    for k, v in hdr.items():
        if k.lower() in ('payment-required', 'x-payment-required'):
            req_obj = decode_header(v)
    if req_obj is None:
        try: req_obj = json.loads(body)
        except Exception: req_obj = None
    accepts = (req_obj or {}).get('accepts') if isinstance(req_obj, dict) else None
    if accepts:
        out['live'] = [{'network': a.get('network'), 'payTo': a.get('payTo'), 'amount': str(a.get('amount') or a.get('maxAmountRequired')), 'asset': a.get('asset')} for a in accepts]
    out['catalog'] = [{'network': a.get('network'), 'payTo': a.get('payTo'), 'amount': str(a.get('amount') or a.get('maxAmountRequired')), 'asset': a.get('asset')} for a in it.get('accepts', [])]
    return out

res = []
with cf.ThreadPoolExecutor(16) as ex:
    for r in ex.map(probe, items): res.append(r)
json.dump(res, open(__import__('os').path.join(__import__('os').path.dirname(__file__),'probe_results_rerun.json'),'w'))
print('done', len(res))
