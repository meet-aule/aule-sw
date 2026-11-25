// A passkey the browser made or used, as the JSON the console reads: what the
// browser's own credential.toJSON() writes. Some password managers hand the
// page a credential whose toJSON() fails, so the same fields are then written
// here by hand. It touches no page, so it is tested on its own.

/** Bytes, an ArrayBuffer or a view of one, as base64url with no padding, as toJSON() writes them. Anything else throws. */
export function base64url(bytes) {
  let view;
  if (ArrayBuffer.isView(bytes)) view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Asked this way, a buffer made in another realm, as an extension's may be, counts too.
  else if (Object.prototype.toString.call(bytes) === "[object ArrayBuffer]") view = new Uint8Array(bytes);
  else throw new TypeError("not bytes");
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** What one of the credential's methods gives, or `otherwise` where it fails or gives nothing. */
function given(call, otherwise) {
  try {
    return call() ?? otherwise;
  } catch {
    return otherwise;
  }
}

/**
 * The credential as JSON: its own toJSON(), or the same fields read one by
 * one where that fails. Throws an error named "unreadable" when even they
 * cannot be read: the console could never use that passkey.
 */
export function credentialJSON(credential) {
  try {
    return credential.toJSON();
  } catch {
    // Written by hand below.
  }
  try {
    const response = credential.response;
    const id = base64url(credential.rawId);
    const clientExtensionResults = given(() => credential.getClientExtensionResults(), {});
    const clientDataJSON = base64url(response.clientDataJSON);
    if (response.attestationObject) {
      const transports = given(() => response.getTransports(), []);
      const made = { clientDataJSON, attestationObject: base64url(response.attestationObject), transports };
      return { id, rawId: id, type: "public-key", response: made, clientExtensionResults };
    }
    const used = {
      clientDataJSON,
      authenticatorData: base64url(response.authenticatorData),
      signature: base64url(response.signature),
      ...(response.userHandle ? { userHandle: base64url(response.userHandle) } : {}),
    };
    return { id, rawId: id, type: "public-key", response: used, clientExtensionResults };
  } catch {
    throw new Error("unreadable");
  }
}
