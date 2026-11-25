//! A software authenticator for the tests: just enough of WebAuthn to drive
//! webauthn-rs through a registration and a discoverable sign-in, answering
//! with the JSON of the browser's `PublicKeyCredential.toJSON()`. Its keys are
//! P-256 (ES256). Its fields are the knobs a test turns to make it misbehave.

use std::collections::BTreeMap;

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, KeyPair};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use rand::Rng;
use serde_cbor_2::Value as Cbor;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The flags of the authenticator's data.
pub const UP: u8 = 0x01;
pub const UV: u8 = 0x04;
pub const BE: u8 = 0x08;
pub const BS: u8 = 0x10;
const AT: u8 = 0x40;

pub struct Authenticator {
    key: EcdsaKeyPair,
    pub credential_id: Vec<u8>,
    /// The user handle it keeps from the registration and gives at sign-in.
    pub user_handle: Vec<u8>,
    /// Whether its counter goes up with each use; a synced passkey's stays 0.
    pub counts: bool,
    pub counter: u32,
    /// UP, UV, BE and BS, as it reports them.
    pub flags: u8,
    /// Where the browser says the ceremony ran, and the RP id it hashes.
    pub origin: String,
    pub rp_id: String,
    /// What the browser says of `credProps.rk` at registration, if anything.
    pub discoverable: Option<bool>,
}

impl Authenticator {
    /// A synced passkey, as a phone's or a password manager's: verified,
    /// backed up, and with no counter.
    pub fn synced() -> Self {
        Self::new(false, UP | UV | BE | BS)
    }

    /// A passkey bound to one device, which counts its uses, as a security key's.
    pub fn device_bound() -> Self {
        Self::new(true, UP | UV)
    }

    fn new(counts: bool, flags: u8) -> Self {
        let mut credential_id = vec![0u8; 16];
        rand::rng().fill_bytes(&mut credential_id);
        Self {
            key: EcdsaKeyPair::generate(&ECDSA_P256_SHA256_ASN1_SIGNING).expect("a key"),
            credential_id,
            user_handle: Vec::new(),
            counts,
            counter: 0,
            flags,
            origin: "http://localhost:8092".into(),
            rp_id: "localhost".into(),
            discoverable: Some(true),
        }
    }

    /// The credential id as the browser writes it.
    pub fn id(&self) -> String {
        B64.encode(&self.credential_id)
    }

    fn cose_key(&self) -> Vec<u8> {
        // The uncompressed point: 0x04, then x and y.
        let point = self.key.public_key().as_ref();
        let mut map = BTreeMap::new();
        map.insert(Cbor::Integer(1), Cbor::Integer(2));
        map.insert(Cbor::Integer(3), Cbor::Integer(-7));
        map.insert(Cbor::Integer(-1), Cbor::Integer(1));
        map.insert(Cbor::Integer(-2), Cbor::Bytes(point[1..33].to_vec()));
        map.insert(Cbor::Integer(-3), Cbor::Bytes(point[33..65].to_vec()));
        serde_cbor_2::to_vec(&Cbor::Map(map)).expect("cbor")
    }

    fn data(&self, attested: bool) -> Vec<u8> {
        let mut data = Sha256::digest(self.rp_id.as_bytes()).to_vec();
        data.push(self.flags | if attested { AT } else { 0 });
        data.extend_from_slice(&self.counter.to_be_bytes());
        if attested {
            data.extend_from_slice(&[0u8; 16]);
            data.extend_from_slice(&u16::try_from(self.credential_id.len()).expect("short").to_be_bytes());
            data.extend_from_slice(&self.credential_id);
            data.extend_from_slice(&self.cose_key());
        }
        data
    }

    fn tick(&mut self) {
        if self.counts {
            self.counter += 1;
        }
    }

    fn client_data(&self, kind: &str, options: &Value) -> String {
        json!({
            "type": kind,
            "challenge": options["publicKey"]["challenge"],
            "origin": self.origin,
            "crossOrigin": false,
        })
        .to_string()
    }

    /// `navigator.credentials.create()` with the platform's options, then
    /// `credential.toJSON()`.
    pub fn create(&mut self, options: &Value) -> Value {
        let user = options["publicKey"]["user"]["id"].as_str().expect("a user handle");
        self.user_handle = B64.decode(user).expect("base64url");
        self.tick();
        let client_data = self.client_data("webauthn.create", options);
        let data = self.data(true);
        let mut attestation = BTreeMap::new();
        attestation.insert(Cbor::Text("fmt".into()), Cbor::Text("none".into()));
        attestation.insert(Cbor::Text("attStmt".into()), Cbor::Map(BTreeMap::new()));
        attestation.insert(Cbor::Text("authData".into()), Cbor::Bytes(data.clone()));
        let attestation = serde_cbor_2::to_vec(&Cbor::Map(attestation)).expect("cbor");
        let extensions = match self.discoverable {
            Some(rk) => json!({ "credProps": { "rk": rk } }),
            None => json!({}),
        };
        json!({
            "id": self.id(),
            "rawId": self.id(),
            "type": "public-key",
            "authenticatorAttachment": "platform",
            "response": {
                "clientDataJSON": B64.encode(client_data.as_bytes()),
                "attestationObject": B64.encode(&attestation),
                "authenticatorData": B64.encode(&data),
                "transports": ["hybrid", "internal"],
                "publicKeyAlgorithm": -7,
            },
            "clientExtensionResults": extensions,
        })
    }

    /// `navigator.credentials.get()` with the platform's options, then
    /// `credential.toJSON()`.
    pub fn get(&mut self, options: &Value) -> Value {
        self.tick();
        let client_data = self.client_data("webauthn.get", options);
        let data = self.data(false);
        let mut signed = data.clone();
        signed.extend_from_slice(&Sha256::digest(client_data.as_bytes()));
        let signature = self.key.sign(&SystemRandom::new(), &signed).expect("a signature");
        json!({
            "id": self.id(),
            "rawId": self.id(),
            "type": "public-key",
            "authenticatorAttachment": "platform",
            "response": {
                "clientDataJSON": B64.encode(client_data.as_bytes()),
                "authenticatorData": B64.encode(&data),
                "signature": B64.encode(signature.as_ref()),
                "userHandle": B64.encode(&self.user_handle),
            },
            "clientExtensionResults": {},
        })
    }
}
