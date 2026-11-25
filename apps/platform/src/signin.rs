//! Sign-in for guardians, without passwords: a code sent to their email, or
//! their Google, GitHub, Meta or Apple account where the installation has set
//! that up.
//!
//! Asking for a code answers the same way whether or not the address has an
//! account, a code works once and for ten minutes, a few wrong guesses burn
//! it, and an address only gets a few codes an hour. A new address becomes a
//! new family when its first code is confirmed, and keeps the link it came
//! from when the page passes one on.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::request::Parts;
use rand::{Rng, RngExt};
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Statement, TransactionTrait,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::auth::{Guardian, Input, bearer, token_hash};
use crate::entity::{child, device, family, guardian, guardian_session, login_code, notice};
use crate::error::{ApiError, ApiResult};
use crate::google::{Identity, IdentityError};
use crate::oauth::CodeProvider;
use crate::state::AppState;

const CODE_MINUTES: i32 = 10;
const MAX_ATTEMPTS: i32 = 5;
const MAX_CODES_PER_HOUR: i32 = 5;
const SESSION_DAYS: i32 = 30;
const MAX_SOURCE_CHARS: usize = 24;

pub fn normalized_email(email: &str) -> ApiResult<String> {
    let email = email.trim().to_lowercase();
    let mut parts = email.split('@');
    let valid = matches!((parts.next(), parts.next(), parts.next()), (Some(local), Some(domain), None)
        if !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.'));
    if !valid || email.len() > 254 || email.chars().any(char::is_whitespace) {
        return Err(ApiError::bad_request("email is not an email address"));
    }
    Ok(email)
}

/// The link a new family came from, when it is one: a short code of lower-case
/// letters, digits and hyphens that starts with a letter, like `cesar` or
/// `colegio-2`. Anything else is dropped, never refused: a sign-in does not
/// fail over the address it was reached from.
pub fn source_code(source: Option<&str>) -> Option<String> {
    let source = source?;
    let valid = source.len() <= MAX_SOURCE_CHARS
        && source.starts_with(|c: char| c.is_ascii_lowercase())
        && source.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    valid.then(|| source.to_string())
}

/// The code is short, so its hash is tied to the address it was sent to.
fn code_hash(email: &str, code: &str) -> String {
    hex::encode(Sha256::digest(format!("{email}:{code}").as_bytes()))
}

fn texts(language: &str, code: &str) -> (String, String) {
    match language {
        "en" => (
            format!("{code} is your Aule code"),
            format!(
                "Your code to sign in to Aule is {code}.\n\nIt works for {CODE_MINUTES} minutes. If you did not ask for it, you can ignore this message."
            ),
        ),
        _ => (
            format!("{code} es tu código de Aule"),
            format!(
                "Tu código para entrar a Aule es {code}.\n\nVale por {CODE_MINUTES} minutos. Si no lo pediste, puedes ignorar este mensaje."
            ),
        ),
    }
}

#[derive(Deserialize)]
pub struct StartInput {
    email: String,
    #[serde(default)]
    language: Option<String>,
}

pub async fn start(State(state): State<AppState>, Input(body): Input<StartInput>) -> ApiResult<StatusCode> {
    let email = normalized_email(&body.email)?;
    let mailer = state.mailer.as_ref().ok_or(ApiError::Unavailable("sign-in needs mail to be configured"))?;
    let code = format!("{:06}", rand::rng().random_range(0..1_000_000));

    // One statement decides whether this address may get another code now.
    let allowed = state
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "insert into login_codes (email, code_hash, expires_at)
         values ($1, $2, now() + make_interval(mins => $3))
         on conflict (email) do update set
           code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
           sent_count = case when login_codes.window_started_at < now() - interval '1 hour'
                             then 1 else login_codes.sent_count + 1 end,
           window_started_at = case when login_codes.window_started_at < now() - interval '1 hour'
                                    then now() else login_codes.window_started_at end
         where login_codes.window_started_at < now() - interval '1 hour' or login_codes.sent_count < $4
         returning sent_count",
            [
                email.clone().into(),
                code_hash(&email, &code).into(),
                CODE_MINUTES.into(),
                MAX_CODES_PER_HOUR.into(),
            ],
        ))
        .await?;

    if allowed.is_some() {
        let language = body.language.as_deref().unwrap_or("es");
        let (subject, text) = texts(language, &code);
        if let Err(error) = mailer.send(&email, &subject, &text).await {
            tracing::error!(%error, "a sign-in code could not be sent");
            return Err(ApiError::Unavailable("the code could not be sent; try again later"));
        }
    }
    // The same answer whether a code was sent, the limit was reached, or the
    // address is new.
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct VerifyInput {
    email: String,
    code: String,
    /// Needed the first time an address signs in: the guardian's name.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    language: Option<String>,
    /// The link a new family came from (`source_code`); kept only when the
    /// address is new.
    #[serde(default)]
    source: Option<String>,
}

pub async fn verify(
    State(state): State<AppState>,
    Input(body): Input<VerifyInput>,
) -> ApiResult<Json<Value>> {
    let email = normalized_email(&body.email)?;
    let wrong = || ApiError::Forbidden("that code is wrong or has expired");

    let txn = state.db.begin().await?;
    let pending = login_code::Entity::find_by_id(email.clone())
        .filter(Expr::col(login_code::Column::ExpiresAt).gt(Expr::current_timestamp()))
        .lock_exclusive()
        .one(&txn)
        .await?;
    let Some(pending) = pending else { return Err(wrong()) };
    if pending.attempts >= MAX_ATTEMPTS {
        return Err(wrong());
    }
    let given = code_hash(&email, body.code.trim());
    if !bool::from(given.as_bytes().ct_eq(pending.code_hash.as_bytes())) {
        login_code::Entity::update_many()
            .col_expr(login_code::Column::Attempts, Expr::col(login_code::Column::Attempts).add(1))
            .filter(login_code::Column::Email.eq(&email))
            .exec(&txn)
            .await?;
        txn.commit().await?;
        return Err(wrong());
    }

    let account =
        enter(&txn, &email, body.name.as_deref(), body.language.as_deref(), body.source.as_deref()).await?;
    login_code::Entity::delete_by_id(email.clone()).exec(&txn).await?;
    txn.commit().await?;
    Ok(Json(account))
}

/// Opens a session for an address that has just been proven, by a code or by
/// Google. An address seen for the first time becomes a new family, and for
/// that it needs the guardian's name; the family keeps the link it came from.
async fn enter(
    db: &impl ConnectionTrait,
    email: &str,
    name: Option<&str>,
    language: Option<&str>,
    source: Option<&str>,
) -> ApiResult<Value> {
    let existing: Option<(Uuid, Uuid)> = guardian::Entity::find()
        .filter(guardian::Column::Email.eq(email))
        .select_only()
        .column(guardian::Column::Id)
        .column(guardian::Column::FamilyId)
        .into_tuple()
        .one(db)
        .await?;
    let (guardian_id, family_id, new_account) = match existing {
        Some((guardian_id, family_id)) => (guardian_id, family_id, false),
        None => {
            let name = name.map(str::trim).filter(|name| !name.is_empty() && name.chars().count() <= 120);
            let Some(name) = name else {
                return Err(ApiError::bad_request("name is needed to create the account"));
            };
            let language = language.filter(|language| ["es", "en"].contains(language)).unwrap_or("es");
            let (family_id, guardian_id) = (Uuid::now_v7(), Uuid::now_v7());
            family::Entity::insert(family::ActiveModel {
                id: Set(family_id),
                name: Set(name.to_string()),
                source: Set(source_code(source)),
                ..Default::default()
            })
            .exec_without_returning(db)
            .await?;
            guardian::Entity::insert(guardian::ActiveModel {
                id: Set(guardian_id),
                family_id: Set(family_id),
                email: Set(email.to_string()),
                name: Set(name.to_string()),
                language: Set(language.to_string()),
                ..Default::default()
            })
            .exec_without_returning(db)
            .await?;
            (guardian_id, family_id, true)
        }
    };

    let mut secret = [0u8; 32];
    rand::rng().fill_bytes(&mut secret);
    let token = hex::encode(secret);
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "insert into guardian_sessions (token_hash, guardian_id, expires_at)
         values ($1, $2, now() + make_interval(days => $3))",
        [token_hash(&token).into(), guardian_id.into(), SESSION_DAYS.into()],
    ))
    .await?;

    Ok(json!({
        "token": token,
        "guardian_id": guardian_id,
        "family_id": family_id,
        "new_account": new_account,
        "expires_in_days": SESSION_DAYS,
    }))
}

const NO_GOOGLE: ApiError = ApiError::Unavailable("sign-in with Google is not set up here");

/// The client an app must ask Google to issue credentials for. It is not a
/// secret: it is part of every sign-in page.
pub async fn google_client(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let client_id = state.config.google_client_id.as_deref().ok_or(NO_GOOGLE)?;
    Ok(Json(json!({ "client_id": client_id })))
}

#[derive(Deserialize)]
pub struct GoogleInput {
    /// The ID token Google gave the app.
    credential: String,
    /// Used instead of the name in the Google account, for a new address.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    language: Option<String>,
    /// The link a new family came from, as for a code.
    #[serde(default)]
    source: Option<String>,
}

pub async fn google(
    State(state): State<AppState>,
    Input(body): Input<GoogleInput>,
) -> ApiResult<Json<Value>> {
    let provider = state.google.as_ref().ok_or(NO_GOOGLE)?;
    if body.credential.len() > 4096 {
        return Err(ApiError::bad_request("credential is not a Google ID token"));
    }
    let identity = provider.identify(&body.credential).await.map_err(|error| match error {
        IdentityError::Refused(reason) => {
            tracing::info!(%reason, "a Google sign-in was refused");
            ApiError::Forbidden("that Google sign-in could not be confirmed")
        }
        IdentityError::Unreachable(reason) => {
            tracing::error!(%reason, "Google could not be asked about a sign-in");
            ApiError::Unavailable("Google could not be reached; try again later")
        }
    })?;
    entered(&state, identity, body.name.as_deref(), body.language.as_deref(), body.source.as_deref()).await
}

/// A session for someone a provider has vouched for.
async fn entered(
    state: &AppState,
    identity: Identity,
    name: Option<&str>,
    language: Option<&str>,
    source: Option<&str>,
) -> ApiResult<Json<Value>> {
    let email = normalized_email(&identity.email)?;
    let name = name.map(str::trim).filter(|name| !name.is_empty()).or(identity.name.as_deref());

    let txn = state.db.begin().await?;
    let account = enter(&txn, &email, name, language, source).await?;
    txn.commit().await?;
    Ok(Json(account))
}

/// The public ids the page needs to send someone to each provider; a provider
/// that is not set up here is null. `email` says whether a code can be emailed.
pub async fn providers(State(state): State<AppState>) -> Json<Value> {
    let id = |provider: &Option<std::sync::Arc<dyn CodeProvider>>| {
        provider.as_ref().map(|provider| provider.client_id().to_string())
    };
    Json(json!({
        "google": state.config.google_client_id,
        "github": id(&state.github),
        "meta": id(&state.meta),
        "apple": id(&state.apple),
        "email": state.mailer.is_some(),
    }))
}

#[derive(Deserialize)]
pub struct CodeInput {
    /// The one-time code the provider sent back to the page.
    code: String,
    /// Where the page asked the provider to send it; the provider checks it.
    redirect_uri: String,
    /// Used instead of the name in the account, for a new address. Apple gives
    /// the name only to the page, and only the first time.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    language: Option<String>,
    /// The link a new family came from, as for a code.
    #[serde(default)]
    source: Option<String>,
}

pub async fn github(State(state): State<AppState>, Input(body): Input<CodeInput>) -> ApiResult<Json<Value>> {
    let provider = state.github.clone();
    by_code(&state, provider.as_deref(), "github", body).await
}

pub async fn meta(State(state): State<AppState>, Input(body): Input<CodeInput>) -> ApiResult<Json<Value>> {
    let provider = state.meta.clone();
    by_code(&state, provider.as_deref(), "meta", body).await
}

pub async fn apple(State(state): State<AppState>, Input(body): Input<CodeInput>) -> ApiResult<Json<Value>> {
    let provider = state.apple.clone();
    by_code(&state, provider.as_deref(), "apple", body).await
}

async fn by_code(
    state: &AppState,
    provider: Option<&dyn CodeProvider>,
    label: &'static str,
    body: CodeInput,
) -> ApiResult<Json<Value>> {
    let provider = provider.ok_or(ApiError::Unavailable("sign-in with that provider is not set up here"))?;
    if body.code.is_empty() || body.code.len() > 2048 {
        return Err(ApiError::bad_request("code is not a sign-in code"));
    }
    let redirect = &body.redirect_uri;
    if redirect.len() > 512 || !(redirect.starts_with("https://") || redirect.starts_with("http://127.0.0.1"))
    {
        return Err(ApiError::bad_request("redirect_uri must be an https:// URL"));
    }
    let identity = provider.identify(&body.code, redirect).await.map_err(|error| match error {
        IdentityError::Refused(reason) => {
            tracing::info!(provider = label, %reason, "a sign-in was refused");
            ApiError::Forbidden("that sign-in could not be confirmed")
        }
        IdentityError::Unreachable(reason) => {
            tracing::error!(provider = label, %reason, "a sign-in provider could not be asked");
            ApiError::Unavailable("the sign-in provider could not be reached; try again later")
        }
    })?;
    // Apple gives the name only the first time, and a person may not share it:
    // a new family is then named after the address, and can rename itself.
    let local = identity.email.split('@').next().unwrap_or_default().to_string();
    let name =
        body.name.filter(|name| !name.trim().is_empty()).or_else(|| identity.name.is_none().then_some(local));
    entered(state, identity, name.as_deref(), body.language.as_deref(), body.source.as_deref()).await
}

/// Ends the session this request was made with.
pub async fn sign_out(_: Guardian, State(state): State<AppState>, parts: Parts) -> ApiResult<StatusCode> {
    guardian_session::Entity::delete_by_id(token_hash(bearer(&parts)?)).exec(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(guardian: Guardian, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let me = guardian::Entity::find_by_id(guardian.id).one(&state.db).await?.ok_or(ApiError::Unauthorized)?;
    let (email, name, language, notices_by_email, notices_by_push) =
        (me.email, me.name, me.language, me.notices_by_email, me.notices_by_push);
    let children: Vec<(Uuid, String)> = child::Entity::find()
        .filter(child::Column::FamilyId.eq(guardian.family_id))
        .order_by_asc(child::Column::CreatedAt)
        .select_only()
        .column(child::Column::Id)
        .column(child::Column::Nickname)
        .into_tuple()
        .all(&state.db)
        .await?;
    let unread = notice::Entity::find()
        .filter(notice::Column::FamilyId.eq(guardian.family_id))
        .filter(notice::Column::ReadAt.is_null())
        .count(&state.db)
        .await?;
    Ok(Json(json!({
        "guardian": { "id": guardian.id, "email": email, "name": name, "language": language, "notices_by_email": notices_by_email, "notices_by_push": notices_by_push },
        "family_id": guardian.family_id,
        "children": children.into_iter().map(|(id, nickname)| json!({ "id": id, "nickname": nickname })).collect::<Vec<_>>(),
        "unread_notices": unread,
        // What a family can ask to reinforce: the page offers exactly these.
        "subjects": crate::families::SUBJECTS,
    })))
}

#[derive(Deserialize)]
pub struct SettingsInput {
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    notices_by_email: Option<bool>,
    #[serde(default)]
    notices_by_push: Option<bool>,
}

pub async fn update_me(
    guardian: Guardian,
    State(state): State<AppState>,
    Input(body): Input<SettingsInput>,
) -> ApiResult<StatusCode> {
    if body.language.as_deref().is_some_and(|language| !["es", "en"].contains(&language)) {
        return Err(ApiError::bad_request("language must be es or en"));
    }
    // Left out, a setting keeps its value.
    let mut update = guardian::Entity::update_many().filter(guardian::Column::Id.eq(guardian.id));
    let mut changed = false;
    if let Some(language) = body.language {
        update = update.col_expr(guardian::Column::Language, Expr::value(language));
        changed = true;
    }
    if let Some(by_email) = body.notices_by_email {
        update = update.col_expr(guardian::Column::NoticesByEmail, Expr::value(by_email));
        changed = true;
    }
    if let Some(by_push) = body.notices_by_push {
        update = update.col_expr(guardian::Column::NoticesByPush, Expr::value(by_push));
        changed = true;
    }
    if changed {
        update.exec(&state.db).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct EraseInput {
    /// The guardian's own email, typed again, so this cannot happen by accident.
    confirm_email: String,
}

/// Erases the family: its guardians, children and everything derived from
/// them. Devices go back to unclaimed. The consent records stay as proof.
pub async fn erase_family(
    guardian: Guardian,
    State(state): State<AppState>,
    Input(body): Input<EraseInput>,
) -> ApiResult<StatusCode> {
    let email =
        guardian::Entity::find_by_id(guardian.id).one(&state.db).await?.ok_or(ApiError::Unauthorized)?.email;
    if normalized_email(&body.confirm_email)? != email {
        return Err(ApiError::bad_request("confirm_email must be the address you signed in with"));
    }
    let txn = state.db.begin().await?;
    device::Entity::update_many()
        .col_expr(device::Column::ClaimedAt, Expr::value(None::<chrono::DateTime<chrono::Utc>>))
        .filter(device::Column::FamilyId.eq(guardian.family_id))
        .exec(&txn)
        .await?;
    family::Entity::delete_by_id(guardian.family_id).exec(&txn).await?;
    txn.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_normalized_and_checked() {
        assert_eq!(normalized_email("  Ana@Example.ORG ").unwrap(), "ana@example.org");
        for bad in [
            "",
            "ana",
            "ana@",
            "@example.org",
            "ana@example",
            "a b@example.org",
            "a@b@example.org",
            "ana@.org",
        ] {
            assert!(normalized_email(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_a_short_lower_case_code_is_kept_as_the_link_a_family_came_from() {
        for good in ["cesar", "pucp", "colegio-2", "a", "wsp-padres-1", "abcdefghijklmnopqrstuvwx"] {
            assert_eq!(source_code(Some(good)).as_deref(), Some(good), "{good}");
        }
        for bad in [
            "",
            "Cesar",
            "CESAR",
            "2cesar",
            "-cesar",
            "ce sar",
            "ce_sar",
            "césar",
            "cesar/../x",
            "<b>cesar</b>",
            "abcdefghijklmnopqrstuvwxy",
        ] {
            assert_eq!(source_code(Some(bad)), None, "{bad}");
        }
        assert_eq!(source_code(None), None);
    }

    #[test]
    fn a_code_only_matches_for_the_address_it_was_sent_to() {
        assert_eq!(code_hash("a@example.org", "123456"), code_hash("a@example.org", "123456"));
        assert_ne!(code_hash("a@example.org", "123456"), code_hash("b@example.org", "123456"));
    }

    #[test]
    fn the_message_is_in_the_guardians_language() {
        assert!(texts("en", "123456").0.starts_with("123456 is your"));
        assert!(texts("es", "123456").1.contains("123456"));
        assert!(texts("fr", "1").0.contains("código"));
    }
}
