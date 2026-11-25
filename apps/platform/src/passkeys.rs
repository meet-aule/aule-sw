//! Passkeys for the team's console (`apps/admin`). A team member adds them
//! from a recent sign-in, sees and deletes their own, and signs in with one
//! without typing an address. The platform is the relying party: it checks
//! every ceremony with webauthn-rs and keeps only what is public, the
//! credential id, the public key, the counter and the flags
//! (`team_passkeys`); the console carries the messages between the browser
//! and here.
//!
//! A ceremony's state stays in this process (`Ceremonies`), for a few minutes
//! and one use: the library keeps no record of a challenge it has seen, so
//! this is what makes each one single-use and short-lived. A restart drops the
//! ceremonies in progress, and the person presses the button again.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rand::Rng;
use sea_orm::{ConnectionTrait, DbBackend, Statement, TransactionTrait};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use webauthn_rs::prelude::{
    CredentialID, PasskeyRegistration, RegisterPublicKeyCredential, Url, WebauthnError,
};
use webauthn_rs::{Webauthn, WebauthnBuilder};

use crate::auth::{Input, TeamMember};
use crate::config::AdminPasskeys;
use crate::error::{ApiError, ApiResult};
use crate::plans::team_member;
use crate::state::AppState;

/// How long the browser is given for a ceremony. The library only passes it
/// on and enforces nothing.
pub const CEREMONY_TIMEOUT: Duration = Duration::from_secs(240);
/// How long the platform keeps a ceremony: the browser's time, and a minute
/// for the requests on either side of it.
pub const CEREMONY_LIFE: Duration = Duration::from_secs(300);
/// The most ceremonies held at once; the oldest goes first. The console lets
/// through 600 sign-in requests a minute in all, so its traffic never fills it.
const MAX_CEREMONIES: usize = 4_096;
/// A passkey is added only this soon after signing in: a session stolen later
/// cannot add one to outlive its 12 hours.
pub const RECENT_SIGN_IN_MINUTES: i32 = 15;
/// The most passkeys one team member may have.
pub const MAX_PASSKEYS: i64 = 10;
/// A passkey's name, in characters.
pub const MAX_LABEL_CHARS: usize = 60;
/// WebAuthn's longest credential id.
pub const MAX_CREDENTIAL_ID_BYTES: usize = 1023;
/// The body of a route that carries a credential; every other route keeps
/// the API's own limit.
pub const BODY_BYTES: usize = 16 * 1024;

const NOT_SET_UP: ApiError = ApiError::Unavailable("passkeys are not set up here");

/// The team's console as a relying party: passkeys made for its RP id, and
/// ceremonies accepted only from its exact origin, with no other subdomain
/// or port (the library's defaults, left as they are).
pub fn relying_party(settings: &AdminPasskeys) -> Result<Webauthn, WebauthnError> {
    let origin = Url::parse(&settings.origin).map_err(|_| WebauthnError::Configuration)?;
    WebauthnBuilder::new(&settings.rp_id, &origin)?.rp_name("Aule").timeout(CEREMONY_TIMEOUT).build()
}

/// A ceremony in progress.
pub enum Ceremony {
    /// A passkey being added, by the session that asked for it.
    Register { session: String, guardian_id: Uuid, user_handle: Uuid, state: PasskeyRegistration },
}

/// The ceremonies in progress, each kept for `CEREMONY_LIFE` and given back
/// once. A ceremony's handle goes to the console, and only its hash is kept.
pub struct Ceremonies {
    held: HashMap<[u8; 32], (Instant, Ceremony)>,
    most: usize,
}

impl Default for Ceremonies {
    fn default() -> Self {
        Self { held: HashMap::new(), most: MAX_CEREMONIES }
    }
}

fn key_of(handle: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    key.copy_from_slice(&Sha256::digest(handle));
    key
}

impl Ceremonies {
    /// Keeps a ceremony and returns its handle: 32 random bytes in hex. A
    /// session has one passkey being added at a time: a new one replaces it.
    pub fn put(&mut self, ceremony: Ceremony, now: Instant) -> String {
        self.held.retain(|_, (at, _)| now.saturating_duration_since(*at) < CEREMONY_LIFE);
        let Ceremony::Register { session, .. } = &ceremony;
        self.held.retain(
            |_, (_, held)| !matches!(held, Ceremony::Register { session: other, .. } if other == session),
        );
        while self.held.len() >= self.most {
            let Some(oldest) = self.held.iter().min_by_key(|(_, (at, _))| *at).map(|(key, _)| *key) else {
                break;
            };
            self.held.remove(&oldest);
        }
        let mut handle = [0u8; 32];
        rand::rng().fill_bytes(&mut handle);
        self.held.insert(key_of(&handle), (now, ceremony));
        hex::encode(handle)
    }

    /// The ceremony behind a handle, once: it is gone whatever happens next.
    /// None for a handle that is unknown, malformed or older than
    /// `CEREMONY_LIFE`.
    pub fn take(&mut self, handle: &str, now: Instant) -> Option<Ceremony> {
        if handle.len() != 64 || !handle.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
            return None;
        }
        let bytes = hex::decode(handle).ok()?;
        let (at, ceremony) = self.held.remove(&key_of(&bytes))?;
        (now.saturating_duration_since(at) < CEREMONY_LIFE).then_some(ceremony)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.held.len()
    }
}

/// A passkey's name as it is kept: trimmed, 1 to `MAX_LABEL_CHARS`
/// characters, and one line, as a guardian's name (`signin::enter`).
pub fn label_of(text: &str) -> Option<String> {
    let text = text.trim();
    let length = text.chars().count();
    ((1..=MAX_LABEL_CHARS).contains(&length) && !text.chars().any(char::is_control)).then(|| text.to_string())
}

/// What the browser is asked to create, as JSON. The library's passkey flow
/// asks for a credential that need not be discoverable; the console's sign-in
/// has no address to find one by, so it must be.
fn creation_options(options: &impl serde::Serialize) -> Option<Value> {
    let mut options = serde_json::to_value(options).ok()?;
    let public_key = options.get_mut("publicKey")?.as_object_mut()?;
    let selection = public_key.entry("authenticatorSelection").or_insert_with(|| json!({}));
    let selection = selection.as_object_mut()?;
    selection.insert("residentKey".into(), "required".into());
    selection.insert("requireResidentKey".into(), true.into());
    selection.insert("userVerification".into(), "required".into());
    Some(options)
}

/// `POST /v1/admin/passkeys/options`: what the browser needs to create a
/// passkey for the caller, and the ceremony's handle, bound to this session.
pub async fn register_options(member: TeamMember, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rp = state.webauthn.clone().ok_or(NOT_SET_UP)?;
    if !member.recent {
        return Err(ApiError::Conflict("sign in again to add a passkey"));
    }
    let existing = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select credential_id, user_handle from team_passkeys where guardian_id = $1",
            [member.guardian_id.into()],
        ))
        .await?;
    if existing.len() as i64 >= MAX_PASSKEYS {
        return Err(ApiError::bad_request("there are already 10 passkeys: delete one first"));
    }
    let mut exclude: Vec<CredentialID> = Vec::with_capacity(existing.len());
    let mut user_handle = None;
    for row in &existing {
        exclude.push(row.try_get::<Vec<u8>>("", "credential_id")?.into());
        user_handle = Some(row.try_get::<Uuid>("", "user_handle")?);
    }
    // A member's passkeys share one random handle: it is synced with them to
    // outside providers, so it is never the guardian's id.
    let user_handle = user_handle.unwrap_or_else(Uuid::new_v4);
    let (options, registration) = rp
        .start_passkey_registration(user_handle, &member.email, &member.email, Some(exclude))
        .map_err(|error| {
            tracing::warn!(%error, "a passkey could not be started");
            ApiError::Unavailable("a passkey could not be started; try again")
        })?;
    let options = creation_options(&options)
        .ok_or(ApiError::Unavailable("a passkey could not be started; try again"))?;
    let ceremony = Ceremony::Register {
        session: member.token_hash,
        guardian_id: member.guardian_id,
        user_handle,
        state: registration,
    };
    let handle = state.passkey_ceremonies.lock().expect("lock").put(ceremony, Instant::now());
    Ok(Json(json!({ "ceremony": handle, "options": options })))
}

#[derive(Deserialize)]
pub struct RegisterInput {
    ceremony: String,
    label: String,
    /// What the browser's `credential.toJSON()` gave, as the console passes it on.
    credential: Value,
}

/// `POST /v1/admin/passkeys`: the passkey the browser created, checked and
/// kept. Only the session that asked for the ceremony can finish it.
pub async fn register(
    member: TeamMember,
    State(state): State<AppState>,
    Input(body): Input<RegisterInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let rp = state.webauthn.clone().ok_or(NOT_SET_UP)?;
    let label = label_of(&body.label)
        .ok_or_else(|| ApiError::bad_request("label must be 1 to 60 characters on one line"))?;
    let taken = state.passkey_ceremonies.lock().expect("lock").take(&body.ceremony, Instant::now());
    let (user_handle, registration) = match taken {
        Some(Ceremony::Register { session, guardian_id, user_handle, state })
            if session == member.token_hash && guardian_id == member.guardian_id =>
        {
            (user_handle, state)
        }
        _ => return Err(ApiError::bad_request("that passkey request is unknown or has expired")),
    };
    let credential: RegisterPublicKeyCredential = serde_json::from_value(body.credential)
        .map_err(|_| ApiError::bad_request("credential is not a passkey the browser created"))?;
    // The browser says whether it made a discoverable credential. One that is
    // not could never sign in, as nobody types an address.
    if credential.extensions.cred_props.as_ref().and_then(|props| props.rk) == Some(false) {
        return Err(ApiError::bad_request("that passkey cannot sign in without an address"));
    }
    let who = team_member(&member.email);
    let passkey = rp.finish_passkey_registration(&credential, &registration).map_err(|error| {
        // The library's errors are fixed words.
        tracing::info!(%error, by = %who, "a team passkey was refused");
        ApiError::bad_request("that passkey could not be confirmed")
    })?;
    let credential_id = passkey.cred_id().to_vec();
    if credential_id.is_empty() || credential_id.len() > MAX_CREDENTIAL_ID_BYTES {
        return Err(ApiError::bad_request("that passkey could not be confirmed"));
    }
    let stored = serde_json::to_value(&passkey).map_err(|error| ApiError::Internal(error.to_string()))?;

    // The member's row is locked while their passkeys are counted, so two
    // finished together cannot make an eleventh.
    let txn = state.db.begin().await?;
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select id from guardians where id = $1 for update",
        [member.guardian_id.into()],
    ))
    .await?;
    let count = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select count(*) as count from team_passkeys where guardian_id = $1",
            [member.guardian_id.into()],
        ))
        .await?
        .map(|row| row.try_get::<i64>("", "count"))
        .transpose()?
        .unwrap_or(0);
    if count >= MAX_PASSKEYS {
        return Err(ApiError::bad_request("there are already 10 passkeys: delete one first"));
    }
    // A credential id is anyone's at most once; the library leaves that check to its caller.
    let inserted = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "insert into team_passkeys (id, guardian_id, credential_id, user_handle, passkey, label)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (credential_id) do nothing
             returning id, created_at",
            [
                Uuid::now_v7().into(),
                member.guardian_id.into(),
                credential_id.into(),
                user_handle.into(),
                stored.into(),
                label.clone().into(),
            ],
        ))
        .await?;
    let Some(inserted) = inserted else {
        return Err(ApiError::bad_request("that passkey is already registered"));
    };
    txn.commit().await?;
    tracing::info!(by = %who, "a team passkey was added");
    let id: Uuid = inserted.try_get("", "id")?;
    let created_at: DateTime<Utc> = inserted.try_get("", "created_at")?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": id, "label": label, "created_at": created_at, "last_used_at": null })),
    ))
}

/// `GET /v1/admin/passkeys`: the caller's own passkeys, newest first. Never a
/// credential id, a key, a handle, a counter or a flag.
pub async fn list(member: TeamMember, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select id, label, created_at, last_used_at from team_passkeys
             where guardian_id = $1 order by created_at desc, id desc",
            [member.guardian_id.into()],
        ))
        .await?;
    let passkeys = rows
        .iter()
        .map(|row| {
            Ok(json!({
                "id": row.try_get::<Uuid>("", "id")?,
                "label": row.try_get::<String>("", "label")?,
                "created_at": row.try_get::<DateTime<Utc>>("", "created_at")?,
                "last_used_at": row.try_get::<Option<DateTime<Utc>>>("", "last_used_at")?,
            }))
        })
        .collect::<Result<Vec<Value>, sea_orm::DbErr>>()?;
    Ok(Json(json!({ "passkeys": passkeys })))
}

/// `DELETE /v1/admin/passkeys/{id}`: one of the caller's own. Someone else's
/// is as much not found as one that never was.
pub async fn delete(
    member: TeamMember,
    State(state): State<AppState>,
    Path(passkey_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let deleted = state
        .db
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "delete from team_passkeys where id = $1 and guardian_id = $2",
            [passkey_id.into(), member.guardian_id.into()],
        ))
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError::NotFound("passkey"));
    }
    tracing::info!(by = %team_member(&member.email), "a team passkey was removed");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_relying_party_is_the_consoles_origin_and_nothing_else() {
        let settings =
            |rp_id: &str, origin: &str| AdminPasskeys { rp_id: rp_id.into(), origin: origin.into() };
        let rp = relying_party(&settings("admin.meetaule.com", "https://admin.meetaule.com")).unwrap();
        let allowed: Vec<&str> = rp.get_allowed_origins().iter().map(Url::as_str).collect();
        assert_eq!(allowed, ["https://admin.meetaule.com/"]);
        assert!(relying_party(&settings("localhost", "http://localhost:8092")).is_ok());
        for (rp_id, origin) in [
            ("admin.meetaule.com", "https://playground.meetaule.com"),
            ("evil.example", "https://admin.meetaule.com"),
            ("127.0.0.1", "https://127.0.0.1"),
            ("admin.meetaule.com", "not a url"),
        ] {
            assert!(relying_party(&settings(rp_id, origin)).is_err(), "{rp_id} {origin}");
        }
    }

    fn rp() -> Webauthn {
        relying_party(&AdminPasskeys { rp_id: "localhost".into(), origin: "http://localhost:8092".into() })
            .unwrap()
    }

    fn registering(session: &str) -> Ceremony {
        let (_, state) = rp().start_passkey_registration(Uuid::new_v4(), "a@example.org", "a", None).unwrap();
        Ceremony::Register {
            session: session.into(),
            guardian_id: Uuid::nil(),
            user_handle: Uuid::nil(),
            state,
        }
    }

    #[test]
    fn a_ceremony_is_given_back_once_and_only_while_it_lasts() {
        let mut ceremonies = Ceremonies::default();
        let start = Instant::now();
        let handle = ceremonies.put(registering("one"), start);
        assert_eq!(handle.len(), 64);
        assert!(handle.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
        assert!(ceremonies.take(&handle, start + Duration::from_secs(10)).is_some());
        assert!(ceremonies.take(&handle, start + Duration::from_secs(11)).is_none(), "once");

        let late = ceremonies.put(registering("two"), start);
        assert!(ceremonies.take(&late, start + CEREMONY_LIFE).is_none(), "too late");
        assert_eq!(ceremonies.len(), 0, "and gone");

        let kept = ceremonies.put(registering("three"), start);
        for odd in ["", "x", &kept.to_uppercase(), &kept[..62], &format!("{kept}00"), &"0".repeat(64)] {
            assert!(ceremonies.take(odd, start).is_none(), "{odd}");
        }
        assert!(ceremonies.take(&kept, start).is_some(), "a wrong handle leaves the right one");
    }

    #[test]
    fn a_session_adds_one_passkey_at_a_time() {
        let mut ceremonies = Ceremonies::default();
        let now = Instant::now();
        let first = ceremonies.put(registering("session"), now);
        let other = ceremonies.put(registering("another session"), now);
        let second = ceremonies.put(registering("session"), now);
        assert_eq!(ceremonies.len(), 2);
        assert!(ceremonies.take(&first, now).is_none(), "replaced");
        assert!(ceremonies.take(&second, now).is_some());
        assert!(ceremonies.take(&other, now).is_some(), "another session's stays");
    }

    #[test]
    fn a_full_store_drops_what_has_expired_and_then_the_oldest() {
        assert_eq!(Ceremonies::default().most, MAX_CEREMONIES);
        let mut ceremonies = Ceremonies { held: HashMap::new(), most: 3 };
        let start = Instant::now();
        let expired = ceremonies.put(registering("expired"), start);
        let later = start + CEREMONY_LIFE;
        let oldest = ceremonies.put(registering("one"), later);
        let middle = ceremonies.put(registering("two"), later + Duration::from_secs(1));
        let young = ceremonies.put(registering("three"), later + Duration::from_secs(2));
        assert_eq!(ceremonies.len(), 3, "the expired one went first");
        let newest = ceremonies.put(registering("four"), later + Duration::from_secs(3));
        assert_eq!(ceremonies.len(), 3);
        let now = later + Duration::from_secs(4);
        assert!(ceremonies.take(&oldest, now).is_none(), "the oldest made room");
        assert!(ceremonies.take(&expired, now).is_none());
        for kept in [middle, young, newest] {
            assert!(ceremonies.take(&kept, now).is_some());
        }
    }

    #[test]
    fn a_name_is_trimmed_and_one_short_line() {
        assert_eq!(label_of("  MacBook de Ana ").as_deref(), Some("MacBook de Ana"));
        assert_eq!(label_of(&"ñ".repeat(60)).as_deref(), Some("ñ".repeat(60).as_str()));
        for bad in ["", "   ", &"a".repeat(61), "Mac\nBook", "Mac\u{0}", "tab\there", "\u{7f}"] {
            assert_eq!(label_of(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_browser_is_asked_for_a_discoverable_verified_passkey_with_no_null() {
        let (options, _) = rp()
            .start_passkey_registration(Uuid::new_v4(), "team@example.org", "team@example.org", Some(vec![]))
            .unwrap();
        let options = creation_options(&options).unwrap();
        let public_key = &options["publicKey"];
        let selection = &public_key["authenticatorSelection"];
        assert_eq!(selection["residentKey"], "required");
        assert_eq!(selection["requireResidentKey"], true);
        assert_eq!(selection["userVerification"], "required");
        assert_eq!(public_key["attestation"], "none");
        assert_eq!(public_key["rp"], json!({ "id": "localhost", "name": "Aule" }));
        assert_eq!(public_key["timeout"], 240_000);
        let algorithms: Vec<&Value> =
            public_key["pubKeyCredParams"].as_array().unwrap().iter().map(|p| &p["alg"]).collect();
        assert_eq!(algorithms, [&json!(-7), &json!(-257)]);
        // The browser's parseCreationOptionsFromJSON refuses a null.
        assert!(!options.to_string().contains("null"), "{options}");
    }
}
