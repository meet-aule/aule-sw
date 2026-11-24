//! LiveKit rooms and the tokens to join them.
//!
//! The platform opens each session's room through LiveKit's server API and
//! asks for the tutor there, with what only the agent may read: its token for
//! the platform and the family's note. LiveKit hands that to the agent's job
//! and to no participant. The token a person receives is a JWT signed with
//! the API secret (HS256): signed, not encrypted, and sent by the browser in
//! the address of its WebSocket, where a proxy's logs can keep it. So it lets
//! one person into one room and carries nothing else.

use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::Utc;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

use crate::config::LiveKit;

/// Nobody is in a room when the platform opens it: the person has this long
/// to join, and the tutor waits for them.
const EMPTY_TIMEOUT_SECONDS: u32 = 30;
/// The browser and device must have time to reconnect to this same room.
/// Closing it early also ends the platform session.
const DEPARTURE_TIMEOUT_SECONDS: u32 = 120;
/// The person and the tutor.
const MAX_PARTICIPANTS: u32 = 2;
/// A token for LiveKit's server API is made for one call.
const API_TOKEN_SECONDS: i64 = 60;
const API_TIMEOUT: Duration = Duration::from_secs(5);

pub struct RoomToken<'a> {
    pub room: &'a str,
    pub identity: &'a str,
    pub name: &'a str,
    pub ttl_seconds: i64,
}

/// What a person joins a session's room with. No room configuration and no
/// agent dispatch: the platform opened the room already.
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
    });
    sign(&claims, &livekit.api_secret)
}

/// A session's room, as the platform asks LiveKit to open it.
pub struct NewRoom<'a> {
    pub name: &'a str,
    pub agent_name: &'a str,
    /// For the agent's job only. Unlike room metadata, no participant can
    /// read it, and unlike a token's, it never reaches a browser or a device:
    /// it goes from the platform to LiveKit at `LIVEKIT_URL`, the address the
    /// agent itself connects to, and from LiveKit to the agent.
    pub dispatch_metadata: &'a Value,
}

/// The body of LiveKit's `RoomService/CreateRoom`, with the tutor asked for.
fn create_room(room: &NewRoom) -> Value {
    json!({
        "name": room.name,
        "emptyTimeout": EMPTY_TIMEOUT_SECONDS,
        "departureTimeout": DEPARTURE_TIMEOUT_SECONDS,
        "maxParticipants": MAX_PARTICIPANTS,
        "agents": [{
            "agentName": room.agent_name,
            "metadata": room.dispatch_metadata.to_string(),
        }],
    })
}

/// A token for the server API that may create rooms and nothing else.
fn api_token(livekit: &LiveKit, now: i64) -> String {
    let claims = json!({
        "iss": livekit.api_key,
        "nbf": now - 10,
        "exp": now + API_TOKEN_SECONDS,
        "video": { "roomCreate": true },
    });
    sign(&claims, &livekit.api_secret)
}

#[derive(Debug, thiserror::Error)]
#[error("LiveKit did not open the room: {0}")]
pub struct RoomError(pub String);

/// Opens a session's room with the tutor asked for in it.
#[async_trait]
pub trait Rooms: Send + Sync {
    async fn open(&self, room: &NewRoom<'_>) -> Result<(), RoomError>;
}

/// LiveKit's server API, at the address the agent connects to.
pub struct LiveKitRooms {
    livekit: LiveKit,
    http: reqwest::Client,
}

impl LiveKitRooms {
    pub fn new(livekit: LiveKit) -> Self {
        let http = reqwest::Client::builder().timeout(API_TIMEOUT).build().unwrap_or_default();
        Self { livekit, http }
    }
}

#[async_trait]
impl Rooms for LiveKitRooms {
    async fn open(&self, room: &NewRoom<'_>) -> Result<(), RoomError> {
        let response = self
            .http
            .post(format!("{}/twirp/livekit.RoomService/CreateRoom", self.livekit.service_url))
            .bearer_auth(api_token(&self.livekit, Utc::now().timestamp()))
            .json(&create_room(room))
            .send()
            .await
            .map_err(|error| RoomError(error.without_url().to_string()))?;
        if !response.status().is_success() {
            // The answer may repeat what was sent, so only the status is kept.
            return Err(RoomError(format!("LiveKit answered {}", response.status().as_u16())));
        }
        Ok(())
    }
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
    use std::sync::{Arc, Mutex};

    use axum::Router;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;

    use super::*;

    fn livekit(service_url: &str) -> LiveKit {
        LiveKit {
            public_url: "wss://live.example.org".into(),
            service_url: service_url.into(),
            api_key: "key".into(),
            api_secret: "secret".into(),
        }
    }

    fn decode(part: &str) -> Value {
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).unwrap()).unwrap()
    }

    /// The claims of a token signed with "secret", after checking the signature (RFC 7515).
    fn verified(jwt: &str) -> Value {
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(decode(parts[0]), json!({ "alg": "HS256", "typ": "JWT" }));
        let mut mac = Hmac::<Sha256>::new_from_slice(b"secret").unwrap();
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        assert_eq!(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()), parts[2]);
        decode(parts[1])
    }

    fn dispatch() -> Value {
        json!({ "audience": "child", "session_id": "s1", "platform_token": "agent-only", "tutor_persona_note": "dinosaurios" })
    }

    #[test]
    fn a_person_s_token_lets_them_into_one_room_and_carries_nothing_else() {
        let jwt = room_token(
            &livekit("http://127.0.0.1:7880"),
            &RoomToken { room: "session-abc", identity: "child-1", name: "Student", ttl_seconds: 600 },
            1_000,
        );

        let claims = verified(&jwt);
        let mut fields: Vec<&str> = claims.as_object().unwrap().keys().map(String::as_str).collect();
        fields.sort_unstable();
        assert_eq!(fields, ["exp", "iss", "name", "nbf", "sub", "video"]);
        assert_eq!(
            (&claims["iss"], &claims["sub"], &claims["exp"]),
            (&json!("key"), &json!("child-1"), &json!(1_600))
        );
        assert_eq!(
            claims["video"],
            json!({
                "room": "session-abc",
                "roomJoin": true,
                "canPublish": true,
                "canSubscribe": true,
                "canPublishData": true,
                "canPublishSources": ["microphone", "camera"],
            })
        );
    }

    #[test]
    fn the_room_asks_for_the_tutor_with_what_only_the_agent_may_read() {
        let metadata = dispatch();
        let body = create_room(&NewRoom {
            name: "session-abc",
            agent_name: "aule-tutor",
            dispatch_metadata: &metadata,
        });

        assert_eq!(body["name"], "session-abc");
        assert_eq!(body["emptyTimeout"], 30);
        assert_eq!(body["departureTimeout"], 120);
        assert_eq!(body["maxParticipants"], 2);
        assert!(body.get("metadata").is_none(), "room metadata is read by every participant");
        let agents = body["agents"].as_array().unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["agentName"], "aule-tutor");
        assert_eq!(serde_json::from_str::<Value>(agents[0]["metadata"].as_str().unwrap()).unwrap(), metadata);
    }

    #[test]
    fn the_server_api_token_only_creates_rooms_and_soon_expires() {
        let claims = verified(&api_token(&livekit("http://127.0.0.1:7880"), 1_000));
        assert_eq!(claims["iss"], "key");
        assert_eq!(claims["video"], json!({ "roomCreate": true }));
        assert_eq!(claims["exp"], 1_060);
        assert!(claims.get("sub").is_none());
    }

    async fn serve(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn a_room_is_opened_through_livekit_s_server_api() {
        type Seen = Arc<Mutex<Vec<(String, String, Value)>>>;
        let seen: Seen = Arc::default();
        let kept = seen.clone();
        let server = Router::new().route(
            "/twirp/livekit.RoomService/CreateRoom",
            post(move |headers: HeaderMap, body: String| async move {
                let header = |name: &str| headers.get(name).unwrap().to_str().unwrap().to_string();
                let body: Value = serde_json::from_str(&body).unwrap();
                kept.lock().unwrap().push((header("authorization"), header("content-type"), body.clone()));
                axum::Json(json!({ "name": body["name"], "sid": "RM_test" }))
            }),
        );
        let rooms = LiveKitRooms::new(livekit(&serve(server).await));
        let metadata = dispatch();

        rooms
            .open(&NewRoom { name: "session-abc", agent_name: "aule-tutor", dispatch_metadata: &metadata })
            .await
            .unwrap();

        let seen = seen.lock().unwrap();
        let (authorization, content_type, body) = &seen[0];
        assert_eq!(content_type, "application/json");
        let claims = verified(authorization.strip_prefix("Bearer ").unwrap());
        assert_eq!(claims["video"], json!({ "roomCreate": true }));
        assert!(claims["exp"].as_i64().unwrap() <= Utc::now().timestamp() + API_TOKEN_SECONDS);
        assert_eq!(body["agents"][0]["metadata"], metadata.to_string());
    }

    #[tokio::test]
    async fn a_room_livekit_refuses_is_an_error_that_repeats_nothing_secret() {
        let server = Router::new().route(
            "/twirp/livekit.RoomService/CreateRoom",
            post(|body: String| async move { (StatusCode::UNAUTHORIZED, body) }),
        );
        let rooms = LiveKitRooms::new(livekit(&serve(server).await));
        let metadata = dispatch();

        let error = rooms
            .open(&NewRoom { name: "session-abc", agent_name: "aule-tutor", dispatch_metadata: &metadata })
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("401"), "{error}");
        assert!(!error.contains("agent-only") && !error.contains("dinosaurios"), "{error}");

        // Nobody answering is an error too, not a wait.
        let gone = LiveKitRooms::new(livekit("http://127.0.0.1:9"));
        assert!(
            gone.open(&NewRoom {
                name: "session-abc",
                agent_name: "aule-tutor",
                dispatch_metadata: &metadata
            })
            .await
            .is_err()
        );
    }
}
