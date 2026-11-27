//! Devices: how one proves who it is, how a family links one, and how it gets
//! firmware and sessions.
//!
//! A device is known by its serial number and holds a 32-byte HMAC key that
//! was burned into it when it was made and never leaves it. The server keeps a
//! copy and trusts a device only for what it signs with that key. Its MAC
//! address, or knowing its serial number, proves nothing.
//!
//! Linking a device to a family needs two halves, in either order:
//!
//! 1. the device shows a short code, and a signed-in guardian types it: that
//!    person can see the device;
//! 2. the device signs the challenge that came with the code: it is a real
//!    device, and the one the code was given to.
//!
//! The routes under `/ota/` speak the check-in and activation protocol of
//! xiaozhi-esp32, which the Aule firmware is built on.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use chrono::Utc;
use hmac::{Hmac, KeyInit, Mac};
use rand::RngExt;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    Statement, TransactionTrait,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use uuid::Uuid;

use crate::auth::{Caller, Guardian, Input, Operator};
use crate::entity::{device, device_claim, firmware};
use crate::error::{ApiError, ApiResult};
use crate::families::{child_for, find_child};
use crate::state::AppState;
use crate::{events, sessions};

const CLAIM_MINUTES: i32 = 10;
/// No look-alike characters: the code is read from a small screen and typed.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH: usize = 6;
/// Wrong codes one guardian may type in an hour.
const MAX_WRONG_CODES: u32 = 10;
/// How far a device's clock may be from the server's when it signs a request.
const CLOCK_SKEW_SECONDS: i64 = 120;

/// Whether `signature_hex` is HMAC-SHA256 of `message` under the device's key.
pub fn signed_by(key: &[u8], message: &[u8], signature_hex: &str) -> bool {
    let Ok(signature) = hex::decode(signature_hex.trim()) else { return false };
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message);
    mac.verify_slice(&signature).is_ok()
}

fn random_code() -> String {
    let mut rng = rand::rng();
    (0..CODE_LENGTH).map(|_| CODE_ALPHABET[rng.random_range(0..CODE_ALPHABET.len())] as char).collect()
}

fn random_challenge() -> String {
    hex::encode(rand::rng().random::<[u8; 16]>())
}

// --- the operator: devices as they are made, and firmware ---------------------------

#[derive(Deserialize)]
pub struct NewDevice {
    serial: String,
    /// The 32-byte key burned into the device, as 64 hex characters.
    hmac_key: String,
    /// The board, such as `aule-v0.2`. Firmware is published per model.
    model: String,
}

#[derive(Deserialize)]
pub struct NewDevices {
    devices: Vec<NewDevice>,
}

pub async fn register(
    _: Operator,
    State(state): State<AppState>,
    Input(body): Input<NewDevices>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    if body.devices.is_empty() || body.devices.len() > 1000 {
        return Err(ApiError::bad_request("send 1 to 1000 devices"));
    }
    let txn = state.db.begin().await?;
    let mut registered = 0;
    for device in &body.devices {
        let serial_ok = (4..=32).contains(&device.serial.len())
            && device.serial.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        let key = hex::decode(&device.hmac_key).ok().filter(|key| key.len() == 32);
        let model = device.model.trim();
        let (true, Some(key), 1..=60) = (serial_ok, key, model.len()) else {
            return Err(ApiError::bad_request(format!(
                "device {:?} needs a serial, a 32-byte hmac_key in hex and a model",
                device.serial
            )));
        };
        // A serial that is already registered keeps its key: re-sending the
        // same list is harmless, and a key cannot be replaced by accident.
        registered += device::Entity::insert(device::ActiveModel {
            id: Set(Uuid::now_v7()),
            serial: Set(device.serial.clone()),
            hmac_key: Set(key),
            model: Set(model.to_string()),
            ..Default::default()
        })
        .on_conflict(OnConflict::column(device::Column::Serial).do_nothing().to_owned())
        .exec_without_returning(&txn)
        .await?;
    }
    txn.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "registered": registered, "already_known": body.devices.len() as u64 - registered })),
    ))
}

#[derive(serde::Serialize)]
struct DeviceView {
    id: Uuid,
    serial: String,
    model: String,
    family_id: Option<Uuid>,
    child_id: Option<Uuid>,
    claimed_at: Option<chrono::DateTime<Utc>>,
    firmware_version: Option<String>,
    last_seen_at: Option<chrono::DateTime<Utc>>,
}

impl From<device::Model> for DeviceView {
    fn from(row: device::Model) -> Self {
        Self {
            id: row.id,
            serial: row.serial,
            model: row.model,
            family_id: row.family_id,
            child_id: row.child_id,
            claimed_at: row.claimed_at,
            firmware_version: row.firmware_version,
            last_seen_at: row.last_seen_at,
        }
    }
}

/// A guardian sees their family's devices; the operator sees the latest 200.
pub async fn list(caller: Caller, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows = match caller {
        Caller::Guardian { family_id, .. } => {
            device::Entity::find()
                .filter(device::Column::FamilyId.eq(family_id))
                .order_by_asc(device::Column::ClaimedAt)
                .all(&state.db)
                .await?
        }
        Caller::Operator => {
            device::Entity::find().order_by_desc(device::Column::CreatedAt).limit(200).all(&state.db).await?
        }
    };
    let devices: Vec<DeviceView> = rows.into_iter().map(DeviceView::from).collect();
    Ok(Json(json!({ "devices": devices })))
}

#[derive(Deserialize)]
pub struct NewFirmware {
    model: String,
    /// A semantic version, such as 1.4.0.
    version: String,
    url: String,
    sha256: String,
}

pub async fn publish_firmware(
    _: Operator,
    State(state): State<AppState>,
    Input(body): Input<NewFirmware>,
) -> ApiResult<StatusCode> {
    let version = semver::Version::parse(body.version.trim())
        .map_err(|_| ApiError::bad_request("version must be a semantic version such as 1.4.0"))?;
    let sha256 = body.sha256.trim().to_lowercase();
    let model = body.model.trim();
    if !body.url.starts_with("https://")
        || sha256.len() != 64
        || !sha256.chars().all(|c| c.is_ascii_hexdigit())
        || !(1..=60).contains(&model.len())
    {
        return Err(ApiError::bad_request("firmware needs a model, an https url and a sha256 in hex"));
    }
    let inserted = firmware::Entity::insert(firmware::ActiveModel {
        id: Set(Uuid::now_v7()),
        model: Set(model.to_string()),
        version: Set(version.to_string()),
        major: Set(version.major as i32),
        minor: Set(version.minor as i32),
        patch: Set(version.patch as i32),
        url: Set(body.url.clone()),
        sha256: Set(sha256),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::columns([firmware::Column::Model, firmware::Column::Version]).do_nothing().to_owned(),
    )
    .exec_without_returning(&state.db)
    .await?;
    if inserted == 0 {
        // A published version is never replaced: devices may already run it.
        return Err(ApiError::Conflict("that version is already published for that model"));
    }
    Ok(StatusCode::CREATED)
}

// --- the guardian: claiming and managing a device -------------------------------------

#[derive(Deserialize)]
pub struct ClaimInput {
    code: String,
    #[serde(default)]
    child_id: Option<Uuid>,
}

pub async fn claim(
    guardian: Guardian,
    State(state): State<AppState>,
    Input(body): Input<ClaimInput>,
) -> ApiResult<Json<Value>> {
    let too_many = || ApiError::Forbidden("too many wrong codes; try again in an hour");
    {
        let attempts = state.claim_attempts.lock().expect("lock");
        if attempts
            .get(&guardian.id)
            .is_some_and(|(count, since)| *count >= MAX_WRONG_CODES && since.elapsed().as_secs() < 3600)
        {
            return Err(too_many());
        }
    }
    if let Some(child_id) = body.child_id {
        let caller = Caller::Guardian { id: guardian.id, family_id: guardian.family_id };
        child_for(&state.db, &caller, child_id).await?;
    }
    let code = body.code.trim().to_uppercase();

    let txn = state.db.begin().await?;
    let device_id: Option<Uuid> = device_claim::Entity::update_many()
        .col_expr(device_claim::Column::GuardianId, Expr::value(guardian.id))
        .col_expr(device_claim::Column::ChildId, Expr::value(body.child_id))
        .filter(device_claim::Column::Code.eq(&code))
        .filter(sea_orm::sea_query::ExprTrait::gt(
            Expr::col(device_claim::Column::ExpiresAt),
            Expr::current_timestamp(),
        ))
        .exec_with_returning(&txn)
        .await?
        .into_iter()
        .next()
        .map(|claim| claim.device_id);
    let Some(device_id) = device_id else {
        let mut attempts = state.claim_attempts.lock().expect("lock");
        let entry = attempts.entry(guardian.id).or_insert((0, std::time::Instant::now()));
        if entry.1.elapsed().as_secs() >= 3600 {
            *entry = (0, std::time::Instant::now());
        }
        entry.0 += 1;
        return Err(ApiError::NotFound("a device showing that code"));
    };
    let claimed = complete_if_ready(&txn, device_id).await?;
    txn.commit().await?;
    Ok(Json(
        json!({ "device_id": device_id, "status": if claimed { "claimed" } else { "waiting_for_device" } }),
    ))
}

/// Links the device once both halves are in: a guardian typed its code and
/// the device signed its challenge.
async fn complete_if_ready(db: &impl ConnectionTrait, device_id: Uuid) -> Result<bool, DbErr> {
    let ready = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select device_claims.guardian_id, device_claims.child_id, guardians.family_id
             from device_claims join guardians on guardians.id = device_claims.guardian_id
             where device_claims.device_id = $1 and device_claims.proved_at is not null
               and device_claims.expires_at > now() for update of device_claims",
            [device_id.into()],
        ))
        .await?;
    let Some(ready) = ready else { return Ok(false) };
    let guardian_id: Uuid = ready.try_get("", "guardian_id")?;
    let child_id: Option<Uuid> = ready.try_get("", "child_id")?;
    let family_id: Uuid = ready.try_get("", "family_id")?;

    let linked = device::Entity::update_many()
        .col_expr(device::Column::FamilyId, Expr::value(family_id))
        .col_expr(device::Column::ChildId, Expr::value(child_id))
        .col_expr(device::Column::ClaimedAt, Expr::current_timestamp())
        .filter(device::Column::Id.eq(device_id))
        .exec_with_returning(db)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound("device".into()))?;
    device_claim::Entity::delete_by_id(device_id).exec(db).await?;

    let mut data = json!({
        "device_id": device_id,
        "family_id": family_id,
        "claimed_by": guardian_id,
        "hardware_revision": linked.model,
    });
    if let Some(version) = linked.firmware_version {
        data["firmware_version"] = json!(version);
    }
    events::publish(db, events::DEVICE_CLAIMED, device_id, data).await?;
    Ok(true)
}

async fn device_for(state: &AppState, caller: &Caller, device_id: Uuid) -> ApiResult<()> {
    let family_id: Option<Option<Uuid>> = device::Entity::find_by_id(device_id)
        .select_only()
        .column(device::Column::FamilyId)
        .into_tuple()
        .one(&state.db)
        .await?;
    match (caller, family_id) {
        (Caller::Operator, Some(_)) => Ok(()),
        (Caller::Guardian { .. }, Some(Some(family_id))) if caller.may_access(family_id) => Ok(()),
        _ => Err(ApiError::NotFound("device")),
    }
}

#[derive(Deserialize)]
pub struct AssignInput {
    /// The child who uses the device, or null for nobody.
    child_id: Option<Uuid>,
}

pub async fn assign(
    caller: Caller,
    State(state): State<AppState>,
    Path(device_id): Path<Uuid>,
    Input(body): Input<AssignInput>,
) -> ApiResult<StatusCode> {
    device_for(&state, &caller, device_id).await?;
    if let Some(child_id) = body.child_id {
        let child = child_for(&state.db, &caller, child_id).await?;
        // The child must be in the family the device belongs to.
        let family_id: Option<Option<Uuid>> = device::Entity::find_by_id(device_id)
            .select_only()
            .column(device::Column::FamilyId)
            .into_tuple()
            .one(&state.db)
            .await?;
        let same = family_id.flatten() == Some(child.family_id);
        if !same {
            return Err(ApiError::NotFound("child"));
        }
    }
    device::Entity::update_many()
        .col_expr(device::Column::ChildId, Expr::value(body.child_id))
        .filter(device::Column::Id.eq(device_id))
        .exec(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Unlinks the device from its family. It shows a new code the next time it checks in.
pub async fn release(
    caller: Caller,
    State(state): State<AppState>,
    Path(device_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    device_for(&state, &caller, device_id).await?;
    device::Entity::update_many()
        .col_expr(device::Column::FamilyId, Expr::value(None::<Uuid>))
        .col_expr(device::Column::ChildId, Expr::value(None::<Uuid>))
        .col_expr(device::Column::ClaimedAt, Expr::value(None::<chrono::DateTime<Utc>>))
        .filter(device::Column::Id.eq(device_id))
        .exec(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- the device itself ------------------------------------------------------------------

/// The newest firmware for a model, if it is newer than what the device runs.
/// A version that cannot be read counts as the oldest, and a device is never
/// offered a version older than its own.
async fn newer_firmware(
    state: &AppState,
    model: &str,
    current: &str,
) -> Result<Option<(String, String)>, DbErr> {
    let latest = firmware::Entity::find()
        .filter(firmware::Column::Model.eq(model))
        .order_by_desc(firmware::Column::Major)
        .order_by_desc(firmware::Column::Minor)
        .order_by_desc(firmware::Column::Patch)
        .one(&state.db)
        .await?;
    let current = semver::Version::parse(current).map_or((0, 0, 0), |v| (v.major, v.minor, v.patch));
    Ok(latest
        .filter(|row| (row.major as u64, row.minor as u64, row.patch as u64) > current)
        .map(|row| (row.version, row.url)))
}

fn serial_of(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("Serial-Number")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The device's regular check-in: the time, whether there is newer firmware,
/// and, while it is not linked to a family, the code to show.
pub async fn check_in(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> ApiResult<Json<Value>> {
    let mut answer = json!({
        "server_time": {
            "timestamp": Utc::now().timestamp_millis(),
            "timezone_offset": state.config.timezone_offset_minutes,
        }
    });
    // A device that is not one of ours still gets the time, and nothing else.
    let Some(serial) = serial_of(&headers) else { return Ok(Json(answer)) };
    let current = body
        .as_ref()
        .and_then(|Json(body)| body["application"]["version"].as_str())
        .map(|version| version.trim().chars().take(40).collect::<String>())
        .unwrap_or_default();
    let device = state
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update devices set last_seen_at = now(), firmware_version = coalesce(nullif($2, ''), firmware_version)
             where serial = $1 returning id, model, claimed_at",
            [serial.into(), current.clone().into()],
        ))
        .await?;
    let Some(device) = device else { return Ok(Json(answer)) };
    let device_id: Uuid = device.try_get("", "id")?;
    let model: String = device.try_get("", "model")?;
    let claimed_at: Option<chrono::DateTime<Utc>> = device.try_get("", "claimed_at")?;

    answer["firmware"] = match newer_firmware(&state, &model, &current).await? {
        Some((version, url)) => json!({ "version": version, "url": url }),
        None => json!({ "version": current, "url": "" }),
    };

    if claimed_at.is_none() {
        // The code stays the same while it is valid, so the screen does not
        // change under the person typing it.
        let claim = state
            .db
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "insert into device_claims (device_id, code, challenge, expires_at)
             values ($1, $2, $3, now() + make_interval(mins => $4))
             on conflict (device_id) do update set
               code = case when device_claims.expires_at > now() then device_claims.code else excluded.code end,
               challenge = case when device_claims.expires_at > now() then device_claims.challenge else excluded.challenge end,
               proved_at = case when device_claims.expires_at > now() then device_claims.proved_at end,
               guardian_id = case when device_claims.expires_at > now() then device_claims.guardian_id end,
               child_id = case when device_claims.expires_at > now() then device_claims.child_id end,
               expires_at = case when device_claims.expires_at > now() then device_claims.expires_at else excluded.expires_at end
             returning code, challenge",
                [device_id.into(), random_code().into(), random_challenge().into(), CLAIM_MINUTES.into()],
            ))
            .await?
            .ok_or_else(|| DbErr::RecordNotInserted)?;
        let code: String = claim.try_get("", "code")?;
        let challenge: String = claim.try_get("", "challenge")?;
        answer["activation"] = json!({
            "code": code,
            "message": format!("aule\n{code}"),
            "challenge": challenge,
            "timeout_ms": 30_000,
        });
    }
    Ok(Json(answer))
}

#[derive(Deserialize)]
pub struct ActivateInput {
    serial_number: String,
    challenge: String,
    hmac: String,
}

/// The device signs its challenge. 200 once it is linked to a family, 202
/// while it is still waiting for a guardian to type the code.
pub async fn activate(
    State(state): State<AppState>,
    Input(body): Input<ActivateInput>,
) -> ApiResult<StatusCode> {
    let refused = || ApiError::Forbidden("the device could not be verified");
    let device = device::Entity::find()
        .filter(device::Column::Serial.eq(body.serial_number.trim()))
        .one(&state.db)
        .await?;
    let Some(device) = device else { return Err(refused()) };
    if !signed_by(&device.hmac_key, body.challenge.as_bytes(), &body.hmac) {
        return Err(refused());
    }
    if device.claimed_at.is_some() {
        return Ok(StatusCode::OK);
    }
    let txn = state.db.begin().await?;
    let proved = txn
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update device_claims set proved_at = coalesce(proved_at, now())
             where device_id = $1 and challenge = $2 and expires_at > now()",
            [device.id.into(), body.challenge.clone().into()],
        ))
        .await?;
    if proved.rows_affected() == 0 {
        // Signed correctly, but for a challenge that is no longer the current one.
        return Err(refused());
    }
    let claimed = complete_if_ready(&txn, device.id).await?;
    txn.commit().await?;
    Ok(if claimed { StatusCode::OK } else { StatusCode::ACCEPTED })
}

#[derive(Deserialize)]
pub struct DeviceSessionInput {
    serial_number: String,
    /// Seconds since 1970, from the device's clock (set at check-in).
    timestamp: i64,
    /// HMAC-SHA256 of `session:<serial>:<timestamp>` under the device's key, in hex.
    hmac: String,
}

/// A linked device asks for a session for its child. The request is signed
/// with the device's key and a fresh timestamp, and cannot be replayed.
pub async fn start_session(
    State(state): State<AppState>,
    Input(body): Input<DeviceSessionInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let refused = || ApiError::Forbidden("the device could not be verified");
    let serial = body.serial_number.trim();
    let device = device::Entity::find().filter(device::Column::Serial.eq(serial)).one(&state.db).await?;
    let Some(device::Model { id: device_id, hmac_key: key, child_id, claimed_at, .. }) = device else {
        return Err(refused());
    };
    let message = format!("session:{serial}:{}", body.timestamp);
    if (Utc::now().timestamp() - body.timestamp).abs() > CLOCK_SKEW_SECONDS
        || !signed_by(&key, message.as_bytes(), &body.hmac)
    {
        return Err(refused());
    }
    // Each signed timestamp works once: a copy of this request is useless.
    let fresh = device::Entity::update_many()
        .col_expr(device::Column::LastSignedAt, Expr::value(body.timestamp))
        .col_expr(device::Column::LastSeenAt, Expr::current_timestamp())
        .filter(device::Column::Id.eq(device_id))
        .filter(device::Column::LastSignedAt.lt(body.timestamp))
        .exec(&state.db)
        .await?;
    if fresh.rows_affected == 0 {
        return Err(refused());
    }
    let (Some(_), Some(child_id)) = (claimed_at, child_id) else {
        return Err(ApiError::Conflict("the device is not linked to a child yet"));
    };
    let child = find_child(&state.db, child_id).await?;
    let session =
        sessions::open_session(&state, Some(child), "child", None, Some(device_id), None, false, None)
            .await?;
    Ok((StatusCode::CREATED, Json(session)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_holder_of_the_key_can_sign() {
        // RFC 4231, test case 2.
        let (key, message) = (b"Jefe".as_slice(), b"what do ya want for nothing?".as_slice());
        let signature = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";

        assert!(signed_by(key, message, signature));
        assert!(signed_by(key, message, &signature.to_uppercase()));
        assert!(!signed_by(b"other", message, signature));
        assert!(!signed_by(key, b"another message", signature));
        assert!(!signed_by(key, message, "not hex"));
        assert!(!signed_by(key, message, ""));
    }

    #[test]
    fn a_code_is_easy_to_read_and_type() {
        let code = random_code();
        assert_eq!(code.len(), CODE_LENGTH);
        assert!(code.bytes().all(|c| CODE_ALPHABET.contains(&c)));
        assert!(!CODE_ALPHABET.iter().any(|c| b"01OI".contains(c)));
        assert_ne!(random_challenge(), random_challenge());
    }
}
