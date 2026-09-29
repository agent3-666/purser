import assert from "node:assert/strict";
import { verifyArcBlockHeight } from "../src/delivery/arc-block.js";

const bytes = (x: string) => new TextEncoder().encode(x);
assert.equal(verifyArcBlockHeight(bytes('{"jsonrpc":"2.0","id":1,"result":"0x64"}'), "0x67").outcome, "pass");
assert.equal(verifyArcBlockHeight(bytes('{"result":"0x10"}'), "0x67").reason, "stale_or_future");
assert.equal(verifyArcBlockHeight(bytes('{"result":"0x6a"}'), "0x67").reason, "stale_or_future");
assert.equal(verifyArcBlockHeight(bytes('{"result":"not-hex"}'), "0x67").reason, "invalid_paid_response");
assert.equal(verifyArcBlockHeight(bytes("not-json"), "0x67").reason, "invalid_paid_response");
console.log("PASS independent Arc block review: fresh, stale, future, malformed response");
