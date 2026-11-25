// The sign-in's counters: who a client is, a count taken in every counter or
// in none, and a full counter that forgets rather than refuses.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Counter, clientKey, take } from "../src/limits.ts";

test("a client is its IPv4 address, or its IPv6 /64, written out the same however it came", () => {
  for (const [address, key] of [
    ["203.0.113.7", "203.0.113.7"],
    [" 203.0.113.7 ", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002:0000:0000:0000:0001", "2001:db8:1:2::/64"],
    ["2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["64:ff9b::203.0.113.7", "64:ff9b:0:0::/64"],
    ["fe80::1%en0", "fe80:0:0:0::/64"],
    ["", "unknown"],
    [undefined, "unknown"],
    ["not an address", "unknown"],
    ["203.0.113.7, 10.0.0.1", "unknown"],
  ] as const) {
    assert.equal(clientKey(address), key, String(address));
  }
});

test("a count is taken in every counter or in none", () => {
  const one = new Counter(1, 1_000, () => 0);
  const two = new Counter(2, 1_000, () => 0);
  assert.ok(take([one, "x"], [two, "x"]));
  assert.ok(!take([one, "x"], [two, "x"]));
  assert.ok(take([two, "x"]), "the refused count left the second counter at one");
  assert.ok(!take([two, "x"]));
  assert.ok(take([one, "y"]), "another key has its own count");
});

test("a counter's window slides, and a full one forgets the key heard from longest ago", () => {
  let now = 0;
  const counter = new Counter(2, 1_000, () => now, 2);
  assert.ok(take([counter, "a"]) && take([counter, "a"]));
  assert.ok(!counter.allows("a"));
  now = 1_001;
  assert.ok(counter.allows("a"), "the window moved on");
  take([counter, "a"]);
  take([counter, "a"]);
  take([counter, "b"]);
  // Full with "a" and "b": "c" makes room by forgetting "a", heard from longest ago.
  assert.ok(take([counter, "c"]), "nobody new is refused");
  assert.ok(counter.allows("a"));
  assert.ok(take([counter, "b"]));
  assert.ok(!counter.allows("b"), "b was kept, with both of its requests");
  counter.clear("b");
  assert.ok(counter.allows("b"));
});
