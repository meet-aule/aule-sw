//! A signed capability that can only turn off one guardian's email notices.
//! It cannot sign in, read family data, or change anyone else's preferences.

use axum::{Json, extract::State, http::StatusCode};
use chrono::Utc;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, sea_query::Expr};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    devices::signed_by,
    entity::guardian,
    error::{ApiError, ApiResult},
    events,
    state::AppState,
};

const LIFETIME: i64 = 90 * 24 * 60 * 60;
const PURPOSE: &str = "aule:email-notices:unsubscribe:v1:";

pub fn token(secret: &str, guardian: Uuid, language: &str, now: i64) -> String {
    let language = if language == "en" { "en" } else { "es" };
    let payload = format!("{}.{}.{language}", guardian.simple(), now + LIFETIME);
    let signature = events::signature(secret, format!("{PURPOSE}{payload}").as_bytes());
    format!("{payload}.{}", signature.trim_start_matches("sha256="))
}

fn recipient(secret: &str, token: &str, now: i64) -> Option<Uuid> {
    if token.len() > 160 {
        return None;
    }
    let (payload, signature) = token.rsplit_once('.')?;
    if !signed_by(secret.as_bytes(), format!("{PURPOSE}{payload}").as_bytes(), signature) {
        return None;
    }
    let mut parts = payload.split('.');
    let guardian = parts.next()?.parse().ok()?;
    let expires: i64 = parts.next()?.parse().ok()?;
    if !matches!(parts.next(), Some("es" | "en"))
        || parts.next().is_some()
        || expires <= now
        || expires > now + LIFETIME
    {
        return None;
    }
    Some(guardian)
}

#[derive(Deserialize)]
pub struct Input {
    token: String,
}

pub async fn unsubscribe(State(state): State<AppState>, Json(body): Json<Input>) -> ApiResult<StatusCode> {
    let id = recipient(&state.config.admin_token, &body.token, Utc::now().timestamp())
        .ok_or_else(|| ApiError::bad_request("the unsubscribe link is invalid or expired"))?;
    guardian::Entity::update_many()
        .col_expr(guardian::Column::NoticesByEmail, Expr::value(false))
        .filter(guardian::Column::Id.eq(id))
        .exec(&state.db)
        .await?;
    // Already opted out or erased: no account information is revealed.
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capability_is_scoped_signed_and_expires() {
        let id = Uuid::new_v4();
        let now = 1_800_000_000;
        let signed = token("test-key", id, "en", now);
        assert_eq!(recipient("test-key", &signed, now), Some(id));
        assert_eq!(recipient("other-key", &signed, now), None);
        assert_eq!(recipient("test-key", &signed, now + LIFETIME), None);
        assert_eq!(recipient("test-key", &signed, now - 1), None);
        assert_eq!(recipient("test-key", &signed.replace(".en.", ".es."), now), None);
        let other = signed.replacen(&id.simple().to_string(), &Uuid::new_v4().simple().to_string(), 1);
        assert_eq!(recipient("test-key", &other, now), None);
        let payload = format!("{}.{}.en", id.simple(), now + LIFETIME);
        let wrong_purpose = format!("{payload}.{}", events::signature("test-key", payload.as_bytes()));
        assert_eq!(recipient("test-key", &wrong_purpose, now), None);
    }
}
