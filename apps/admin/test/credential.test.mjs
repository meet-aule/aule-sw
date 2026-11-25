// A passkey's JSON (public/credential.js): the browser's own toJSON(), or the
// same fields written by hand where a password manager's credential cannot
// write them, and a clear failure where even those cannot be read.
import assert from "node:assert/strict";
import { test } from "node:test";

import { base64url, credentialJSON } from "../public/credential.js";

const bytes = (...values) => new Uint8Array(values).buffer;
/** A credential as a password manager hands it: its fields are there, its toJSON() fails as theirs do. */
const brokenToJSON = (fields) => ({
  ...fields,
  toJSON() {
    throw new TypeError("Illegal invocation");
  },
});

test("bytes are written as base64url with no padding, from a buffer or a view of one", () => {
  assert.equal(base64url(bytes(1, 2, 3, 4)), "AQIDBA");
  assert.equal(base64url(bytes(0xfb, 0xff, 0xbf)), "-_-_");
  assert.equal(base64url(new Uint8Array([9, 1, 2, 3, 4, 9]).subarray(1, 5)), "AQIDBA");
  assert.equal(base64url(bytes()), "");
  for (const none of [undefined, null, "AQID", [1, 2], {}]) assert.throws(() => base64url(none), TypeError, String(none));
});

test("the browser's own JSON is used as it is", () => {
  const own = { id: "AQIDBA", rawId: "AQIDBA", type: "public-key", response: { clientDataJSON: "e30" } };
  assert.equal(credentialJSON({ toJSON: () => own }), own);
});

test("a passkey made where toJSON() fails or is missing is written by hand, with the fields the console reads", () => {
  const made = {
    id: "AQIDBA",
    rawId: bytes(1, 2, 3, 4),
    type: "public-key",
    response: { clientDataJSON: bytes(123, 125), attestationObject: bytes(0xa1, 0x63), getTransports: () => ["internal", "hybrid"] },
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
  };
  const expected = {
    id: "AQIDBA",
    rawId: "AQIDBA",
    type: "public-key",
    response: { clientDataJSON: "e30", attestationObject: "oWM", transports: ["internal", "hybrid"] },
    clientExtensionResults: { credProps: { rk: true } },
  };
  assert.deepEqual(credentialJSON(brokenToJSON(made)), expected);
  assert.deepEqual(credentialJSON(made), expected, "with no toJSON() at all");
  // Its methods may fail the same way: what they would say is left out.
  const quiet = brokenToJSON({
    ...made,
    response: { ...made.response, getTransports: () => { throw new TypeError("Illegal invocation"); } },
    getClientExtensionResults: () => { throw new TypeError("Illegal invocation"); },
  });
  assert.deepEqual(credentialJSON(quiet), { ...expected, response: { ...expected.response, transports: [] }, clientExtensionResults: {} });
});

test("a passkey's answer to a sign-in is written by hand the same way, with its user handle", () => {
  const used = brokenToJSON({
    rawId: bytes(1, 2, 3, 4),
    response: { clientDataJSON: bytes(123, 125), authenticatorData: bytes(1), signature: bytes(2, 3), userHandle: bytes(4, 5, 6) },
    getClientExtensionResults: () => ({}),
  });
  assert.deepEqual(credentialJSON(used), {
    id: "AQIDBA",
    rawId: "AQIDBA",
    type: "public-key",
    response: { clientDataJSON: "e30", authenticatorData: "AQ", signature: "AgM", userHandle: "BAUG" },
    clientExtensionResults: {},
  });
});

test("a credential whose fields cannot be read either is unreadable", () => {
  const sealed = {
    toJSON() {
      throw new TypeError("Illegal invocation");
    },
    get rawId() {
      throw new TypeError("Illegal invocation");
    },
    response: {},
  };
  assert.throws(() => credentialJSON(sealed), { message: "unreadable" });
  assert.throws(() => credentialJSON(brokenToJSON({ rawId: bytes(1), response: {} })), { message: "unreadable" });
  assert.throws(() => credentialJSON(null), { message: "unreadable" });
});
