//! Who is calling:
//!
//! - an **operator**, with the server's admin token, for running the server;
//! - a **guardian**, signed in with a code sent to their email, who can only
//!   reach their own family;
//! - the **agent**, with a token that was created for one session and is
//!   useless for any other.
//!
//! Devices prove themselves differently, by signing with their key: see
//! `devices`.

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::error::ApiError;
use crate::state::AppState;

pub fn bearer(parts: &Parts) -> Result<&str, ApiError> {
    parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or(ApiError::Unauthorized)
}

pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Compares in constant time, whatever the lengths.
pub fn same_token(given: &str, expected: &str) -> bool {
    Sha256::digest(given.as_bytes()).ct_eq(&Sha256::digest(expected.as_bytes())).into()
}

pub struct Operator;

impl FromRequestParts<AppState> for Operator {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        if same_token(bearer(parts)?, &state.config.admin_token) {
            Ok(Self)
        } else {
            Err(ApiError::Unauthorized)
        }
    }
}

/// Whoever may act on a family's data: the operator on any family, a signed-in
/// guardian on their own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    Operator,
    Guardian { id: Uuid, family_id: Uuid },
}

impl Caller {
    /// Whether this caller may touch the data of `family_id`.
    pub fn may_access(&self, family_id: Uuid) -> bool {
        match self {
            Self::Operator => true,
            Self::Guardian { family_id: own, .. } => *own == family_id,
        }
    }

    pub fn guardian_id(&self) -> Option<Uuid> {
        match self {
            Self::Operator => None,
            Self::Guardian { id, .. } => Some(*id),
        }
    }
}

/// A family's session that is used is renewed once fewer than this many days
/// of its `signin::SESSION_DAYS` are left: a parent who opens the app within a
/// month never needs a new code, and each session is written once a day at most.
const RENEW_UNDER_DAYS: i32 = 29;

impl FromRequestParts<AppState> for Caller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer(parts)?;
        if same_token(token, &state.config.admin_token) {
            return Ok(Self::Operator);
        }
        use sea_orm::ConnectionTrait;
        let hash = token_hash(token);
        // A session of the team's sign-in is told by its length, as
        // `TeamMember` tells it: it keeps the end it was given.
        let found = state
            .db
            .query_one_raw(sea_orm::Statement::from_sql_and_values(
                sea_orm::DbBackend::Postgres,
                "select guardians.id, guardians.family_id,
                        s.expires_at < now() + make_interval(days => $2)
                          and s.expires_at - s.created_at > make_interval(hours => $3) as renew
                 from guardian_sessions s join guardians on guardians.id = s.guardian_id
                 where s.token_hash = $1 and s.expires_at > now()",
                [hash.clone().into(), RENEW_UNDER_DAYS.into(), crate::signin::TEAM_SESSION_HOURS.into()],
            ))
            .await?;
        let Some(found) = found else { return Err(ApiError::Unauthorized) };
        if found.try_get::<bool>("", "renew")? {
            // The same conditions again: of two requests at once, the second
            // finds the session renewed and writes nothing.
            state
                .db
                .execute_raw(sea_orm::Statement::from_sql_and_values(
                    sea_orm::DbBackend::Postgres,
                    "update guardian_sessions set expires_at = now() + make_interval(days => $2)
                     where token_hash = $1 and expires_at > now()
                       and expires_at < now() + make_interval(days => $3)
                       and expires_at - created_at > make_interval(hours => $4)",
                    [
                        hash.into(),
                        crate::signin::SESSION_DAYS.into(),
                        RENEW_UNDER_DAYS.into(),
                        crate::signin::TEAM_SESSION_HOURS.into(),
                    ],
                ))
                .await?;
        }
        Ok(Self::Guardian { id: found.try_get("", "id")?, family_id: found.try_get("", "family_id")? })
    }
}

/// Someone on Aule's team: the operator's token, or a signed-in guardian whose
/// address is one of the team's (the team's console signs them in with codes
/// of their own, `signin::team_start`).
pub struct Staff {
    /// The team member's address; none for the operator's token.
    pub email: Option<String>,
}

impl FromRequestParts<AppState> for Staff {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        use sea_orm::{EntityTrait, QuerySelect};
        let id = match Caller::from_request_parts(parts, state).await? {
            Caller::Operator => return Ok(Self { email: None }),
            Caller::Guardian { id, .. } => id,
        };
        let email: Option<String> = crate::entity::guardian::Entity::find_by_id(id)
            .select_only()
            .column(crate::entity::guardian::Column::Email)
            .into_tuple()
            .one(&state.db)
            .await?;
        match email {
            Some(email) if state.config.admin_emails.contains(&email) => Ok(Self { email: Some(email) }),
            _ => Err(ApiError::Forbidden("this route is for Aule's team")),
        }
    }
}

/// A team member acting on their own account, with a session the team's
/// sign-in opened: never the operator's token, nor a family-length session,
/// even a team member's own from the playground. The passkey routes take it.
pub struct TeamMember {
    pub guardian_id: Uuid,
    pub email: String,
    /// The session's token hash, which a passkey being added is bound to.
    pub token_hash: String,
    /// Whether the session was opened in the last
    /// `passkeys::RECENT_SIGN_IN_MINUTES`, by the database's clock.
    pub recent: bool,
}

impl FromRequestParts<AppState> for TeamMember {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        const NOT_TEAM: ApiError = ApiError::Forbidden("this route is for Aule's team");
        let token = bearer(parts)?;
        if same_token(token, &state.config.admin_token) {
            return Err(NOT_TEAM);
        }
        use sea_orm::ConnectionTrait;
        let hash = token_hash(token);
        // Only the team's sign-in opens a session of TEAM_SESSION_HOURS; a
        // family's lasts days.
        let found = state
            .db
            .query_one_raw(sea_orm::Statement::from_sql_and_values(
                sea_orm::DbBackend::Postgres,
                "select g.id, g.email::text as email,
                        s.expires_at - s.created_at <= make_interval(hours => $2) as team_session,
                        s.created_at > now() - make_interval(mins => $3) as recent
                 from guardian_sessions s join guardians g on g.id = s.guardian_id
                 where s.token_hash = $1 and s.expires_at > now()",
                [
                    hash.clone().into(),
                    crate::signin::TEAM_SESSION_HOURS.into(),
                    crate::passkeys::RECENT_SIGN_IN_MINUTES.into(),
                ],
            ))
            .await?;
        let Some(found) = found else { return Err(ApiError::Unauthorized) };
        let email: String = found.try_get("", "email")?;
        if !found.try_get::<bool>("", "team_session")? || !state.config.admin_emails.contains(&email) {
            return Err(NOT_TEAM);
        }
        Ok(Self {
            guardian_id: found.try_get("", "id")?,
            email,
            token_hash: hash,
            recent: found.try_get("", "recent")?,
        })
    }
}

/// A signed-in guardian, for the routes that only make sense for one.
pub struct Guardian {
    pub id: Uuid,
    pub family_id: Uuid,
}

impl FromRequestParts<AppState> for Guardian {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        match Caller::from_request_parts(parts, state).await? {
            Caller::Guardian { id, family_id } => Ok(Self { id, family_id }),
            Caller::Operator => Err(ApiError::Forbidden("this route is for a signed-in guardian")),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Session {
    pub id: Uuid,
    pub child_id: Option<Uuid>,
    pub audience: String,
    pub room: String,
    pub language: String,
    pub status: String,
    pub keep_transcript: bool,
    pub use_memory: bool,
    pub created_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    /// Whether the session engine runs the session; see `engine`.
    pub engine: bool,
}

impl From<crate::entity::session::Model> for Session {
    fn from(row: crate::entity::session::Model) -> Self {
        Self {
            id: row.id,
            child_id: row.child_id,
            audience: row.audience,
            room: row.room,
            language: row.language,
            status: row.status,
            keep_transcript: row.keep_transcript,
            use_memory: row.use_memory,
            created_at: row.created_at,
            ended_at: row.ended_at,
            engine: row.engine,
        }
    }
}

/// How long after it was created a session's token still works.
pub const SESSION_TOKEN_HOURS: i32 = 3;

/// The agent, acting for the one session its token belongs to.
pub struct Agent(pub Session);

impl FromRequestParts<AppState> for Agent {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let hash = token_hash(bearer(parts)?);
        use sea_orm::sea_query::{Expr, ExprTrait};
        use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
        let session = crate::entity::session::Entity::find()
            .filter(crate::entity::session::Column::AgentTokenHash.eq(hash))
            .filter(
                Expr::col(crate::entity::session::Column::CreatedAt)
                    .gt(Expr::cust(format!("now() - interval '{SESSION_TOKEN_HOURS} hours'"))),
            )
            .one(&state.db)
            .await?;
        session.map(|row| Self(row.into())).ok_or(ApiError::Unauthorized)
    }
}

/// A JSON body, with a malformed one answered in the API's own error shape.
pub struct Input<T>(pub T);

impl<T: DeserializeOwned> FromRequest<AppState> for Input<T> {
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(request, state).await {
            Ok(axum::Json(value)) => Ok(Self(value)),
            Err(rejection @ (JsonRejection::JsonDataError(_) | JsonRejection::JsonSyntaxError(_))) => {
                Err(ApiError::BadRequest(rejection.body_text()))
            }
            Err(_) => Err(ApiError::bad_request("the body must be JSON with Content-Type: application/json")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_token_matches() {
        assert!(same_token("a-long-enough-token", "a-long-enough-token"));
        assert!(!same_token("a-long-enough-toke", "a-long-enough-token"));
        assert!(!same_token("", "a-long-enough-token"));
    }

    #[test]
    fn a_token_is_stored_as_its_hash() {
        assert_eq!(token_hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
