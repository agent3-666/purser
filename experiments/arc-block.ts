import assert from "node:assert/strict";
import { verifyArcBlockHeight, fetchIndependentArcHeight } from "../src/delivery/arc-block.js";

const bytes = (x: string) => new TextEncoder().encode(x);
assert.equal(verifyArcBlockHeight(bytes('{"jsonrpc":"2.0","id":1,"result":"0x64"}'), "0x67").outcome, "pass");
assert.equal(verifyArcBlockHeight(bytes('{"jsonrpc":"2.0","result":"0x10"}'), "0x67").reason, "stale_or_future");
assert.equal(verifyArcBlockHeight(bytes('{"jsonrpc":"2.0","result":"0x6a"}'), "0x67").reason, "stale_or_future");
assert.equal(verifyArcBlockHeight(bytes('{"result":"not-hex"}'), "0x67").reason, "invalid_paid_response");
assert.equal(verifyArcBlockHeight(bytes("not-json"), "0x67").reason, "invalid_paid_response");
// Known bad case: a result alongside an RPC error used to pass as a successful delivery.
assert.equal(verifyArcBlockHeight(bytes('{"jsonrpc":"2.0","result":"0x64","error":{"code":-32000,"message":"upstream failure"}}'), "0x67").reason, "invalid_paid_response");
assert.equal(verifyArcBlockHeight(bytes('{"result":"0x64"}'), "0x67").reason, "invalid_paid_response");
console.log("PASS independent Arc block review: 7 cases, including contradictory RPC error/result");

const originalFetch = globalThis.fetch;
try {
  for (const body of [
    { jsonrpc: "2.0", id: 1, result: "0x64", error: { code: -32000 } },
    { jsonrpc: "2.0", id: 2, result: "0x64" },
    { id: 1, result: "0x64" },
    null,
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
    await assert.rejects(fetchIndependentArcHeight(), /no valid block height/);
  }
  globalThis.fetch = async () => new Response('{"jsonrpc":"2.0","id":1,"result":"0x64"}', { status: 200 });
  assert.equal(await fetchIndependentArcHeight(), "0x64");
} finally { globalThis.fetch = originalFetch; }
console.log("PASS independent RPC envelope: 4 malformed cases rejected, valid response accepted");
