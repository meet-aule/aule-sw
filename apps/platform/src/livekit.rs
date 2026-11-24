//! LiveKit room tokens. A token is a JWT signed with the API secret (HS256);
//! it lets one person into one room and asks the tutor to join it.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

use crate::config::LiveKit;

pub struct RoomToken<'a> {
    pub room: &'a str,
    pub identity: &'a str,
    pub name: &'a str,
    pub ttl_seconds: i64,
    pub agent_name: &'a str,
    /// Given to the agent's job only; unlike room metadata, the other
    /// participants cannot read it.
    pub dispatch_metadata: &'a Value,
}

pub fn room_token(livekit: &LiveKit, token: &RoomToken, now: i64) -> String {
    let claims = json!({
        "iss": livekit.api_key,
        "sub": token.identity,
        "name": token.name,
        "nbf": now - 10,
        "exp": now + token.ttl_seconds,
        "video": {
            "room": token.room,
            "roomJoin": true,
            "canPublish": true,
            "canSubscribe": true,
            "canPublishData": true,
            "canPublishSources": ["microphone", "camera"],
        },
        // The room is created when the person joins, already asking for the tutor.
        "roomConfig": {
            "emptyTimeout": 30,
            // The browser and device must have time to reconnect to this same
            // room. Closing it early also ends the platform session.
            "departureTimeout": 120,
            "maxParticipants": 2,
            "agents": [{
                "agentName": token.agent_name,
                "metadata": token.dispatch_metadata.to_string(),
            }],
        },
    });
    sign(&claims, &livekit.api_secret)
}

fn sign(claims: &Value, secret: &str) -> String {
    let encode = |value: &Value| URL_SAFE_NO_PAD.encode(value.to_string());
    let signed = format!("{}.{}", encode(&json!({ "alg": "HS256", "typ": "JWT" })), encode(claims));
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(signed.as_bytes());
    format!("{signed}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(part: &str) -> Value {
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).unwrap()).unwrap()
    }

    #[test]
    fn the_token_is_for_one_room_and_asks_for_the_tutor() {
        let livekit = LiveKit {
            public_url: "wss://live.example.org".into(),
            api_key: "key".into(),
            api_secret: "secret".into(),
        };
        let metadata = json!({ "audience": "operator", "session_id": "s1" });
        let jwt = room_token(
            &livekit,
            &RoomToken {
                room: "session-abc",
                identity: "child-1",
                name: "Ana",
                ttl_seconds: 600,
                agent_name: "aule-tutor",
                dispatch_metadata: &metadata,
            },
            1_000,
        );

        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(decode(parts[0]), json!({ "alg": "HS256", "typ": "JWT" }));
        let claims = decode(parts[1]);
        assert_eq!(claims["iss"], "key");
        assert_eq!(claims["exp"], 1_600);
        assert_eq!(claims["video"]["room"], "session-abc");
        assert!(claims["video"].get("roomAdmin").is_none());
        assert_eq!(claims["roomConfig"]["departureTimeout"], 120);
        assert_eq!(claims["roomConfig"]["emptyTimeout"], 30);
        assert_eq!(claims["roomConfig"]["maxParticipants"], 2);
        let dispatch = &claims["roomConfig"]["agents"][0];
        assert_eq!(dispatch["agentName"], "aule-tutor");
        assert_eq!(serde_json::from_str::<Value>(dispatch["metadata"].as_str().unwrap()).unwrap(), metadata);

        // RFC 7515 check: recompute the signature over header.payload.
        let mut mac = Hmac::<Sha256>::new_from_slice(b"secret").unwrap();
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        assert_eq!(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()), parts[2]);
    }
}
